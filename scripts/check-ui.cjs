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
      await shot(`host-editor-${theme}-${width}.png`);
      await js('dialog.close()'); await tick();
      await js("document.querySelector('.host-open[data-host-id=\"key-host\"]').parentElement.querySelector('.host-quick-edit').click()");
      await wait("document.querySelector('dialog[open] .host-key-selection')");
      await wait("!dialog.getAnimations().some(a=>a.playState==='running')");
      await js("document.querySelector('.host-key-selection').scrollIntoView({block:'center'})");
      await tick(); await overflow(); await shot(`host-key-${theme}-${width}.png`);
      await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='选择私钥').click()");
      await wait("document.querySelector('#key-dialog[open] [role=radio]')"); await overflow();
      await shot(`key-picker-${theme}-${width}.png`);
      await js("[...document.querySelectorAll('#key-dialog .actions button')].find(b=>b.textContent==='关闭').click();dialog.close()"); await tick();
      for (const page of ['keys','transfers','vault']) {
        await js(`selectTab(undefined,'${page}')`); await tick(); await overflow();
      }
      for (const section of ['preferences','groups','identities','snippets','layouts','logs','trust']) {
        await js(`openSettings('${section}')`);
        await wait("document.querySelector('#settings-page .settings-form')"); await tick(); await overflow();
      }
      await js("openSettings('preferences')"); await wait("document.querySelector('#settings-page .settings-form')");
      await shot(`settings-${theme}-${width}.png`);
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
        assert.deepEqual([expanded.x, expanded.y, expanded.width, expanded.height], [0, 0, width, height]);
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
  console.log('PASS: workspace navigation, compact file panel, and file-editor drag, resize, fullscreen and restore at both window sizes.');
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
