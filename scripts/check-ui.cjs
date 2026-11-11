// Runs the real renderer with isolated fixtures in a disposable headless browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'preview-workspace.cjs')]);
const profile = fs.mkdtempSync('/tmp/termlume-ui-regression-');
const browser = spawn(process.env.TERMLUME_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`
], { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let index = 0, buffer = Buffer.alloc(0), stderr = '';
const pending = new Map();
browser.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
browser.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
browser.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error(`Browser exited: ${stderr}`)); });
function request(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++index; pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
  });
}
browser.stdio[4].on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.includes(0)) {
    const at = buffer.indexOf(0); const message = JSON.parse(buffer.subarray(0, at)); buffer = buffer.subarray(at + 1);
    const waiter = pending.get(message.id); if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  }
});
const deadline = setTimeout(() => { console.error('UI checks timed out.', stderr); browser.kill(); process.exitCode = 1; }, 45000);
async function main() {
  const { targetId } = await request('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true });
  const run = (method, params) => request(method, params, sessionId);
  const js = async expression => {
    const result = await run('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception.description);
    return result.result.value;
  };
  const wait = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const tick = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const overflow = async () => {
    const failures = await js(`({page:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&b.clientWidth&&(b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1)).map(b=>b.getAttribute('aria-label')||b.textContent)})`);
    assert.deepEqual(failures, { page: false, buttons: [] });
  };
  const shot = async name => {
    const { data } = await run('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'dist/ux-review', name), Buffer.from(data, 'base64'));
  };
  const drag = async (selector, dx, dy) => {
    const { x, y } = await js(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await run('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, buttons: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    await tick();
  };
  const windowChrome = async pane => {
    assert(await js(`(() => {
      const bar = document.querySelector('.titlebar');
      return !bar.closest('[inert]') && document.elementFromPoint(innerWidth / 2, 6).closest('.titlebar') &&
        $('workspace').inert && !document.querySelector(${JSON.stringify(pane)}).inert;
    })()`), 'An open overlay must leave the title bar available and block the workspace');
    const before = await js("previewCalls.filter(([type]) => type.startsWith('window-')).length");
    const x = await js('innerWidth / 2');
    await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 6 });
    await run('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 6, button: 'left', buttons: 1, clickCount: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 12, y: 6, buttons: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 12, y: 6, button: 'left', clickCount: 1 });
    await run('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 6, button: 'left', buttons: 1, clickCount: 2 });
    await run('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: 6, button: 'left', clickCount: 2 });
    assert.deepEqual(await js(`previewCalls.filter(([type]) => type.startsWith('window-')).slice(${before}).map(([type]) => type)`),
      ['window-drag', 'window-maximize'], 'Dragging and double-clicking the title bar should reach native window controls');
    await js(`(() => {
      const pane = document.querySelector(${JSON.stringify(pane)});
      const controls = [...pane.querySelectorAll('button, input, select, textarea, [tabindex]')]
        .filter(control => control.tabIndex >= 0 && !control.disabled && !control.closest('[inert]') && control.getClientRects().length);
      controls.at(-1).focus();
    })()`);
    await run('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await run('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert(await js(`document.querySelector(${JSON.stringify(pane)}).contains(document.activeElement)`),
      'Keyboard focus must stay inside the active overlay');
  };
  await run('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  for (const [width, height] of [[1140, 740], [550, 490]]) {
    await run('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await run('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/ux-review/workspace.html')).href });
    await wait("document.getElementById('smoke-results')");
    const report = await js("document.getElementById('smoke-results').textContent");
    assert.match(report, /^✓/, report);
    console.log(`${width}×${height}: ${report.split('（')[0]}`);
    await js("document.getElementById('smoke-results').hidden=true");
    for (const theme of ['dark', 'light']) {
      await js(`uiPreferences.theme='${theme}';applyPreferences();selectTab(undefined,'hosts')`); await tick();
      await overflow();
      for (const selector of ['.host-quick-edit','.host-edit:last-child']) {
        await run('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:0});
        await js('document.activeElement.blur()');
        await new Promise(resolve=>setTimeout(resolve,140));
        const before=await js(`(()=>{const b=document.querySelector('${selector}');const s=getComputedStyle(b);return [s.backgroundColor,s.borderColor,s.color]})()`);
        const rect=await js(`(()=>{const b=document.querySelector('${selector}');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await run('Input.dispatchMouseEvent', {type:'mouseMoved',...rect});
        await new Promise(resolve=>setTimeout(resolve,140));
        const after=await js(`(()=>{const s=getComputedStyle(document.querySelector('${selector}'));return [s.backgroundColor,s.borderColor,s.color]})()`);
        assert.notDeepEqual(after,before, `${selector} must highlight on hover`);
        await shot(`host-${selector.includes('quick')?'edit':'more'}-hover-${theme}-${width}.png`);
      }
      await js("document.querySelector('.host-edit:last-child').click()"); await tick(); await overflow();
      await shot(`hosts-menu-${theme}-${width}.png`);
      await js("closeHostMenu();document.querySelector('.host-quick-edit').click()");
      await wait("document.querySelector('dialog[open] .host-form-section')");
      await wait("!dialog.getAnimations().some(a=>a.playState==='running')"); await overflow();
      await windowChrome('#dialog');
      await shot(`host-editor-${theme}-${width}.png`);
      await js("dialog.querySelector('[aria-label=\"连接路径\"]').scrollIntoView({block:'center'})");
      await tick();
      await js("dialog.querySelector('[aria-label=\"连接路径\"]').click()");
      await tick(); await overflow(); await shot(`jump-search-${theme}-${width}.png`);
      await js('closeDropdown()');
      await js('dialog.close()'); await tick();
      await js("document.querySelector('.host-open[data-host-id=\"key-host\"]').parentElement.querySelector('.host-quick-edit').click()");
      await wait("document.querySelector('dialog[open] .host-key-selection')");
      await wait("!dialog.getAnimations().some(a=>a.playState==='running')");
      await js("document.querySelector('.host-key-selection').scrollIntoView({block:'center'})");
      await tick(); await overflow(); await shot(`host-key-${theme}-${width}.png`);
      await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='选择私钥').click()");
      await wait("document.querySelector('#key-dialog[open] [role=radio]')"); await overflow();
      await windowChrome('#key-dialog');
      await shot(`key-picker-${theme}-${width}.png`);
      await js("[...document.querySelectorAll('#key-dialog .actions button')].find(b=>b.textContent==='关闭').click();dialog.close()"); await tick();
      for (const page of ['keys','transfers']) {
        await js(`selectTab(undefined,'${page}')`); await tick(); await overflow();
      }
      await js("openSettings('security')"); await tick(); await overflow();
      await shot(`security-off-${theme}-${width}.png`);
      await js("applyVaultState(previewProtected)"); await tick(); await overflow();
      await shot(`security-on-${theme}-${width}.png`);
      await js("api.vault.state().then(applyVaultState)");
      for (const section of ['preferences','groups','identities','snippets','layouts','logs','trust']) {
        await js(`openSettings('${section}')`);
        await wait("document.querySelector('#settings-page .settings-form')"); await tick(); await overflow();
      }
      await js("openSettings('preferences')"); await wait("document.querySelector('#settings-page .settings-form')");
      await shot(`settings-${theme}-${width}.png`);
      const selectionOrigin = await js('active?.id');
      await js('addNewTab()'); await tick(); await overflow();
      await shot(`quick-connect-filters-${theme}-${width}.png`);
      await js('removeTab(active); selectTab([...tabs.values()].find(tab=>tab.kind===\'shell\'))');
      await js('chooseSession()'); await tick(); await overflow();
      await shot(`session-filters-${theme}-${width}.png`);
      await js("$('session-switcher').close()"); await tick();
      await js('void openPalette()'); await wait('dialog.open'); await tick(); await overflow();
      await shot(`palette-filters-${theme}-${width}.png`);
      await js('dialog.close()'); await tick();
      await js(`selectTab(tabs.get(${JSON.stringify(selectionOrigin)}) || undefined, 'settings')`);
      const beforeFourPanes = await js('({ active: active?.id, split: splitLayout, filesOpen, ids: [...tabs.keys()] })');
      await js(`(async () => {
        if (filesOpen) toggleFiles();
        while ([...tabs.values()].filter(tab => tab.kind === 'shell').length < 4) {
          await openHost(hosts[0], { force: true, connectNow: false });
        }
        const panes = [...tabs.values()].filter(tab => tab.kind === 'shell').slice(0, 4);
        for (const tab of panes) previewListener({ type: 'session', id: tab.id, status: 'ready' });
        splitLayout = { panes: panes.map(tab => tab.id), direction: 'grid', ratio: 50, rowRatio: 50 };
        selectTab(panes[0]);
      })()`);
      await tick(); await overflow();
      assert(await js(`(() => {
        const panes = splitLayout.panes.map(id => tabs.get(id));
        return panes.every(tab => !tab.view.hidden &&
          tab.view.querySelector('.xterm-screen').getBoundingClientRect().bottom <=
          tab.surface.getBoundingClientRect().bottom + .5);
      })()`), 'All four terminals should fit inside their panes');
      await shot(`four-panes-${theme}-${width}.png`);
      for (const axis of ['column', 'row']) {
        const position = await js(`(() => {
          const rect = document.querySelector('.split-grip[data-axis="${axis}"]').getBoundingClientRect();
          return { x: rect.x + rect.width * ${axis === 'row' ? '.75' : '.5'},
            y: rect.y + rect.height * ${axis === 'column' ? '.25' : '.5'} };
        })()`);
        assert.equal(await js(`document.elementFromPoint(${position.x}, ${position.y})?.dataset.axis`), axis,
          `${axis} separator should receive pointer input`);
        await run('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
        await run('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', buttons: 1, clickCount: 1 });
        await run('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x + (axis === 'column' ? 20 : 0),
          y: position.y + (axis === 'row' ? 20 : 0), buttons: 1 });
        await run('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x + (axis === 'column' ? 20 : 0),
          y: position.y + (axis === 'row' ? 20 : 0), button: 'left', clickCount: 1 });
      }
      await tick(); await overflow();
      const draggedLayout = await js('({ ratio: splitLayout.ratio, rowRatio: splitLayout.rowRatio })');
      assert(draggedLayout.ratio > 50 && draggedLayout.rowRatio > 50,
        `Both four-pane separators must respond to pointer dragging: ${JSON.stringify(draggedLayout)}`);
      await js("[...active.paneHeader.querySelectorAll('button')].find(button => button.textContent === '分屏设置').click()");
      await windowChrome('#dialog');
      await tick(); await overflow(); await shot(`four-pane-settings-${theme}-${width}.png`);
      await js("dialog.querySelector('.split-slot .dropdown-trigger').click()");
      await tick(); await overflow(); await shot(`four-pane-search-${theme}-${width}.png`);
      const sourceFilter = await js(`(() => {
        const rect = dialog.querySelector('.dropdown-sources [data-source="host"]').getBoundingClientRect();
        return {x:rect.x + rect.width/2, y:rect.y + rect.height/2};
      })()`);
      await run('Input.dispatchMouseEvent', {type:'mouseMoved', ...sourceFilter});
      await run('Input.dispatchMouseEvent', {type:'mousePressed', ...sourceFilter, button:'left', buttons:1, clickCount:1});
      await run('Input.dispatchMouseEvent', {type:'mouseReleased', ...sourceFilter, button:'left', clickCount:1});
      assert(await js(`(() => {
        const picker = dialog.querySelector('.dropdown-searchable');
        return picker?.querySelector('[data-source="host"]').getAttribute('aria-pressed') === 'true' &&
          document.activeElement === picker.querySelector('input');
      })()`), 'Pointer filtering must keep the picker open and preserve search focus');
      await run('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await run('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert(await js("dialog.open && !dialog.querySelector('.dropdown-searchable')"), 'Escape should close only the searchable picker');
      await js('dialog.close()'); await tick();
      await js(`(() => {
        for (const tab of [...tabs.values()]) if (!${JSON.stringify(beforeFourPanes.ids)}.includes(tab.id)) removeTab(tab);
        splitLayout = ${JSON.stringify(beforeFourPanes.split)};
        selectTab(tabs.get(${JSON.stringify(beforeFourPanes.active)}));
        if (filesOpen !== ${beforeFourPanes.filesOpen}) toggleFiles();
      })()`);
      await js("selectTab([...tabs.values()].find(tab=>tab.kind==='shell'))"); await tick(); await overflow();
      await wait("!$('files').getAnimations().some(animation => animation.playState === 'running')");
      await js(`(() => {
        const search = $('files').querySelector('input[type="search"]');
        search.value = '';
        search.dispatchEvent(new Event('input'));
      })()`);
      assert(await js(`(() => {
        const panel = $('files').getBoundingClientRect();
        const list = $('files').querySelector('.file-list').getBoundingClientRect();
        return list.top - panel.top <= 145 && list.height >= panel.height - 145;
      })()`), 'File controls should leave the remaining panel height to the list');
      await shot(`session-${theme}-${width}.png`);
      if (theme === 'dark') {
        const shellId = await js('active.id');
        await js(`(async () => {
          const connect = api.ssh.connect;
          api.ssh.connect = async () => {};
          try { await openHost(active.host, { force: true }); }
          finally { api.ssh.connect = connect; }
        })()`);
        await tick();
        await wait("getComputedStyle($('files')).visibility === 'hidden'");
        await overflow(); await shot(`connection-progress-${width}.png`);
        await js("previewListener({type:'session',id:active.id,status:'closed',exited:false,message:'SSH 连接超时。请检查网络连接和主机地址。'})");
        await tick(); await overflow(); await shot(`connection-failed-${width}.png`);
        await js(`removeTab(active); selectTab(tabs.get(${JSON.stringify(shellId)}))`);
        await js("openTerminalPath(active, '/srv/app/config.json')");
        await wait("Boolean(fileEditor.querySelector('.cm-content'))");
        const bounds = () => js('fileEditor.getBoundingClientRect().toJSON()');
        const initial = await bounds();
        await drag('.file-editor-grip', -100, -80);
        const smaller = await bounds();
        assert.equal(smaller.width, initial.width - 100);
        assert.equal(smaller.height, initial.height - 80);
        await drag('.file-editor-heading h2', 40, 30);
        const moved = await bounds();
        assert.equal(moved.x, smaller.x + 40);
        assert.equal(moved.y, smaller.y + 30);
        await js("fileEditor.querySelector('.file-editor-heading button').click()");
        await tick();
        const expanded = await bounds();
        assert.deepEqual([expanded.x, expanded.y, expanded.width, expanded.height], [0, 50, width, height - 50]);
        await windowChrome('#file-editor');
        assert(await js("fileEditor.querySelector('h2').getBoundingClientRect().top >= parseFloat(getComputedStyle(fileEditor).getPropertyValue('--titlebar-height'))"));
        await overflow(); await shot(`file-editor-fullscreen-${width}.png`);
        await js("fileEditor.querySelector('.file-editor-heading button').click()");
        await tick();
        assert.deepEqual(await bounds(), moved);
        await js("[...fileEditor.querySelectorAll('button')].find(button => button.textContent === '取消').click()");
        await tick();
      }
    }
  }
  await js("if (filesOpen) toggleFiles(); selectTab([...tabs.values()].find(tab=>tab.kind==='shell'))");
  await tick();
  const narrowCols = await js("active.terminal.cols");
  await run('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1050, deviceScaleFactor: 1, mobile: false });
  await wait(`active.terminal.cols > ${narrowCols} && active.terminal.cols > 150 &&
    previewResizes.at(-1)?.id === active.id && previewResizes.at(-1)?.size.cols === active.terminal.cols`);
  await run('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await js("selectTab(undefined,'hosts');document.querySelector('.host-quick-edit').click()");
  await wait("document.querySelector('dialog[open] .host-form-section')");
  assert.equal(await js('getComputedStyle(dialog).animationName'),'none');
  await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='取消').click()");
  assert.equal(await js('dialog.open'),false);
  console.log('PASS: workspace navigation, four-pane layouts and both separators, compact file panel, and file-editor drag, resize, fullscreen and restore at both window sizes.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    await request('Browser.close').catch(() => browser.kill());
    await exited;
  }
  await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
