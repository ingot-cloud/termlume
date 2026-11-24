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
const deadline = setTimeout(() => { console.error('UI checks timed out.', stderr); browser.kill(); process.exitCode = 1; }, 180000);
async function main() {
  const { targetId } = await request('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true });
  const run = (method, params) => request(method, params, sessionId);
  const js = async expression => {
    const result = await run('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception.description);
    return result.result.value;
  };
  const wait = async (expression, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const tick = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const stableSearchDialog = async (pane, search, queries, maxWidth, maxHeight) => {
    const geometry = () => js(`(() => {
      const pane=document.querySelector(${JSON.stringify(pane)});
      const rect=element=>element?['x','y','width','height'].map(key=>element.getBoundingClientRect()[key]):null;
      const footer=pane.querySelector(':scope > form > .actions, :scope > .actions, .dropdown-count');
      return {frame:rect(pane),search:rect(pane.querySelector(${JSON.stringify(search)})),footer:rect(footer),
        viewport:[innerWidth,innerHeight],titlebar:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height'))};
    })()`);
    const before = await geometry();
    for (const query of queries) {
      await js(`(() => {const input=document.querySelector(${JSON.stringify(pane)}).querySelector(${JSON.stringify(search)});input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await tick();
      const after = await geometry();
      for (const key of ['frame','search','footer']) {
        assert.equal(Boolean(after[key]), Boolean(before[key]));
        if (before[key]) assert(after[key].every((value,index)=>Math.abs(value-before[key][index])<=1),
          `${pane} ${key} must stay fixed while filtering ${JSON.stringify(query)}: ${JSON.stringify({before,after})}`);
      }
    }
    const [x,y,width,height] = before.frame;
    assert(width<=maxWidth+1 && height<=maxHeight+1 && x>=7 && y>=before.titlebar+7 &&
      x+width<=before.viewport[0]-7 && y+height<=before.viewport[1]-7,
      `${pane} must retain its size cap and window margins: ${JSON.stringify(before)}`);
  };
  const overflow = async () => {
    const failures = await js(`({page:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&b.clientWidth&&(b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1)).map(b=>b.getAttribute('aria-label')||b.textContent)})`);
    assert.deepEqual(failures, { page: false, buttons: [] });
  };
  const settingsAlignment = async section => {
    const geometry = await js(`(() => {
      const body=document.querySelector('#settings-page .settings-fields, #settings-page .security-body');
      const field=[...body.children].find(e=>e.getBoundingClientRect().width && !e.hidden);
      const bounds=body.getBoundingClientRect(), rect=field.getBoundingClientRect();
      const footer=document.querySelector('#settings-page .settings-form-actions .settings-actions')?.getBoundingClientRect();
      return {centerError:Math.abs(rect.left+rect.width/2-(bounds.left+body.clientLeft+body.clientWidth/2)),
        footerError:footer?Math.abs(footer.right-rect.right):0,
        width:rect.width,viewport:body.clientWidth,
        titleRemoved:!document.querySelector('#settings-page h1, #settings-page > .page-toolbar'),
        unusedTopSpace:bounds.top-document.querySelector('#settings-page').getBoundingClientRect().top};
    })()`);
    assert(geometry.centerError<=1 && geometry.footerError<=8 && geometry.width<=760 && geometry.titleRemoved && geometry.unusedTopSpace<=1,
      `${section} settings must start directly with centered content and aligned save actions: ${JSON.stringify(geometry)}`);
  };
  const shot = async name => {
    const { data } = await run('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'dist/ux-review', name), Buffer.from(data, 'base64'));
  };
  const updateNoticeChecks = async width => {
    const publish = (version, phase = 'available') => js(`previewListener({type:'update',state:{
      currentVersion:'0.2.2',version:'${version}',phase:'${phase}',canDownload:${phase === 'available'},
      message:'更新状态',notes:'更新说明',downloaded:0,total:null}})`);
    const click = label => js(`[...dialog.querySelectorAll('.actions button')].find(b=>b.textContent==='${label}').click()`);
    await js("selectTab(undefined,'hosts');$('host-search').focus()");
    await publish('0.2.3', 'pending');
    assert(await js('!dialog.open'), 'A release without a download must not interrupt the user');
    await js("void confirm('正在处理的操作','操作进行中。','确定')");
    await publish('0.2.3');
    assert(await js("dialog.querySelector('h2').textContent==='正在处理的操作'"), 'Update notification must wait for an open dialog');
    await click('取消');
    await wait("dialog.open && dialog.textContent.includes('Termlume v0.2.3')");
    assert.deepEqual(await js("[...dialog.querySelectorAll('.actions button')].map(b=>b.textContent)"), ['取消','去更新']);
    await overflow();
    await click('取消');
    await wait('!dialog.open && !dialog.childElementCount');
    await publish('0.2.3');
    assert(await js("!dialog.open && workspace.dataset.view==='hosts' && document.activeElement===$('host-search')"),
      'Dismissal must preserve work and repeated events must not reopen the notice');

    await js("window.noticeDownload=api.updates.download;api.updates.download=async()=>{throw Error('Unexpected download')}");
    await publish('0.2.4');
    await click('去更新');
    await wait("!dialog.open && $('settings-page').textContent.includes('新版本 v0.2.4')");
    assert(await js("appUpdateState.phase==='available' && !$('settings-page').querySelector('.dialog-error').textContent && [...$('settings-page').querySelectorAll('button')].some(b=>b.textContent==='下载更新')"),
      'Go to update must open the version details without starting a download');
    await publish('0.2.6');
    assert(await js("!dialog.open && $('settings-page').textContent.includes('新版本 v0.2.6')"), 'Update details must refresh in place');
    await js("api.updates.download=noticeDownload;previewListener({type:'update',state:{...previewUpdateState,revision:undefined,phase:'idle',version:null,canDownload:false}});selectTab(undefined,'hosts')");
    console.log(`${width}px: PASS update notification, deferral, dismiss, and direct navigation to update details`);
  };
  const hostCardChecks = async width => {
    const layout = await js(`(() => {
      const compact = { id:'card-ip', name:'腾讯云-198.51.100.85', address:'198.51.100.85', username:'ubuntu', port:22 };
      const long = { id:'card-long', name:'生产环境-数据库备份节点-'.repeat(5), address:'database-replica-'.repeat(5)+'example.test', username:'backup', port:2222 };
      const section = hostSection('主机', [hostCard(compact), hostCard(long)]);
      $('host-list').replaceChildren(section);
      const entries = section.querySelector('.host-entries');
      const textLines = card => [...card.querySelectorAll('.host-identity > *')].map(label => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return { lines: new Set([...range.getClientRects()].map(rect=>rect.top)).size, fits: label.scrollWidth <= label.clientWidth };
      });
      return { compact:textLines(entries.firstElementChild), long:textLines(entries.lastElementChild) };
    })()`);
    assert(layout.compact.every(label => label.lines === 1 && label.fits), 'An IP-based name and login should fit on one line each');
    assert(layout.long.every(label => label.lines > 1 && label.fits), 'Long names and endpoints should wrap within the card');
    await overflow();
    await js('renderHosts()');
    console.log(`${width}px: PASS full host card names and endpoints, including long values`);
  };
  const commandOrderChecks = async width => {
    await js(`window.originalCommands=structuredClone(previewSnippets);window.commandSaveCount=previewCalls.filter(([type])=>type==='reorder-snippets').length;
      previewSnippets.splice(0,previewSnippets.length,...[1,2,3,4].map(n=>({id:'q'+n,name:'命令 '+n,command:'echo '+n,tags:['qa'],pinned:n===1,order:n*10})));
      openSettings('snippets')`);
    await wait("document.querySelectorAll('.command-library-card').length===4");
    const visible = () => js("[...document.querySelectorAll('.command-library-card')].map(card=>card.dataset.orderId)");
    const desktop = width !== 550;
    const columns = await js("getComputedStyle(document.querySelector('.command-library-grid')).gridTemplateColumns.split(' ').length");
    assert.equal(columns, desktop ? 2 : 1);
    const start = await js(`(() => {
      const handle=document.querySelector('[data-order-id=${desktop ? 'q1' : 'q2'}] .order-handle');
      const rect=handle.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    const end = await js(`(() => {
      const rect=document.querySelector('.command-library-card[data-order-id=${desktop ? 'q3' : 'q1'}]').getBoundingClientRect();
      return ${desktop ? '{x:rect.right-8,y:rect.top+16}' : '{x:rect.left+30,y:rect.top+8}'};
    })()`);
    const startDrag = async () => {
      await run('Input.dispatchMouseEvent', { type:'mouseMoved', ...start });
      await run('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', buttons:1, clickCount:1, ...start });
      await run('Input.dispatchMouseEvent', { type:'mouseMoved', buttons:1, ...end });
      assert(await js('orderDrag?.started && !orderMarker.hidden'), 'Dragging a command must mark its insertion point');
    };
    const release = () => run('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...end });
    await startDrag();
    await run('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await run('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await release();
    assert.deepEqual(await visible(), ['q1','q2','q3','q4']);
    await startDrag();
    await release();
    await wait("previewCalls.filter(([type])=>type==='reorder-snippets').length===commandSaveCount+1 && !document.querySelector('.command-library-grid[aria-busy]')");
    const reordered = desktop ? ['q2','q3','q1','q4'] : ['q2','q1','q3','q4'];
    assert.deepEqual(await visible(), reordered);
    await js("openSettings('preferences');openSettings('snippets')");
    await wait("document.querySelectorAll('.command-library-card').length===4");
    assert.deepEqual(await visible(), reordered);
    await js("const search=document.querySelector('[aria-label=\"搜索命令库\"]');search.value='命令 2';search.dispatchEvent(new Event('input'))");
    assert.deepEqual(await visible(), ['q2']);
    assert(await js("document.querySelector('.command-library-card .order-handle').disabled"));
    await overflow();
    await js("previewSnippets.splice(0,previewSnippets.length,...originalCommands);selectTab(undefined,'hosts')");
    console.log(`${width}px: PASS command card columns, insertion preview, cancelled drop, persisted order, and search guard`);
  };
  const deletionChecks = async width => {
    await js(`(async()=>{window.deleteOriginalHosts=structuredClone(previewHosts);window.deleteOriginalGroups=structuredClone(previewGroups);
      previewGroups.push({id:'delete-parent',name:'删除验收'},{id:'delete-child',name:'子组',parentId:'delete-parent'});
      previewHosts.push({id:'delete-host',name:'待删除主机',address:'delete.test',port:22,username:'ops',auth:'agent',groupId:'delete-parent',group:'删除验收'},
        {id:'keep-host',name:'保留主机',address:'keep.test',port:22,username:'ops',auth:'agent',groupId:'delete-child',group:'删除验收 / 子组'});
      selectTab(undefined,'hosts');await refreshHosts();$('host-layout').value='tree';$('host-layout').dispatchEvent(new Event('change'));
      document.querySelector('[data-tree-group="delete-parent"] .tree-group-toggle').click();
      document.querySelector('[data-host-id="delete-host"]').parentElement.querySelector('.host-edit:last-child').click()})()`);
    assert(await js("[...hostMenu.panel.querySelectorAll('button')].some(b=>b.textContent==='删除主机' && b.classList.contains('danger'))"));
    const before = await js("previewCalls.filter(([type])=>type==='remove-host').length");
    await js("[...hostMenu.panel.querySelectorAll('button')].find(b=>b.textContent==='删除主机').click()");
    await wait("dialog.open && dialog.textContent.includes('delete.test')");
    assert.equal(await js("previewCalls.filter(([type])=>type==='remove-host').length"),before,'Opening confirmation must not delete');
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='取消').click()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert(await js("previewHosts.some(h=>h.id==='delete-host')"),'Cancelling host deletion must preserve it');
    await js("void deleteHost(hosts.find(h=>h.id==='delete-host'))");await wait('dialog.open');
    await overflow();await shot(`host-delete-confirm-${width}.png`);
    await js("dialog.querySelector('form').requestSubmit()");await wait('!dialog.open && !dialog.childElementCount');
    await wait("!hosts.some(h=>h.id==='delete-host')");
    assert.equal(await js("previewCalls.filter(([type])=>type==='remove-host').length"),before+1);
    await js(`document.querySelector('[aria-label="分组操作 删除验收"]').click();hostMenu.panel.querySelector('button').click()`);
    await wait("dialog.open && dialog.textContent.includes('1 个子分组')");
    assert(await js("dialog.textContent.includes('1 台主机会移到未分组')"));
    await overflow();await shot(`group-delete-confirm-${width}.png`);
    await js("dialog.querySelector('form').requestSubmit()");await wait('!dialog.open && !dialog.childElementCount');
    await wait("!groupAssets.some(g=>g.id==='delete-parent')");
    assert(await js("previewHosts.find(h=>h.id==='keep-host').group==='' && !previewHosts.find(h=>h.id==='keep-host').groupId && !previewGroups.some(g=>g.id==='delete-child') && $('host-list').querySelector('[data-host-id=keep-host]')"),'Deleting a group must preserve child-group hosts at the ungrouped root');
    assert.deepEqual(await js("previewCalls.filter(([type])=>type==='remove-group').at(-1)[1].expectedGroups.map(g=>g.id)"),['delete-parent','delete-child']);
    await js(`previewGroups.push({id:'delete-settings',name:'设置删除验收'});openSettings('groups')`);
    await wait(`$('settings-page').querySelector('[aria-label="删除分组 设置删除验收"]')`);
    await js(`$('settings-page').querySelector('[aria-label="删除分组 设置删除验收"]').click()`);
    await wait("dialog.open && dialog.textContent.includes('设置删除验收')");
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='取消').click()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert(await js("previewGroups.some(g=>g.id==='delete-settings')"),'Cancelling group deletion must preserve the group');
    await js(`(async()=>{previewHosts.splice(0,previewHosts.length,...deleteOriginalHosts);previewGroups.splice(0,previewGroups.length,...deleteOriginalGroups);
      selectTab(undefined,'hosts');await refreshHosts();$('host-layout').value='cards';$('host-layout').dispatchEvent(new Event('change'))})()`);
    console.log(`${width}px: PASS host deletion menu and confirmation/cancel, group subtree deletion with hosts retained, settings confirmation and stale-preview payload`);
  };
  const csvChecks = async width => {
    await js("selectTab(undefined,'hosts');selectedHostId='';selectedGroup='';currentGroup='';void exportHosts()");
    await wait("dialog.open && dialog.textContent.includes('导出范围')");
    assert(await js("dialog.textContent.includes('不包含密码、私钥、私钥路径、私钥口令')"));
    assert(await js("['all','group:prod','group:stage','host:api','host:jump'].every(value=>[...dialog.querySelector('select').options].some(o=>o.value===value))"));
    await js("dialog.querySelector('select').value='group:prod';dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.deepEqual(await js("previewCalls.filter(([type])=>type==='csv-export').at(-1)[1]"),{groupId:'prod'});
    await js(`api.hosts.csvPreview=async()=>({warnings:['密码和私钥需单独配置。'],groups:[
      {id:'csv-parent',name:'父组',path:'父组'}, {id:'csv-child',name:'空组',path:'父组 / 空组',parentId:'csv-parent'}],rows:[
      {id:'csv-host',name:'密码主机',address:'host.test',port:22,username:'ops',auth:'password',groupId:'csv-child',group:'父组 / 空组',jumpHostId:'csv-jump'},
      {id:'csv-jump',name:'跳板机',address:'jump.test',port:2222,username:'jump',auth:'key'}]});void importHosts(true)`);
    await wait("dialog.open && dialog.textContent.includes('预览 CSV 导入')");
    assert(await js("dialog.textContent.includes('密码认证 · 导入后单独配置密码') && dialog.textContent.includes('私钥认证 · 导入后选择本机私钥')"));
    await overflow();await shot(`csv-import-${width}.png`);
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='全不选').click();dialog.querySelector('form').requestSubmit()");
    await wait("dialog.querySelector('[role=alert]').textContent.includes('请选择至少')");
    await js("dialog.querySelectorAll('.import-row input[type=checkbox]')[0].checked=true;dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.deepEqual(await js("previewCalls.filter(([type])=>type==='csv-import').at(-1)[1].rows.map(r=>r.id)"),['csv-host','csv-jump']);
    assert.deepEqual(await js("previewCalls.filter(([type])=>type==='csv-import').at(-1)[1].groups.map(g=>g.id).sort()"),['csv-child','csv-parent']);
    await js("void importHosts(true)");await wait('dialog.open');
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='全不选').click();dialog.querySelector('.key-list > label input').checked=true;dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js("previewCalls.filter(([type])=>type==='csv-import').at(-1)[1].rows.length"),0);
    await js("api.hosts.csvPreview=async()=>null");
    await js("api.hosts.importPreview=async()=>({warnings:[],rows:[{name:'one',address:'one.test',port:22,username:'ops',auth:'agent'},{name:'two',address:'two.test',port:22,username:'ops',auth:'agent'}]});void importHosts()");
    await wait('dialog.open');
    await js("dialog.querySelector('form').requestSubmit()");await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js("previewCalls.filter(([type])=>type==='csv-import').at(-1)[1].rows.length"),2);
    console.log(`${width}px: PASS CSV export scope, credential hints, dependent groups/jump hosts, empty selection and group-only imports`);
  };
  const hostTreeChecks = async width => {
    await js(`(async()=>{window.treeOriginalHosts=structuredClone(previewHosts);window.treeOriginalGroups=structuredClone(previewGroups);
      previewGroups.push({id:'child',name:'应用',parentId:'prod'},{id:'leaf',name:'数据库节点',parentId:'child'});
      Object.assign(previewHosts.find(h=>h.id==='db'),{groupId:'leaf',group:'生产环境 / 应用 / 数据库节点'});
      expandedHostGroups.clear();collapsedSettingsGroups.clear();selectTab(undefined,'hosts');$('host-search').value='';$('tag-filter').value='';await refreshHosts();
      $('host-layout').value='tree';$('host-layout').dispatchEvent(new Event('change'))})()`);
    const toggle = id => `document.querySelector('#host-list [data-tree-group="${id}"] > .tree-group-row .tree-group-toggle')`;
    const arrow = async key => {
      await run('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:{ArrowRight:39,ArrowLeft:37,ArrowDown:40}[key]});
      await run('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});await tick();
    };
    assert(await js(`$('host-list').querySelector(':scope > ul > .tree-host .host-open[data-host-id=jump]') && ${toggle('prod')}.getAttribute('aria-expanded')==='false' && !document.querySelector('#host-list [data-tree-group="child"]').getClientRects().length`),
      'Root must show groups and ungrouped hosts, with nested groups initially collapsed');
    await js(`${toggle('prod')}.focus()`);await arrow('ArrowRight');await arrow('ArrowRight');
    assert(await js(`document.activeElement===${toggle('child')}`),'Right arrow must enter the first child');
    await arrow('ArrowRight');await arrow('ArrowRight');await arrow('ArrowRight');
    assert(await js("document.querySelector('#host-list .host-open[data-host-id=db]').getClientRects().length"),'Three levels must reveal the nested host');
    await arrow('ArrowLeft');await arrow('ArrowLeft');
    assert(await js(`document.activeElement===${toggle('child')}`),'Left arrow must collapse then return to the parent');
    await js(`${toggle('leaf')}.click();document.querySelector('#host-list .host-open[data-host-id=db]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));${toggle('prod')}.click()`);
    assert(await js("selectedHostId===''"),'Collapsing a selected descendant must clear its hidden selection');
    await js("$('host-search').value='db.example.test';$('host-search').dispatchEvent(new Event('input'))");
    assert(await js(`[${toggle('prod')},${toggle('child')},${toggle('leaf')}].every(b=>b.getAttribute('aria-expanded')==='true') && document.querySelector('#host-list .host-open[data-host-id=db]').getClientRects().length && !document.querySelector('#host-list .host-open[data-host-id=jump]')`),
      'Search must reveal the complete ancestor chain without unrelated root hosts');
    await js("$('host-search').value='missing-tree-host';$('host-search').dispatchEvent(new Event('input'))");
    assert(await js("!$('host-list').querySelector('.host-open,.tree-group-toggle') && $('host-connect').disabled"));
    await js("$('host-search').value='';$('host-search').dispatchEvent(new Event('input'))");
    assert(await js(`${toggle('prod')}.getAttribute('aria-expanded')==='false'`),'Clearing search must restore the previous collapsed state');
    await js("$('tag-filter').value='database';$('tag-filter').dispatchEvent(new Event('change'))");
    assert(await js("document.querySelector('#host-list .host-open[data-host-id=db]').getClientRects().length && document.querySelectorAll('#host-list .host-open').length===1"),'Tag filtering must retain ancestors of nested matches');
    await js("$('tag-filter').value='';$('tag-filter').dispatchEvent(new Event('change'));for(const b of $('host-list').querySelectorAll('.tree-group-toggle[aria-expanded=false]'))b.click()");
    await tick();await overflow();await shot(`host-tree-dark-${width}.png`);
    await js("uiPreferences.theme='light';applyPreferences()");await tick();await overflow();await shot(`host-tree-light-${width}.png`);
    await js("uiPreferences.theme='dark';applyPreferences();openSettings('groups')");
    await wait("$('settings-page').querySelector('.group-tree')");
    assert(await js("[...$('settings-page').querySelectorAll('.tree-group-toggle')].every(b=>b.getAttribute('aria-expanded')==='true') && $('settings-page').querySelector('[data-tree-group=leaf]').closest('.tree-children')"),
      'Group management must display the nested hierarchy expanded by default');
    await tick();await overflow();await shot(`group-tree-dark-${width}.png`);
    await js("uiPreferences.theme='light';applyPreferences()");await tick();await overflow();await shot(`group-tree-light-${width}.png`);
    await js(`uiPreferences.theme='dark';applyPreferences();$('settings-page').querySelector('[aria-label="给 生产环境 / 应用 添加子组"]').click()`);
    await wait("$('settings-page').getAttribute('aria-label')==='添加子组'");
    assert(await js("[...$('settings-page').querySelectorAll('select')].find(s=>s.querySelector('option[value=child]')).value==='child'"),'Add subgroup must preselect its parent');
    await js("$('settings-page').querySelector('input').value='新子组';$('settings-page').querySelector('form').requestSubmit()");
    await wait("$('settings-page').querySelector('.group-tree') && previewGroups.some(g=>g.name==='新子组')");
    assert(await js("[...$('settings-page').querySelectorAll('[data-tree-group=child] > .tree-children > .tree-item strong')].some(e=>e.textContent==='新子组')"),'Saved subgroup must appear beneath its selected parent');
    await js("$('settings-page').querySelector('[aria-label=\"编辑分组 生产环境\"]').click()");
    await wait("$('settings-page').getAttribute('aria-label')==='编辑分组'");
    assert(await js("![...$('settings-page').querySelectorAll('select option')].some(o=>['prod','child','leaf'].includes(o.value))"),'Parent picker must exclude self and descendants');
    await js("$('settings-page').querySelector('input').value='正式环境';$('settings-page').querySelector('form').requestSubmit()");
    await wait("$('settings-page').querySelector('.group-tree') && previewGroups.find(g=>g.id==='prod').name==='正式环境'");
    assert(await js("$('settings-page').querySelector('[data-tree-group=leaf]').closest('[data-tree-group=prod]') && previewHosts.find(h=>h.id==='db').group==='正式环境 / 应用 / 数据库节点'"),'Rename must preserve descendant IDs and host placement');
    // A deeply nested group must remain usable without growing past the viewport.
    await js("for(let i=0;i<12;i++)previewGroups.push({id:'deep-'+i,name:'很长的子分组名称 '+i,parentId:i?'deep-'+(i-1):'leaf'});openSettings('groups')");
    await wait("$('settings-page').querySelector('[data-tree-group=deep-11]')");await tick();await overflow();
    await js("(async()=>{selectTab(undefined,'hosts');await refreshHosts();for(const layout of ['rows','cards','tree']){$('host-layout').value=layout;$('host-layout').dispatchEvent(new Event('change'));}})()");
    assert(await js("workspace.dataset.hostLayout==='tree' && localStorage.getItem('host-layout')==='tree'"));
    await js("for(const b of $('host-list').querySelectorAll('.tree-group-toggle[aria-expanded=false]'))b.click()");await tick();await overflow();
    await js("(async()=>{previewHosts.splice(0,previewHosts.length,...treeOriginalHosts);previewGroups.splice(0,previewGroups.length,...treeOriginalGroups);expandedHostGroups.clear();collapsedSettingsGroups.clear();localStorage.removeItem('host-tree-expanded');$('host-layout').value='cards';$('host-layout').dispatchEvent(new Event('change'));await refreshHosts()})()");
    console.log(`${width}px: PASS host/group trees, nested search/tags, keyboard, child creation, rename, cyclic parent exclusion and deep/narrow layouts`);
  };
  const beginTabDrag = async (id, target, edge) => {
    let start = await js(`(() => {
      const tab = tabs.get(${JSON.stringify(id)});
      const row = tab.paneHeader && !tab.paneHeader.hidden && !tab.view.hidden ? tab.paneHeader : workspaceEntryFor(tab.id).tab.tabRow;
      row.scrollIntoView({block:'nearest',inline:'center'});
      const r = row.querySelector('.split-pane-title, .tab-open').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await tick();
    start = await js(`(() => {const tab=tabs.get(${JSON.stringify(id)});const row=tab.paneHeader&&!tab.paneHeader.hidden&&!tab.view.hidden?tab.paneHeader:workspaceEntryFor(tab.id).tab.tabRow;const r=row.querySelector('.split-pane-title, .tab-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.equal(await js(`document.elementFromPoint(${start.x},${start.y})?.closest('.tab, .split-pane-header')?.dataset.tabId`),id,'Drag source must be visible');
    const end = await js(`(() => {
      const r = tabs.get(${JSON.stringify(target)}).view.getBoundingClientRect();
      return {x:r.x+${edge === 'left' ? '3' : edge === 'right' ? 'r.width-3' : edge === 'right-inner' ? 'r.width*.75' : 'r.width/2'},
        y:r.y+${edge === 'top' ? '3' : edge === 'bottom' ? 'r.height-3' : 'r.height/2'}};
    })()`);
    await run('Input.dispatchMouseEvent', {type:'mouseMoved',...start});
    await run('Input.dispatchMouseEvent', {type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
    assert.equal(await js('tabDrag?.id'),id,'Pointer down must arm the tab drag');
    await run('Input.dispatchMouseEvent', {type:'mouseMoved',x:start.x+8,y:start.y+8,buttons:1});
    assert(await js('Boolean(tabDrag?.started)'), 'Pointer movement must start the tab drag');
    const center=await js(`(() => {const r=tabs.get(${JSON.stringify(target)}).view.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await run('Input.dispatchMouseEvent', {type:'mouseMoved',...center,buttons:1});
    await run('Input.dispatchMouseEvent', {type:'mouseMoved',...end,buttons:1});
    await tick();
    return end;
  };
  const releaseTab = async end => {
    await run('Input.dispatchMouseEvent', {type:'mouseReleased',...end,button:'left',clickCount:1});
    await tick();
  };
  const dragSplitChecks = async width => {
    const before = await js('({active:active?.id,split:splitLayout,filesOpen,ids:[...tabs.keys()]})');
    for (const theme of ['dark','light']) {
      const ids = await js(`(async () => {
        if(filesOpen) toggleFiles();
        uiPreferences.theme='${theme}';applyPreferences();
        window.dragCheckTabs=[];
        for(let i=0;i<5;i++) dragCheckTabs.push(await openHost(hosts[0],{force:true,connectNow:false}));
        dragCheckTabs.forEach((tab,index)=>{if(index!==2)previewListener({type:'session',id:tab.id,status:index===4?'closed':'ready'});});
        window.dragCheckTerminals=dragCheckTabs.map(tab=>tab.terminal);
        splitGroups.clear();splitLayout=undefined;selectTab(dragCheckTabs[0]);
        await new Promise(resolve=>dragCheckTabs[0].terminal.write(String.fromCharCode(27)+'[?1003h'+String.fromCharCode(27)+'[?1006h',resolve));
        window.dragCheckInputs=previewCalls.filter(([type])=>type==='input').length;
        window.dragCheckConnections=previewCalls.filter(([type])=>type==='connect').length;
        return dragCheckTabs.map(tab=>tab.id);
      })()`);
      await tick();
      let end = await beginTabDrag(ids[1],ids[0],'left');
      await releaseTab(end);
      assert(await js(`splitLayout.tree.first.id===${JSON.stringify(ids[1])}`),'Left-edge drops must place the source first');
      await js('splitGroups.clear();splitLayout=undefined;selectTab(dragCheckTabs[0])'); await tick();
      end = await beginTabDrag(ids[1],ids[0],'right');
      await js(`window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId:tabDrag.pointerId,button:-1,buttons:0,clientX:${end.x},clientY:${end.y},bubbles:true
      })); document.body.dispatchEvent(new PointerEvent('lostpointercapture', {
        pointerId:tabDrag.pointerId,buttons:0,bubbles:true
      }))`);
      assert(await js('Boolean(tabDrag?.started) && !tabDropPreview.hidden'),
        'WebKit zero button masks and capture changes must not cancel a held drag');
      await js(`window.dispatchEvent(new MouseEvent('mouseup', {
        button:0,buttons:1,clientX:${end.x},clientY:${end.y},bubbles:true
      }))`);
      assert(await js(`!tabDrag && splitLayout.panes.length===2 && active.id===${JSON.stringify(ids[1])}`),
        'A WebKit mouseup without pointerup must commit the drop');
      const mouseFallbackLayout = await js('JSON.stringify(splitLayout.tree)');
      await releaseTab(end);
      assert.equal(await js('JSON.stringify(splitLayout.tree)'),mouseFallbackLayout,
        'A later pointerup must not commit a mouse fallback drop twice');
      await js('splitGroups.clear();splitLayout=undefined;selectTab(dragCheckTabs[0])'); await tick();
      end = await beginTabDrag(ids[1],ids[0],'right');
      assert(await js(`active.id===${JSON.stringify(ids[0])} && !splitLayout && !tabDropPreview.hidden`),
        'Dragging a background tab must preserve the destination until release');
      assert(await js("previewCalls.filter(([type])=>type==='input').length===dragCheckInputs"),
        'Dragging across a terminal with mouse tracking must not send mouse input');
      await shot(`tab-split-preview-${theme}-${width}.png`);
      await releaseTab(end);
      assert(await js(`splitLayout.panes.length===2 && active.id===${JSON.stringify(ids[1])} && origin()===active`),
        'Dropping at the right edge must create two panes and focus the original session');
      end = await beginTabDrag(ids[2],ids[1],'bottom');
      await releaseTab(end);
      assert(await js(`splitLayout.panes.length===3 && splitLayout.tree.second.axis==='row' && active.id===${JSON.stringify(ids[2])}`),
        'An idle tab dropped below a pane must create a T-shaped layout');
      await overflow();
      assert(await js(`(() => {
        const probe=document.createElement('div');probe.style.background='var(--bg)';document.body.append(probe);
        const matches=getComputedStyle(probe).backgroundColor===getComputedStyle(dragCheckTabs[2].connectionPage).backgroundColor;
        probe.remove();return matches;
      })()`),'Connection controls must use the application background in both themes');
      await shot(`tab-split-three-${theme}-${width}.png`);
      const tree = await js('JSON.stringify(splitLayout.tree)');
      end = await beginTabDrag(ids[3],ids[0],'left');
      await run('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await run('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await releaseTab(end);
      assert.equal(await js('JSON.stringify(splitLayout.tree)'),tree,'Escape must cancel the drag');
      assert(await js('!tabDrag && tabDropPreview.hidden && tabDragGhost.hidden'),'Cancel must clear drag overlays');
      end = await beginTabDrag(ids[3],ids[0],'center');
      assert(await js('tabDropPreview.hidden'),'The center must not offer replacement');
      await releaseTab(end);
      assert.equal(await js('JSON.stringify(splitLayout.tree)'),tree,'Center drops must preserve the layout');
      if(width===550) {
        end = await beginTabDrag(ids[3],ids[1],'right');
        assert(await js("tabDropPreview.textContent.includes('空间不足') && tabDropPreview.dataset.disabled==='true'"),
          'A drop that cannot fit must show a disabled preview');
        await releaseTab(end);
        assert.equal(await js('JSON.stringify(splitLayout.tree)'),tree);
      }
      // Save and reopen the actual T-shaped layout, not a preset approximation.
      await js("void (window.dragCheckSaved=saveSessionLayout())");
      await js("dialog.querySelector('input').value='拖拽三屏';dialog.querySelector('form').requestSubmit()");
      await js('dragCheckSaved'); await tick();
      await js('window.dragCheckRecord=previewLayouts.at(-1);window.dragCheckOriginalIds=[...tabs.keys()];openSessionLayout(dragCheckRecord)');
      await tick();
      assert(await js(`splitLayout.panes.length===3 && splitLayout.tree.second.axis==='row' &&
        splitLayout.panes.every(id=>tabs.get(id).status==='idle')`),'Saved drag layouts must restore their shape as idle sessions');
      await js(`(() => {
        for(const tab of [...tabs.values()])if(!dragCheckOriginalIds.includes(tab.id))removeTab(tab);
        previewLayouts.splice(previewLayouts.indexOf(dragCheckRecord),1);
        splitLayout=splitFromTree(${tree});selectTab(dragCheckTabs[2]);
      })()`);
      await tick();
      end = await beginTabDrag(ids[3],ids[0],'bottom'); await releaseTab(end);
      assert(await js('splitLayout.panes.length===4'),'A fourth pane must fit in the remaining branch');
      const four = await js('JSON.stringify(splitLayout.tree)');
      end = await beginTabDrag(ids[4],ids[0],'right');
      if(width>550) {
        assert(await js("tabDropPreview.dataset.disabled==='false'"),'A fifth pane must be allowed when the window can fit it');
        await releaseTab(end);
        assert(await js('splitLayout.panes.length===5'),'There must be no four-pane count limit');
        await js('detachSplitPane(dragCheckTabs[4]);selectTab(dragCheckTabs[0])');await tick();
      } else {
        assert(await js("tabDropPreview.textContent.includes('空间不足')"),'Only available space may refuse a new split');
        await releaseTab(end);
        assert.equal(await js('JSON.stringify(splitLayout.tree)'),four);
      }
      end = await beginTabDrag(ids[2],ids[1],'top'); await releaseTab(end);
      assert(await js('splitLayout.panes.length===4 && new Set(splitLayout.panes).size===4'),
        'Moving an existing member at capacity must not duplicate it');
      assert(await js(`dragCheckTabs.every((tab,index)=>tab.terminal===dragCheckTerminals[index]) &&
        previewCalls.filter(([type])=>type==='connect').length===dragCheckConnections`),
        'All moves and layout restoration must preserve original terminals and never reconnect');
      // A target disappearing mid-drag must clear the preview and not insert the source.
      end = await beginTabDrag(ids[4],ids[3],'bottom');
      await js('removeTab(dragCheckTabs[3])');
      await releaseTab(end);
      assert(await js(`!tabDrag && tabDropPreview.hidden && splitLayout.panes.length===3 && !splitLayout.panes.includes(${JSON.stringify(ids[4])})`),
        'Closing the target during a drag must cancel safely');
      // Finder file events must not show an upload overlay during an internal drag.
      end = await beginTabDrag(ids[4],ids[0],'left');
      await js("handleFileDrag({phase:'enter',position:{x:10,y:100},count:1});window.dispatchEvent(new Event('blur'))");
      await releaseTab(end);
      assert(await js("$('terminal-drop').hidden && !tabDrag && tabDropPreview.hidden"),'Window blur must clear the internal drag without starting an upload');
      // Reorder a disconnected tab to the end, using pointer input in the tab strip.
      const start = await js(`(() => {
        const row=tabs.get(${JSON.stringify(ids[4])}).tabRow;row.scrollIntoView({inline:'center'});
        const r=row.querySelector('.tab-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+8,y:start.y+8,buttons:1});
      const stripEnd = await js("(() => {const s=$('tabs');s.scrollLeft=s.scrollWidth;const r=s.getBoundingClientRect();return{x:r.right-2,y:r.y+r.height/2}})()");
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...stripEnd,buttons:1});
      await releaseTab(stripEnd);
      assert.equal(await js('[...tabs.keys()].at(-1)'),ids[4],'Reordering at the strip end must append the tab');
      const expectedClickFocus = await js(`workspaceFocus(workspaceEntryFor(${JSON.stringify(ids[0])})).id`);
      const click = await js(`(() => {const row=workspaceEntryFor(${JSON.stringify(ids[0])}).tab.tabRow;row.scrollIntoView({inline:'center'});const r=row.querySelector('.tab-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...click});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',...click,button:'left',buttons:1,clickCount:1});
      await run('Input.dispatchMouseEvent',{type:'mouseReleased',...click,button:'left',clickCount:1});
      await tick();
      assert.equal(await js('active.id'),expectedClickFocus,'A fresh click immediately after dragging must select the workspace and its remembered pane');
      end = await beginTabDrag(ids[4],ids[0],'left');
      const beforeSourceClose = await js('JSON.stringify(splitLayout.tree)');
      await js('removeTab(dragCheckTabs[4])'); await releaseTab(end);
      assert.equal(await js('JSON.stringify(splitLayout.tree)'),beforeSourceClose,'Closing the source must not change other panes');
      assert(await js('!tabDrag && tabDropPreview.hidden'),'Closing the source must clear drag state');
      if(await js("$('tabs').scrollWidth>$('tabs').clientWidth")) {
        const first = await js("$('tabs').scrollLeft=0;[...tabs.keys()][0]");
        const start = await js(`(() => {const r=tabs.get(${JSON.stringify(first)}).tabRow.querySelector('.tab-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await run('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
        await run('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
        await run('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+8,y:start.y+8,buttons:1});
        const edge=await js("(() => {const r=$('tabs').getBoundingClientRect();return{x:r.right-2,y:r.y+r.height/2}})()");
        await run('Input.dispatchMouseEvent',{type:'mouseMoved',...edge,buttons:1});
        await new Promise(resolve=>setTimeout(resolve,120));
        assert(await js("$('tabs').scrollLeft>0"),'Holding the tab at the strip edge must auto-scroll');
        await run('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await run('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await releaseTab(edge);
      }
      await js('for(const tab of dragCheckTabs)if(tabs.has(tab.id))removeTab(tab)');
    }
    await js(`splitLayout=${JSON.stringify(before.split)};selectTab(tabs.get(${JSON.stringify(before.active)}));if(filesOpen!==${before.filesOpen})toggleFiles()`);
    console.log(`${width}px: PASS pointer tab splitting, preview/cancel, three/four panes, limits, stable terminals, save/restore and reordering`);
  };
  const workspaceInteractionChecks = async width => {
    const before = await js('({active:active?.id,groups:[...splitGroups.values()],filesOpen})');
    const pressHandle = async expression => {
      const start = await js(`(() => {const e=${expression};e.scrollIntoView({block:'nearest',inline:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+8,y:start.y+8,buttons:1});
    };
    const hoverWorkspace = async id => {
      const point = await js(`(() => {const row=workspaceEntryFor(${JSON.stringify(id)}).tab.tabRow;row.scrollIntoView({inline:'center'});const r=row.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point,buttons:1});
      await wait(`Boolean(tabDrag?.started && splitLayout?.panes.includes(${JSON.stringify(id)}))`);
    };
    const innerRight = async id => js(`(() => {const r=tabs.get(${JSON.stringify(id)}).view.getBoundingClientRect();return{x:r.x+r.width*.75,y:r.y+r.height*.5}})()`);
    const detachToBar = async id => {
      await pressHandle(`tabs.get(${JSON.stringify(id)}).paneLabel`);
      const end = await js("(() => {const r=document.querySelector('.titlebar').getBoundingClientRect();return{x:r.right-25,y:r.y+r.height/2}})()");
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...end,buttons:1});
      assert(await js(`(() => {
        const slot=tabDropPlaceholder.getBoundingClientRect(), ghost=tabDragGhost.getBoundingClientRect();
        const bar=document.querySelector('.titlebar').getBoundingClientRect();
        return tabDropPlaceholder.parentNode===$('tabs') && tabDropPlaceholder.getAttribute('aria-label').includes('独立标签') &&
          slot.height===30 && slot.top>=bar.top && slot.bottom<=bar.bottom &&
          ghost.height===30 && ghost.top>=bar.top && ghost.bottom<=bar.bottom &&
          tabDragGhost.classList.contains('in-tab-bar') && tabInsertMarker.hidden;
      })()`),'Returning a pane anywhere on the top bar must reserve a tab slot and float a tab on that row');
      await shot(`workspace-return-preview-${await js('uiPreferences.theme')}-${width}.png`);
      await releaseTab(end);
      assert(await js("!tabDropPlaceholder.isConnected && tabDragGhost.hidden && !document.querySelector('.drag-source-pane')"),
        'Dropping must clear the slot, floating tab and source dimming');
    };
    for(const theme of ['dark','light']) {
      const ids=await js(`(async () => {
        if(filesOpen)toggleFiles();splitGroups.clear();splitLayout=undefined;
        uiPreferences.theme='${theme}';applyPreferences();window.workspaceCheckTabs=[];
        for(let i=0;i<4;i++)workspaceCheckTabs.push(await openHost(hosts[i%hosts.length],{force:true,connectNow:false}));
        for(const tab of workspaceCheckTabs)previewListener({type:'session',id:tab.id,status:'ready'});
        window.workspaceCheckTerminals=workspaceCheckTabs.map(tab=>tab.terminal);
        window.workspaceCheckConnects=previewCalls.filter(([type])=>type==='connect').length;
        const [a,b]=workspaceCheckTabs;
        splitLayout=installSplitLayout(splitFromTree(layoutState.presetTree([a.id,b.id],'vertical')));
        selectTab(a);return workspaceCheckTabs.map(tab=>tab.id);
      })()`);
      await tick();
      assert(await js('workspaceCheckTabs[0].tabRow.hidden===false && workspaceCheckTabs[1].tabRow.hidden===true && workspaceEntryFor(workspaceCheckTabs[0].id).panes.length===2'),
        'Two panes must appear as one workspace tab');
      let end=await beginTabDrag(ids[2],ids[0],'right-inner');
      assert(await js("getComputedStyle(workspaceCheckTabs[0].surface).cursor==='grabbing' && document.body.classList.contains('tab-drag-active')"),
        'Dragging over the terminal must keep a grabbing cursor and prevent text selection');
      assert(await js("!tabDropPreview.hidden && tabDropPreview.getAttribute('aria-label').includes('右侧')"),
        'The right half of the upper pane must offer a nested drop, away from the outer edge');
      await shot(`workspace-nested-preview-${theme}-${width}.png`);
      await releaseTab(end);
      assert(await js("splitLayout.tree.axis==='row' && splitLayout.tree.first.axis==='column' && splitLayout.tree.second.id===workspaceCheckTabs[1].id && splitLayout.panes.length===3"),
        'A vertical split must accept a third pane at the upper right while preserving the lower pane');
      assert(await js('workspaceEntries().filter(entry=>entry.panes.some(id=>workspaceCheckTabs.slice(0,3).some(tab=>tab.id===id))).length===1'),
        'All three panes must share exactly one top-level tab');
      await overflow();await shot(`workspace-nested-${theme}-${width}.png`);
      // Moving an existing member collapses its former branch. Feedback must
      // stay inside the pane under the pointer, rather than its future position.
      end=await beginTabDrag(ids[2],ids[0],'right-inner');
      end=await innerRight(ids[0]);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...end,buttons:1});
      await tick();
      const memberFeedback=await js(`(() => {
        const target=workspaceCheckTabs[0].view.getBoundingClientRect(), preview=tabDropPreview.getBoundingClientRect();
        return {target:target.toJSON(),preview:preview.toJSON(),kind:tabDrag?.kind,point:{x:tabDrag.x,y:tabDrag.y},edge:tabDropAt(tabDrag.x,tabDrag.y,tabDrag)?.edge,opacity:getComputedStyle(workspaceCheckTabs[2].view).opacity,
          hidden:tabDropPreview.hidden,reason:tabDropPreview.textContent,valid:preview.left>=target.left+target.width/2 && preview.right<=target.right-4 &&
          Math.abs(preview.top-target.top-5)<1 && Math.abs(preview.bottom-target.bottom+5)<1 &&
          getComputedStyle(workspaceCheckTabs[2].view).opacity==='0.4'};
      })()`);
      assert(memberFeedback.valid,`Moving an existing nested pane must highlight only the current target half and dim its source: ${JSON.stringify(memberFeedback)}`);
      await shot(`workspace-member-preview-${theme}-${width}.png`);
      await run('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await run('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await releaseTab(end);
      await detachToBar(ids[2]);
      assert(await js('active===workspaceCheckTabs[2] && !splitGroupFor(active.id) && !active.tabRow.hidden && splitGroupFor(workspaceCheckTabs[0].id).panes.length===2'),
        'Dragging a pane header back to the bar must restore an independent tab without closing it');
      // Start on the active standalone tab, hover its destination workspace, then reinsert it.
      await pressHandle(`workspaceCheckTabs[2].tabRow.querySelector('.tab-open')`);
      await hoverWorkspace(ids[0]);
      end=await innerRight(ids[0]);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...end,buttons:1});
      await releaseTab(end);
      assert(await js('splitLayout.panes.length===3 && active===workspaceCheckTabs[2]'),
        'Hovering another workspace must reveal it without canceling the drag');
      // Keep two independent workspaces, then merge the second workspace as a subtree.
      await js(`splitLayout=installSplitLayout(splitFromTree(layoutState.presetTree([${JSON.stringify(ids[2])},${JSON.stringify(ids[3])}],'vertical')));selectTab(workspaceCheckTabs[3])`);
      await tick();
      assert(await js('splitGroups.size===2 && splitGroupFor(workspaceCheckTabs[0].id).panes.length===2 && splitGroupFor(workspaceCheckTabs[2].id).panes.length===2'),
        'Creating a second workspace must keep the first workspace intact');
      await pressHandle(`workspaceEntryFor(${JSON.stringify(ids[2])}).tab.tabRow.querySelector('.tab-open')`);
      assert(await js("tabDrag.kind==='group' && tabDrag.panes.length===2"),'A workspace tab must drag its entire subtree');
      await hoverWorkspace(ids[0]);end=await innerRight(ids[0]);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...end,buttons:1});await releaseTab(end);
      assert(await js('splitGroups.size===1 && splitLayout.panes.length===4 && new Set(splitLayout.panes).size===4'),
        'Merging two workspaces must retain all four distinct sessions in one tab');
      assert(await js("workspaceCheckTabs.every((tab,i)=>tab.terminal===workspaceCheckTerminals[i]) && previewCalls.filter(([type])=>type==='connect').length===workspaceCheckConnects"),
        'Grouping, hovering, merging and detaching must preserve every terminal and connection');
      await detachToBar(ids[3]);
      await js('closeWorkspaceTab(workspaceCheckTabs[0])');
      assert(await js('workspaceCheckTabs.slice(0,3).every(tab=>!tabs.has(tab.id)) && tabs.has(workspaceCheckTabs[3].id)'),
        'Closing a workspace tab must close its members while preserving a detached session');
      await js('for(const tab of workspaceCheckTabs)if(tabs.has(tab.id))removeTab(tab)');
    }
    await js(`splitGroups.clear();for(const group of ${JSON.stringify(before.groups)})splitGroups.set(group.id,group);splitLayout=undefined;selectTab(tabs.get(${JSON.stringify(before.active)}));if(filesOpen!==${before.filesOpen})toggleFiles()`);
    console.log(`${width}px: PASS grouped workspace tabs, upper-right nesting, grabbing cursor, detach/return, hover switching, subtree merge and grouped close`);
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
  const hostOrderChecks = async width => {
    const orderJS = code => js(`(async()=>{${code}})()`);
    const connectionsBefore = await js("previewCalls.filter(([t])=>t==='connect').length");
    await orderJS(`window.orderOriginal=structuredClone({hosts:previewHosts,groups:previewGroups,preferences:previewPreferences});
      previewGroups.splice(0,previewGroups.length,{id:'oa',name:'A'},{id:'ob',name:'B'},{id:'oc',name:'Child',parentId:'oa'});
      previewHosts.splice(0,previewHosts.length,...[10,2,1].map(n=>({id:'oh'+n,name:'node'+n,address:'node'+n+'.test',username:'ops',port:22,auth:'agent',groupId:'oa',group:'A',tags:['qa']})));
      previewPreferences={...previewPreferences,hostSort:'recent',groupSort:'name-asc'};
      selectTab(undefined,'hosts');currentGroup='A';await refreshHosts();
      $('host-sort').click();[...hostMenu.panel.querySelectorAll('[role=menuitemradio]')].find((b,i)=>i>2&&b.textContent==='名称升序').click()`);
    await wait("!hostSortBusy && uiPreferences.hostSort==='name-asc'");
    const visible = () => js("[...$('host-list').querySelectorAll('.host-open')].map(b=>b.dataset.hostId)");
    assert.deepEqual(await visible(),['oh1','oh2','oh10']);
    await orderJS("$('host-sort').click();[...hostMenu.panel.querySelectorAll('[role=menuitemradio]')].at(-1).click()");
    await wait("!hostSortBusy && uiPreferences.hostSort==='manual'");
    for (const layout of ['cards','rows','tree']) {
      await orderJS(`$('host-layout').value='${layout}';$('host-layout').dispatchEvent(new Event('change'));currentGroup='A';expandedHostGroups.add('oa');renderHosts()`);
      const start = await js("(() => {const h=document.querySelector('[data-order-id=oh10] .host-order-handle');h.scrollIntoView({block:'nearest'});const r=h.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+8,y:start.y+8,buttons:1});
      const end = await js(`(() => {const target=document.querySelector('[data-order-id=oh1]');target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();return{x:r.x+(${JSON.stringify(layout)}==='cards'?3:r.width/2),y:r.y+Math.min(12,r.height/3)}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...end,buttons:1});
      if (!await js('!orderMarker.hidden')) {
        await shot(`host-sort-drag-failure-${width}-${layout}.png`);
        throw new Error(JSON.stringify({width,layout,start,end,state:await js(`({drag:orderDrag?{started:orderDrag.started,ids:orderDrag.nextIds,x:orderDrag.x,y:orderDrag.y}:null,hit:document.elementFromPoint(${end.x},${end.y})?.outerHTML.slice(0,400),library:$('host-library').getBoundingClientRect().toJSON()})`)}));
      }
      await run('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button:'left',clickCount:1});
      await wait('!hostSortBusy && !orderDrag');
      assert.deepEqual(await visible(),['oh10','oh1','oh2']);
      assert.equal(await js("previewCalls.filter(([t])=>t==='connect').length"),connectionsBefore,'Reordering must not connect');
      await orderJS("await moveHostOrder('host',hosts.find(h=>h.id==='oh10'),2)");
      assert.deepEqual(await visible(),['oh1','oh2','oh10']);
      await overflow();
    }
    await orderJS("$('host-search').value='node';renderHosts()");
    assert(await js("[...$('host-list').querySelectorAll('.host-order-handle')].filter(h=>h.closest('[data-order-kind=host]')).every(h=>h.disabled)"));
    await orderJS("$('host-search').value='';$('tag-filter').value='qa';renderHosts()");
    assert(await js("[...$('host-list').querySelectorAll('.host-order-handle')].every(h=>h.disabled)"));
    await orderJS("$('tag-filter').value='';renderHosts();window.previewOrderFailure=true;await moveHostOrder('host',hosts.find(h=>h.id==='oh10'),0);window.previewOrderFailure=false");
    assert.deepEqual(await visible(),['oh1','oh2','oh10'],'Failed save must keep previous positions');
    await orderJS("await saveHostOrder('host','name-desc');await saveHostOrder('host','manual')");
    assert.deepEqual(await visible(),['oh1','oh2','oh10'],'Returning to manual restores the saved order');
    await orderJS("await saveHostOrder('group','manual',window.hostTree.scopes(orderedHostTree(),'group'));await moveHostOrder('group',groupAssets.find(g=>g.id==='ob'),0)");
    await tick();await js("$('host-sort').click()");
    assert(await js("Boolean(hostMenu?.panel.querySelector('[role=menuitemradio]'))"));
    await overflow();await shot(`host-sort-${width}.png`);
    await orderJS("closeHostMenu();renderHosts()");
    assert.deepEqual(await js("orderedHostTree().groups.map(b=>b.group.id)"),['ob','oa']);
    assert.equal(await js("groupAssets.find(g=>g.id==='oc').parentId"),'oa');
    // Exercise keyboard movement on the real handle without changing tree navigation.
    await orderJS("const h=document.querySelector('[data-order-id=oh10] .host-order-handle');h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}))");
    await wait('!hostSortBusy');
    assert.deepEqual(await visible(),['oh1','oh10','oh2']);
    await orderJS(`previewHosts.splice(0,previewHosts.length,...orderOriginal.hosts);previewGroups.splice(0,previewGroups.length,...orderOriginal.groups);previewPreferences=orderOriginal.preferences;
      currentGroup='';$('host-layout').value='cards';$('host-layout').dispatchEvent(new Event('change'));await refreshHosts()`);
    console.log(`${width}px: PASS natural sorting, independent group order, three-view drag, keyboard movement, filters, persistence and failed-save recovery`);
  };
  const sharedUiChecks = async width => {
    await js(`(async()=>{await viewPreferencesSave;window.settingsOriginal=structuredClone(previewPreferences);selectTab(undefined,'hosts');openSettings('preferences')})()`);
    await wait("Boolean($('settings-page').querySelector('[aria-label=\"应用主题\"]'))");
    await js("$('settings-page').querySelector('[aria-label=\"应用主题\"]').click()");
    const wide = await js("(()=>{const t=$('settings-page').querySelector('[aria-label=\"应用主题\"]'),p=document.querySelector('.dropdown-panel[role=listbox]');return{trigger:t.getBoundingClientRect().toJSON(),panel:p.getBoundingClientRect().toJSON()}})()");
    assert(Math.abs(wide.trigger.width-wide.panel.width)<=1 && Math.abs(wide.trigger.left-wide.panel.left)<=1,'Wide menus must match their trigger');
    await shot(`dropdown-width-${width}.png`);
    await js("closeDropdown();selectTab(undefined,'hosts');$('host-layout').closest('.dropdown').querySelector('button').click()");
    const narrow=await js("(()=>{const t=$('host-layout').closest('.dropdown').querySelector('button'),p=document.querySelector('.dropdown-panel[role=listbox]');return[t.getBoundingClientRect().width,p.getBoundingClientRect().width,p.getBoundingClientRect().left,p.getBoundingClientRect().right,innerWidth]})()");
    assert(narrow[1]>=176 && narrow[1]>narrow[0] && narrow[2]>=8 && narrow[3]<=narrow[4]-8,'Compact menus must expand for readability and remain inside the window');
    assert(await js("[...document.querySelectorAll('.dropdown-panel[role=listbox] .dropdown-text > span')].every(s=>s.getClientRects().length===1)"),'Short options must stay on one line in compact menus');
    await js("closeDropdown();$('tag-filter').closest('.dropdown').querySelector('button').click()");
    const tagBounds=await js("(()=>{const t=$('tag-filter').closest('.dropdown').querySelector('button'),p=document.querySelector('.dropdown-searchable'),s=p.querySelector('input');return{trigger:t.getBoundingClientRect().width,panel:p.getBoundingClientRect().width,search:s.getBoundingClientRect().width,left:p.getBoundingClientRect().left,right:p.getBoundingClientRect().right,viewport:innerWidth,shortLabels:[...p.querySelectorAll('.dropdown-option .dropdown-text > span')].filter(s=>s.textContent==='全部标签').every(s=>s.getBoundingClientRect().height<25)}})()");
    assert(tagBounds.panel>=280 && tagBounds.panel>tagBounds.trigger && tagBounds.search>=240 && tagBounds.left>=8 && tagBounds.right<=tagBounds.viewport-8 && tagBounds.shortLabels,
      `Tag search and options must remain readable: ${JSON.stringify(tagBounds)}`);
    await overflow();await shot(`toolbar-tag-menu-${width}.png`);await js('closeDropdown()');
    const styles=await js("[$('tag-filter').closest('.dropdown').querySelector('button'),$('host-sort'),$('host-layout').closest('.dropdown').querySelector('button')].map(b=>{const s=getComputedStyle(b);return{height:b.getBoundingClientRect().height,border:s.borderTopWidth,radius:s.borderRadius,icon:!!b.querySelector('svg.chrome-icon[aria-hidden=true]'),caret:!!b.querySelector('.dropdown-caret[aria-hidden=true]')}})");
    assert(styles.every(s=>s.icon&&s.caret&&s.border==='1px'&&s.radius===styles[0].radius&&Math.abs(s.height-styles[0].height)<=1),'Tag, sort and layout triggers must share icons, carets and dimensions');
    const closedCaret=await js("getComputedStyle($('host-sort').querySelector('.dropdown-caret')).transform");
    for(let click=0;click<2;click++) {
      const point=await js("(()=>{const r=$('host-sort').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()");
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await run('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await tick();
      assert.equal(await js("$('host-sort').getAttribute('aria-expanded')"),String(click===0),'Sort trigger must toggle on repeated real pointer clicks');
      const caret=await js("getComputedStyle($('host-sort').querySelector('.dropdown-caret')).transform");
      if(click===0){assert.notEqual(caret,closedCaret);await overflow();await shot(`toolbar-sort-menu-${width}.png`);}else assert.equal(caret,closedCaret);
    }
    await js(`(async()=>{closeDropdown();await viewPreferencesSave;previewPreferences={...previewPreferences,theme:'light',fontSize:18,hostLayout:'tree',navigationCollapsed:true};await refreshHosts()})()`);
    assert.deepEqual(await js("[document.documentElement.dataset.theme,$('host-layout').value,workspace.dataset.hostLayout,workspace.dataset.navCollapsed]"),['light','tree','tree','true']);
    await js("(async()=>{previewPreferences=settingsOriginal;await refreshHosts()})()");
    await overflow();
    console.log(`${width}px: PASS readable compact dropdowns, aligned toolbar icons/carets, real pointer sort toggling and live appearance/view preferences`);
  };
  if (process.argv.includes('--toolbar-dropdowns-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await sharedUiChecks(width);
    }
    return;
  }
  const inheritanceChecks = async width => {
    await js(`(async()=>{window.inheritOriginalHosts=structuredClone(previewHosts);window.inheritOriginalGroups=structuredClone(previewGroups);
      previewGroups.push({id:'inherit-parent',name:'继承来源测试 / 长名称业务分组',port:2222,identityId:'ops',terminalTheme:'light'},
        {id:'inherit-child',name:'应用子组',parentId:'inherit-parent'});
      previewHosts.push({id:'inherit-layout',name:'集中开关验收',address:'inherit.example.test',port:22,username:'local-user',auth:'agent',groupId:'inherit-child',group:'继承来源测试 / 长名称业务分组 / 应用子组'});
      selectTab(undefined,'hosts');await refreshHosts();void editHost(hosts.find(h=>h.id==='inherit-layout'))})()`);
    await wait("dialog.open && Boolean(dialog.querySelector('.inheritance-row'))");
    await wait("!dialog.getAnimations().some(a=>a.playState==='running')");
    await js("dialog.querySelector('.group-inheritance-options').scrollIntoView({block:'center'})");
    await overflow();await shot(`inheritance-local-${width}.png`);
    await js("dialog.querySelectorAll('.group-inheritance-options input').forEach(input=>input.click())");
    assert.deepEqual(await js("[...dialog.querySelectorAll('.inheritance-value')].map(v=>v.textContent)"),['2222','ops · SSH Agent','浅色']);
    assert(await js("dialog.querySelector('.host-ssh-settings').hidden && [...dialog.querySelectorAll('.inheritance-source')].every(s=>s.textContent==='来自 继承来源测试 / 长名称业务分组')"));
    const columns=await js("[...dialog.querySelectorAll('.inheritance-row .security-switch')].map(e=>e.getBoundingClientRect().right)");
    assert(Math.max(...columns)-Math.min(...columns)<=1,'All switches must align in one column');
    await overflow();await shot(`inheritance-group-${width}.png`);
    await js("dialog.querySelector('[aria-label=\"登录配置跟随分组\"]').focus()");
    await run('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await run('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    assert(await js("!dialog.querySelector('[aria-label=\"登录配置跟随分组\"]').checked && !dialog.querySelector('.host-ssh-settings').hidden && dialog.querySelector('[aria-label=\"端口跟随分组\"]').checked && dialog.querySelector('[aria-label=\"终端配色跟随分组\"]').checked"),'Space must toggle only the focused inheritance setting');
    await js("(()=>{const group=dialog.querySelector('[aria-label=\"分组\"]').closest('.dropdown').querySelector('select');group.value='预发环境';group.dispatchEvent(new Event('change'));dialog.querySelector('[aria-label=\"登录配置跟随分组\"]').click()})()");
    assert.deepEqual(await js("[...dialog.querySelectorAll('.inheritance-value')].slice(0,2).map(v=>v.textContent)"),['22','未设置登录配置']);
    assert(await js("dialog.querySelector('.inheritance-unavailable .inheritance-source').textContent.includes('关闭跟随') && dialog.querySelector('.inheritance-source').textContent==='系统默认'"));
    await overflow();await shot(`inheritance-fallback-${width}.png`);
    await js("(async()=>{dialog.close();previewHosts.splice(0,previewHosts.length,...inheritOriginalHosts);previewGroups.splice(0,previewGroups.length,...inheritOriginalGroups);await refreshHosts()})()");
    console.log(`${width}px: PASS centralized inheritance switch alignment, parent sources, defaults, independent keyboard toggles and missing-login hint`);
  };
  if (process.argv.includes('--inheritance-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await inheritanceChecks(width);
    }
    return;
  }
  const hostLoginChecks = async width => {
    await wait('!dialog.open && !dialog.childElementCount');
    await js("window.loginOriginal={hasPassword:api.hosts.hasPassword,revealPassword:api.hosts.revealPassword,save:api.hosts.save};window.loginRevealCalls=0;api.hosts.hasPassword=async()=>true;api.hosts.revealPassword=async()=>{loginRevealCalls++;return 'disposable saved login password'};selectTab(undefined,'hosts');currentGroup='';void editHost()");
    await wait("dialog.open && dialog.querySelector('.host-auth-switch')");
    assert(await js("dialog.querySelector('.host-auth-switch select').value==='password' && !dialog.querySelector('.host-password-pane').hidden"),'New hosts must default to username/password');
    assert(await js("(()=>{const p=dialog.querySelector('.password-control'),s=dialog.querySelector('.host-auth-switch');return s.getBoundingClientRect().top>=p.getBoundingClientRect().bottom&&p.contains(dialog.querySelector('.password-visibility'))})()"),'Auth switching must sit below the credentials, with the eye inside the password field');
    await js("dialog.querySelector('.password-control input[type=password]').value='disposable new password';dialog.querySelector('.password-control input[type=password]').dispatchEvent(new Event('input'));dialog.querySelector('.password-visibility').click()");
    assert(await js("dialog.querySelector('.password-control input:not([readonly])').type==='text' && dialog.querySelector('.password-visibility').getAttribute('aria-pressed')==='true'"));
    await js("window.dispatchEvent(new Event('blur'))");
    assert.equal(await js("dialog.querySelector('.password-control input:not([readonly])').type"),'password','Blur must conceal newly typed passwords');
    await js("dialog.querySelector('[aria-label=\"认证方式\"]').click()");
    assert(await js("[...document.querySelectorAll('.dropdown-panel [role=option]')].some(o=>o.textContent.includes('本机私钥'))"));
    await js("[...document.querySelectorAll('.dropdown-panel [role=option]')].find(o=>o.textContent.includes('本机私钥')).click()");
    assert(await js("dialog.querySelector('.host-password-pane').hidden && !dialog.querySelector('.host-key-selection').parentElement.hidden"));
    await js("dialog.querySelector('.host-auth-switch select').value='agent';dialog.querySelector('.host-auth-switch select').dispatchEvent(new Event('change'))");
    assert(await js("dialog.querySelector('.host-password-pane').hidden && !dialog.querySelector('.host-agent-hint').hidden"));
    await js("dialog.close()");await wait('!dialog.open && !dialog.childElementCount');
    await js("window.loginHost={...hosts[0],id:'saved-login-test',group:'',groupId:undefined,identityId:undefined,inheritIdentity:false,auth:'password'};void editHost(loginHost)");
    await wait("dialog.open && dialog.querySelector('.password-control')");
    assert.equal(await js('loginRevealCalls'),0,'Opening an editor must not read a saved password');
    assert(await js("dialog.querySelector('.password-control input:not([readonly])').value==='' && /^•+$/.test(dialog.querySelector('.password-control input:not([readonly])').placeholder)"),'Stored passwords use a mask placeholder without populating the draft');
    const passwordBounds=await js("(()=>{const r=dialog.querySelector('.password-control input:not([readonly])').getBoundingClientRect();return[r.width,r.height]})()");
    await js("dialog.querySelector('.password-visibility').click()");
    await wait("!dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').hidden");
    assert(await js("dialog.querySelector('.password-control input:not([readonly])').hidden && dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').value==='disposable saved login password' && dialog.querySelector('.password-control input:not([readonly])').value===''") );
    assert.deepEqual(await js("(()=>{const r=dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').getBoundingClientRect();return[r.width,r.height]})()"),passwordBounds,'Stored reveal must replace the mask in place');
    await overflow();await shot(`host-login-eye-${width}.png`);
    await js("window.dispatchEvent(new Event('blur'))");
    assert(await js("dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').hidden && !dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').value"));
    await js("api.hosts.revealPassword=()=>new Promise(resolve=>window.finishLoginReveal=resolve);dialog.querySelector('.password-visibility').click()");
    await wait('Boolean(window.finishLoginReveal)');
    await js("(()=>{const u=[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='SSH 用户名').querySelector('input');u.value='different-target';u.dispatchEvent(new Event('input'));finishLoginReveal('late saved secret')})()");
    await tick();
    assert(await js("dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').hidden && !dialog.querySelector('[aria-label=\"已保存的 SSH 密码\"]').value"),'A late saved-password response must be discarded after a target change');
    await js("(()=>{const u=[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='SSH 用户名').querySelector('input');u.value=loginHost.username;u.dispatchEvent(new Event('input'));api.hosts.save=async value=>{window.loginSave=value;return hosts};dialog.querySelector('button[value=save]').click()})()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js('loginSave.localPassword===undefined'),true,'Viewing a saved password must not replace it when saving');
    await js("api.hosts.hasPassword=loginOriginal.hasPassword;api.hosts.revealPassword=loginOriginal.revealPassword;api.hosts.save=loginOriginal.save;void editHost({...hosts[0],auth:'key',keyPath:'/preview/key'})");
    await wait("dialog.open && dialog.querySelector('.host-auth-switch')");
    assert.equal(await js("dialog.querySelector('.host-auth-switch select').value"),'key','Editing must retain an existing authentication method');
    await js('dialog.close()');await wait('!dialog.open && !dialog.childElementCount');
    console.log(`${width}px: PASS compact username/password layout, auth switching, masked saved password, in-place eye reveal, blur/late-response conceal and save preservation`);
  };
  const closeAllChecks = async width => {
    await js("for(const tab of [...tabs.values()])removeTab(tab);window.closeAllOriginal={ssh:api.ssh.close,commands:api.commands.close};window.closeAllCalls=[];api.ssh.close=async id=>closeAllCalls.push(['shell',id]);api.commands.close=async id=>closeAllCalls.push(['command',id]);");
    await js("(async()=>{window.closeOne=await openHost(hosts[0],{force:true,connectNow:false})})()");
    assert(await js("$('close-all-tabs').hidden"),'The shortcut is hidden for one host');
    await js("(async()=>{window.closeTwo=await openHost(hosts[1],{force:true,connectNow:false});const tab={id:'close-command',kind:'command',sessionId:closeOne.id,host:closeOne.host,action:'disk',status:'closed',used:Date.now(),view:node('section')};tabs.set(tab.id,tab);renderTabs();jobs.set('close-all-job',{id:'close-all-job',sessionId:closeOne.id,status:'committing'})})()");
    assert(await js("!$('close-all-tabs').hidden"),'Multiple host tabs expose the shortcut');
    await js("$('close-all-tabs').click()");await tick();
    assert(await js("tabs.size===3 && closeAllCalls.length===0 && $('status').textContent.includes('文件正在提交')"),'Committing transfers block batch close before any session is closed');
    await js("jobs.get('close-all-job').status='running';$('close-all-tabs').click()");
    await wait("dialog.open && dialog.textContent.includes('关闭所有会话')");
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='取消').click()");await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js('closeAllCalls.length'),0,'Cancelling transfer confirmation keeps all sessions');
    await js("$('close-all-tabs').click()");await wait('dialog.open');
    await js("dialog.querySelector('form').requestSubmit()");await wait('!dialog.open && !dialog.childElementCount && !closingAllTabs');
    assert(await js("tabs.size===0 && splitGroups.size===0 && $('close-all-tabs').hidden && closeAllCalls.length===3 && closeAllCalls[0][0]==='command'"),'Batch close must dispose all snapshot tabs and close commands before host sessions');
    await js("jobs.delete('close-all-job');(async()=>{window.closeOne=await openHost(hosts[0],{force:true,connectNow:false});window.closeTwo=await openHost(hosts[1],{force:true,connectNow:false});api.ssh.close=async()=>{throw new Error('batch close failure')};$('close-all-tabs').click()})()");
    await wait("!closingAllTabs && $('status').textContent.includes('batch close failure')");
    assert(await js("tabs.size===2 && !$('close-all-tabs').disabled"),'A close error retains remaining tabs and enables retry');
    await js("window.closeHold=true;api.ssh.close=async id=>{closeAllCalls.push(['shell',id]);if(closeHold){closeHold=false;await new Promise(resolve=>window.finishBatchClose=resolve)}};$('close-all-tabs').click()");
    await wait('Boolean(window.finishBatchClose)');
    await js("$('close-all-tabs').click();addNewTab();finishBatchClose()");
    await wait('!closingAllTabs');
    assert(await js("tabs.size===1 && [...tabs.values()][0].kind==='new' && $('close-all-tabs').hidden"),'Tabs opened during a pending batch are preserved');
    await js("for(const tab of [...tabs.values()])removeTab(tab);api.ssh.close=closeAllOriginal.ssh;api.commands.close=closeAllOriginal.commands;selectTab(undefined,'hosts')");
    await overflow();
    console.log(`${width}px: PASS close-all visibility, transfer blocking/confirmation, dependent command cleanup, retry and concurrent-tab preservation`);
  };
  if (process.argv.includes('--host-login-tabs-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await hostLoginChecks(width);await closeAllChecks(width);
    }
    return;
  }
  const pointerFocusChecks = async width => {
    await wait('!dialog.open && !dialog.childElementCount');
    await js("selectTab(undefined,'hosts');currentGroup='';renderHosts()");
    const click = async selector => {
      const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await run('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
      await tick();
    };
    const border = selector => js(`(()=>{const s=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return[s.borderTopColor,s.borderTopWidth,s.boxShadow]})()`);
    const noRing = selector => js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).outlineStyle==='none'`);
    const searchBorder = await border('#host-search-form');
    await click('#host-search');
    assert.deepEqual(await border('#host-search-form'),searchBorder,'Mouse focus must not highlight the search frame');
    assert(await noRing('#host-search'));
    await run('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await run('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    assert(await js("document.documentElement.dataset.focusMode==='keyboard' && getComputedStyle(document.activeElement.closest('.tab-search')||document.activeElement).outlineStyle==='solid'"),'Keyboard navigation must retain a visible focus indicator');
    await click('#host-search');
    assert(await noRing('#host-search') && await noRing('#host-search-form'),'A mouse click after keyboard navigation must remove focus rings');
    for (const selector of ['#host-sort','.host-filters [aria-label="筛选标签"]','.host-filters [aria-label="主机视图"]']) {
      const original = await border(selector); await click(selector);
      assert.deepEqual(await border(selector),original,`${selector}: opening must keep the existing border`);
      assert(await noRing(selector));await js('closeHostMenu();closeDropdown()');
    }
    await click('#add-host');
    await wait("dialog.open && dialog.querySelector('.host-ssh-settings') && !dialog.getAnimations().some(a=>a.playState==='running')");
    for (const selector of ['#dialog input[type=text]','#dialog .host-username-control input','#dialog .password-control input[type=password]','#dialog [aria-label="分组"]']) {
      const original = await border(selector);await click(selector);
      assert.deepEqual(await border(selector),original,`${selector}: pointer focus must not add an accent border`);
      assert(await noRing(selector));await js('closeDropdown()');
    }
    await js("dialog.querySelector('details').open=true");
    await click('#dialog textarea');assert(await noRing('#dialog textarea'));
    await js("dialog.close();selectTab(undefined,'keys')");
    await wait("document.querySelector('#keys-page .key-card')");
    await click('#keys-page .key-card');
    assert(await js("getComputedStyle(document.querySelector('#keys-page .key-card[aria-pressed=true]')).boxShadow!=='none'"),'SSH key selection must retain its resource border');
    await js("selectTab(undefined,'hosts')");
    await click('#host-list .host-open');
    assert(await js("getComputedStyle(document.querySelector('#host-list .host-open[aria-pressed=true]').closest('.host-row')).boxShadow!=='none'"),'Host selection must retain its outer resource border');
    await js("openSettings('snippets')");
    await wait("document.querySelector('.command-pin')");
    const pinBorder = await border('.command-pin');await click('.command-pin');
    await wait("!document.querySelector('.command-pin').disabled");
    assert.deepEqual(await border('.command-pin'),pinBorder,'Pinned command state must not add an accent border');
    await js("selectTab(undefined,'hosts')");
    console.log(`${width}px: PASS pointer focus without extra borders, keyboard focus restoration, stable dropdown/input frames and preserved key/host selection`);
  };
  if (process.argv.includes('--pointer-focus-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await pointerFocusChecks(width);
    }
    return;
  }
  const groupDrawerChecks = async width => {
    await wait('!dialog.open && !dialog.childElementCount');
    await js("window.groupDrawerOriginal=structuredClone(previewGroups);selectTab(undefined,'hosts');currentGroup='';renderHosts()");
    const geometry = () => js("['#hosts .toolbar-row','#host-list'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return[r.x,r.y,r.width,r.height]})");
    const before = await geometry();
    const open = async () => {
      await js("$('host-actions').click();[...hostMenu.panel.querySelectorAll('button')].find(b=>b.textContent==='新建分组').click()");
      await wait("dialog.open && dialog.querySelector('[aria-label=\"上级分组\"]') && !dialog.getAnimations().some(a=>a.playState==='running')");
    };
    const groupName = "[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='分组名称').querySelector('input')";
    await open();
    assert.deepEqual(await geometry(),before,'The new-group drawer must float without moving host content');
    assert(await js("workspace.dataset.view==='hosts' && dialog.classList.contains('host-drawer')"));
    await js(`${groupName}.value='unsaved-group';document.querySelector('.overlay-backdrop').click()`);
    await wait("Boolean($('host-discard-dialog')?.open)");
    await js("[...$('host-discard-dialog').querySelectorAll('button')].find(b=>b.textContent==='继续编辑').click()");
    await wait("!$('host-discard-dialog')");
    assert.equal(await js(`${groupName}.value`),'unsaved-group');
    await js(`${groupName}.value='drawer-group';dialog.querySelector('form').requestSubmit()`);
    await wait("!dialog.open && !dialog.childElementCount && currentGroup==='drawer-group'");
    await open();
    assert(await js("dialog.querySelector('[aria-label=\"上级分组\"]').closest('.dropdown').querySelector('select').value===groupAssets.find(g=>g.path==='drawer-group').id"),'New groups inside a group must default to that parent');
    await js("dialog.dispatchEvent(new Event('cancel',{cancelable:true}))");
    await wait('!dialog.open && !dialog.childElementCount');
    await js("currentGroup='';renderHosts();void editHost()");
    await wait("dialog.open && dialog.querySelector('.host-ssh-settings')");
    await js("[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='主机地址').querySelector('input').value='draft.example.test';dialog.querySelector('.host-username-control input').value='draft-user';dialog.querySelector('[aria-label=\"分组\"]').click();document.querySelector('.dropdown-footer button').click()");
    await wait("dialog.open && dialog.querySelector('[aria-label=\"上级分组\"]')");
    assert.equal(await js('workspace.dataset.view'),'hosts');
    await js(`${groupName}.value='draft-created-group';dialog.querySelector('form').requestSubmit()`);
    await wait("dialog.open && dialog.querySelector('.host-ssh-settings')");
    assert.deepEqual(await js("[[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='主机地址').querySelector('input').value,dialog.querySelector('.host-username-control input').value,dialog.querySelector('[aria-label=\"分组\"]').closest('.dropdown').querySelector('select').value]"),['draft.example.test','draft-user','draft-created-group'],'Group creation must return to the original host draft and select the new group');
    await js("dialog.close();previewGroups.splice(0,previewGroups.length,...groupDrawerOriginal);currentGroup='';void refreshHosts()");
    await wait('!dialog.open && !dialog.childElementCount');
    console.log(`${width}px: PASS floating group drawer, stable host layout, dirty close protection, parent defaults and draft-preserving return`);
  };
  const keyImportUiChecks = async width => {
    await groupDrawerChecks(width);
    await wait('!dialog.open && !dialog.childElementCount');
    await js("selectTab(undefined,'hosts');currentGroup='';window.importUiOriginal={importPreview:api.hosts.importPreview,csvPreview:api.hosts.csvPreview,save:api.hosts.save,revealKey:api.hosts.revealKeyPassphrase,create:api.keys.create,importFile:api.keys.importFile};window.importUiKeyCount=previewKeys.length;window.importUiReads=[];api.hosts.importPreview=async()=>{importUiReads.push('openssh');return null};api.hosts.csvPreview=async()=>{importUiReads.push('csv');return null}");
    assert(await js("!document.querySelector('#hosts .toolbar-row > .toolbar-actions:not(.host-filters) .toolbar-button') && Boolean($('host-actions'))"),'Host toolbar must use the compact new-host split button');
    for(const id of ['import-hosts','import-csv']) {
      await js("$('host-actions').click()");
      assert(await js("hostMenu.panel.textContent.includes('新建分组') && hostMenu.panel.textContent.includes('导出 CSV')"));
      await overflow();
      await js(`document.getElementById('${id}').click()`);await tick();
    }
    assert.deepEqual(await js('importUiReads'),['openssh','csv']);
    await js("$('host-actions').click();[...hostMenu.panel.querySelectorAll('button')].find(b=>b.textContent==='新建分组').click()");
    await wait("dialog.open && dialog.classList.contains('host-drawer') && !dialog.getAnimations().some(a=>a.playState==='running')");
    assert.equal(await js("workspace.dataset.view"),'hosts','New group must open above the host workspace');
    await js("dialog.dispatchEvent(new Event('cancel',{cancelable:true}))");
    await wait("!dialog.open && !dialog.childElementCount");
    await js("window.importKeyHost={...hosts[0],id:'import-key-eye',auth:'key',keyPath:'/preview/key',group:'',identityId:undefined,inheritIdentity:false};previewKeySecrets.set(importKeyHost.id,'disposable saved key passphrase');window.importKeyReveals=[];api.hosts.revealKeyPassphrase=async request=>{importKeyReveals.push(request);return 'disposable saved key passphrase'};void editHost(importKeyHost)");
    await wait("dialog.open && dialog.querySelector('.host-key-passphrase') && !dialog.getAnimations().some(a=>a.playState==='running')");
    assert(await js("(()=>{const u=[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='SSH 用户名').querySelector('input'),k=dialog.querySelector('.key-picker-trigger'),p=dialog.querySelector('.host-key-passphrase input[type=password]');return Math.abs(u.getBoundingClientRect().width-k.getBoundingClientRect().width)<1 && Math.abs(u.getBoundingClientRect().width-p.getBoundingClientRect().width)<1 && getComputedStyle(dialog.querySelector('.host-private-key')).borderTopWidth==='0px'})()"),'Private-key selection and passphrase must align with the username and avoid nested frames');
    assert(await js("/^•+$/.test(dialog.querySelector('.host-key-passphrase input[type=password]').placeholder) && importKeyReveals.length===0"));
    await js("dialog.querySelector('.host-key-passphrase .password-visibility').click()");
    await wait("!dialog.querySelector('[aria-label=\"已保存的私钥口令\"]').hidden");
    assert.deepEqual(await js('importKeyReveals[0]'),{id:'import-key-eye',keyPath:'/preview/key'});
    await js("dialog.querySelector('.host-ssh-settings').scrollIntoView({block:'start'})");await tick();
    await overflow();await shot(`private-key-compact-${width}.png`);
    await js("window.dispatchEvent(new Event('blur'));dialog.querySelector('[aria-label=\"认证方式\"]').focus()");
    assert(await js("(()=>{const s=getComputedStyle(dialog.querySelector('[aria-label=\"认证方式\"]'));return s.outlineStyle==='none'&&s.boxShadow==='none'&&s.borderTopColor==='rgba(0, 0, 0, 0)'})()"),'The authentication switch must not draw a selected frame');
    await js("dialog.querySelector('[aria-label=\"认证方式\"]').click()");
    assert(await js("getComputedStyle(dialog.querySelector('[aria-label=\"认证方式\"]')).borderTopColor==='rgba(0, 0, 0, 0)'"));
    await js("closeDropdown();api.hosts.save=async value=>{window.importKeySaved=value;return hosts};dialog.querySelector('button[value=save]').click()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js('importKeySaved.localKeyPassphrase===undefined'),true,'Viewing a passphrase must not save a replacement');
    await js("api.hosts.save=importUiOriginal.save;api.hosts.revealKeyPassphrase=importUiOriginal.revealKey;previewKeySecrets.delete(importKeyHost.id);selectTab(undefined,'keys');api.keys.importFile=async()=>({name:'created-ui-key',privateKey:'disposable private content'});api.keys.create=async request=>{if(request.name==='invalid')throw new Error('私钥内容无效');return importUiOriginal.create(request)}");
    await wait("!document.querySelector('#keys-page .key-toolbar .primary').disabled");
    await js("[...document.querySelectorAll('#keys-page .key-toolbar button')].find(b=>b.textContent==='＋ 创建密钥').click()");
    await wait("dialog.open && dialog.querySelector('[data-key-create=private]') && !dialog.getAnimations().some(a=>a.playState==='running')");
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='从私钥文件导入').click()");
    await wait("dialog.querySelector('[data-key-create=private]').value==='disposable private content'");
    await js("dialog.querySelector('[data-key-create=name]').value='invalid';dialog.querySelector('form').requestSubmit()");
    await wait("dialog.querySelector('.dialog-error').textContent.includes('私钥内容无效')");
    assert.equal(await js("dialog.querySelector('[data-key-create=private]').value"),'disposable private content','Import errors must retain the draft');
    await js("dialog.querySelector('[data-key-create=name]').value='created-ui-key';dialog.querySelector('[data-key-create=passphrase]').value='disposable key passphrase';window.importPrivateField=dialog.querySelector('[data-key-create=private]');window.importPassField=dialog.querySelector('[data-key-create=passphrase]')");
    await js("dialog.querySelector('.drawer-fields').scrollTop=0");await tick();
    await overflow();await shot(`key-create-drawer-${width}.png`);
    await js("dialog.querySelector('form').requestSubmit()");
    await wait("!dialog.open && !dialog.childElementCount && document.querySelector('#keys-page .key-note').textContent.includes('已创建 created-ui-key')");
    assert(await js("!importPrivateField.value && !importPassField.value"),'Private content and passphrase must be cleared after creation');
    await js("selectTab(undefined,'hosts');void editHost()");
    await wait("dialog.open && dialog.querySelector('.host-auth-switch')");
    await js("dialog.querySelector('.host-auth-switch select').value='key';dialog.querySelector('.host-auth-switch select').dispatchEvent(new Event('change'));dialog.querySelector('.key-picker-trigger').click()");
    await wait("$('key-dialog').open && $('key-dialog').querySelector('[data-path=\"/preview/.ssh/created-ui-key\"]')");
    await js("$('key-dialog').querySelector('[data-path=\"/preview/.ssh/created-ui-key\"]').click();$('key-dialog').querySelector('.key-picker-confirm').click()");
    assert.equal(await js("dialog.querySelector('.selected-key-name').textContent"),'created-ui-key','Created keys must be selectable by host editors');
    await js("dialog.close();previewKeys.splice(importUiKeyCount);api.hosts.importPreview=importUiOriginal.importPreview;api.hosts.csvPreview=importUiOriginal.csvPreview;api.keys.create=importUiOriginal.create;api.keys.importFile=importUiOriginal.importFile;selectTab(undefined,'hosts')");
    await wait('!dialog.open && !dialog.childElementCount');
    console.log(`${width}px: PASS compact host actions, borderless auth switching, aligned key/passphrase controls, protected reveal, key creation/file import and host selection`);
  };
  if (process.argv.includes('--key-import-ui-only')) {
    for(const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await keyImportUiChecks(width);
    }
    return;
  }
  const keyCreationChecks = async width => {
    await wait('!dialog.open && !dialog.childElementCount');
    await js("selectTab(undefined,'hosts');currentGroup='';selectedHostId='';$('host-layout').value='cards';$('host-layout').dispatchEvent(new Event('change'));renderHosts()");
    const hover = async selector => {
      const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point}); await tick();
      return js("(()=>{const b=document.querySelector('#host-list .host-open'),row=b.closest('.host-row');return {background:getComputedStyle(row).backgroundColor,button:getComputedStyle(b).backgroundColor,hover:getComputedStyle(document.documentElement).getPropertyValue('--surface-hover').trim()}})()");
    };
    await run('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});await tick();
    const idle = await js("getComputedStyle(document.querySelector('#host-list .host-open').closest('.host-row')).backgroundColor");
    const middle = await hover('#host-list .host-open');
    assert.notEqual(middle.background,idle,'Entering a host card must highlight its outer container');
    assert.equal(middle.button,'rgba(0, 0, 0, 0)','Main card button must not paint a smaller hover block');
    const edge = await hover('#host-list .host-open ~ .host-quick-edit');
    assert.equal(edge.background,middle.background,'Card hover must cover the entire card, including the action area');
    await js("selectTab(undefined,'keys');window.keyTestOriginalGenerate=api.keys.generate;window.keyTestOriginalAddAgent=api.keys.addAgent;api.keys.addAgent=async request=>{previewCalls.push(['add-agent',request]);if(request.passphrase==='incorrect')throw new Error('无法解锁私钥');return {fingerprint:'SHA256:fixture'}};api.keys.generate=async request=>{previewCalls.push(['generate-key',request]);if(request.name==='conflict')throw new Error('已有同名密钥');return {name:request.name,path:request.directory+'/'+request.name,type:request.type}};");
    await wait("!document.querySelector('#keys-page .key-toolbar .primary').disabled");
    const bounds = () => js("['.key-toolbar','.key-directories','.key-grid'].map(s=>{const r=document.querySelector('#keys-page '+s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})");
    const before = await bounds();
    const open = async () => {
      await wait('!dialog.open && !dialog.childElementCount');
      await js("document.querySelector('#keys-page .key-toolbar .primary').click()");
      await wait("dialog.open && dialog.querySelector('[data-key-field=type]') && !dialog.getAnimations().some(a=>a.playState==='running')");
    };
    const setType = value => js(`(()=>{const t=dialog.querySelector('[data-key-field=type]');t.value=${JSON.stringify(value)};t.dispatchEvent(new Event('change'))})()`);
    await open();
    assert.deepEqual(await bounds(),before,'Opening key creation must not move the key page');
    assert(await js("dialog.classList.contains('host-drawer') && !dialog.querySelector('[data-key-field=rsa-bits]').closest('label').getClientRects().length && !dialog.querySelector('[data-key-field=ecdsa-bits]').closest('label').getClientRects().length"),'Ed25519 needs no size configuration');
    await setType('rsa');
    assert.deepEqual(await js("[dialog.querySelector('[data-key-field=name]').value,dialog.querySelector('[data-key-field=rsa-bits]').value]"),['id_rsa_termlume','3072']);
    await js("dialog.querySelector('[aria-label=\"RSA 密钥位数\"]').click()");
    assert(await js("(()=>{const t=dialog.querySelector('[aria-label=\"RSA 密钥位数\"]'),p=document.getElementById(t.getAttribute('aria-controls'));return Math.abs(t.getBoundingClientRect().width-p.getBoundingClientRect().width)<=1})()"),'Size popup must match its trigger width');
    await js('closeDropdown()');await overflow();await shot(`key-generation-rsa-${width}.png`);
    await js("dialog.querySelector('[data-key-field=name]').value='conflict';dialog.querySelector('form').requestSubmit()");
    await wait("dialog.querySelector('.dialog-error').textContent.includes('同名')");
    assert(await js("dialog.open && !dialog.querySelector('button[type=submit]').disabled"),'Generation errors must keep the drawer retryable');
    await js("dialog.querySelector('[data-key-field=name]').value='rsa-probe';dialog.querySelector('[data-key-field=rsa-bits]').value='4096';dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.deepEqual(await js("previewCalls.filter(([t])=>t==='generate-key').at(-1)[1]"),{directory:'/preview/.ssh',name:'rsa-probe',passphrase:'',type:'rsa',bits:4096});
    await open();await setType('ecdsa');
    assert(await js("dialog.querySelector('[data-key-field=ecdsa-bits]').closest('label').getClientRects().length && !dialog.querySelector('[data-key-field=rsa-bits]').closest('label').getClientRects().length"));
    await js("dialog.querySelector('[data-key-field=ecdsa-bits]').value='521';dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js("previewCalls.filter(([t])=>t==='generate-key').at(-1)[1].bits"),521);
    await open();
    await js("dialog.querySelector('[data-key-field=passphrase]').value='disposable fixture passphrase';dialog.dispatchEvent(new Event('cancel',{cancelable:true}))");
    await wait("document.querySelector('#host-discard-dialog[open]')");
    await js("[...document.querySelectorAll('#host-discard-dialog button')].find(b=>b.textContent==='继续编辑').click()");
    await wait("!document.querySelector('#host-discard-dialog')");
    assert.equal(await js("dialog.querySelector('[data-key-field=passphrase]').value"),'disposable fixture passphrase');
    await js("dialog.dispatchEvent(new Event('cancel',{cancelable:true}))");
    await wait("document.querySelector('#host-discard-dialog[open]')");
    await js("[...document.querySelectorAll('#host-discard-dialog button')].find(b=>b.textContent==='放弃修改').click()");
    await wait('!dialog.open && !dialog.childElementCount');
    await open();await js("dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    assert(await js("!('bits' in previewCalls.filter(([t])=>t==='generate-key').at(-1)[1])"),'Ed25519 requests must omit bits');
    await js("document.querySelector('#keys-page .key-card').click();[...document.querySelectorAll('#keys-page .key-detail button')].find(b=>b.textContent==='加入 SSH Agent').click()");
    await wait("dialog.open && dialog.querySelector('[aria-label=\"要加入 Agent 的私钥\"]')");
    await js("dialog.querySelector('input[type=password]').value='incorrect';dialog.querySelector('form').requestSubmit()");
    await wait("dialog.querySelector('.dialog-error').textContent.includes('解锁')");
    await js("dialog.querySelector('input[type=password]').value='disposable passphrase';dialog.querySelector('form').requestSubmit()");
    await wait("!dialog.open && !dialog.childElementCount && document.querySelector('#keys-page .key-agent-guide').getClientRects().length");
    assert.deepEqual(await js("previewCalls.filter(([t])=>t==='add-agent').at(-1)[1]"),{path:'/preview/key',passphrase:'disposable passphrase'});
    await overflow();await shot(`key-agent-${width}.png`);
    await js("[...document.querySelectorAll('#keys-page .key-toolbar button')].find(b=>b.textContent==='加入 SSH Agent').click()");
    await wait('dialog.open');
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='选择私钥'||b.getAttribute('aria-label')==='选择私钥').click()");
    await wait("$('key-dialog').open && $('key-dialog').querySelector('[role=radio]')");
    await js("$('key-dialog').querySelector('[role=radio]').click();$('key-dialog').querySelector('.key-picker-confirm').click()");
    await wait("!$('key-dialog').open && Boolean(dialog.querySelector('[aria-label=\"要加入 Agent 的私钥\"]').value)");
    await js("dialog.querySelector('form').requestSubmit()");
    await wait('!dialog.open && !dialog.childElementCount');
    await js("api.keys.generate=keyTestOriginalGenerate;api.keys.addAgent=keyTestOriginalAddAgent;selectTab(undefined,'hosts')");
    console.log(`${width}px: PASS full-card hover, floating key creation, algorithm/size selection, retry, unsaved close confirmation and Agent loading`);
  };
  const keyAutoAgentChecks = async (width, creating = false) => {
    await wait('!dialog.open && !dialog.childElementCount');
    await js(`selectTab(undefined,'keys');window.autoKeyOriginal={generate:api.keys.generate,create:api.keys.create,addAgent:api.keys.addAgent};
      window.autoKeyCalls=[];window.autoKeyAgentFailure=false;window.autoKeyGenerateFailure=false;
      api.keys.generate=async value=>{autoKeyCalls.push(['generate',structuredClone(value)]);if(autoKeyGenerateFailure)throw new Error('同名文件');if(window.autoKeyGeneratePending)await new Promise(resolve=>window.autoKeyResolveGenerate=resolve);return {name:value.name,path:value.directory+'/'+value.name,type:value.type}};
      api.keys.create=async value=>{autoKeyCalls.push(['create',structuredClone(value)]);if(autoKeyGenerateFailure)throw new Error('同名文件');if(window.autoKeyGeneratePending)await new Promise(resolve=>window.autoKeyResolveGenerate=resolve);return {name:value.name,path:value.directory+'/'+value.name,type:'ssh-ed25519',private:true}};
      api.keys.addAgent=async value=>{autoKeyCalls.push(['agent',structuredClone(value)]);if(window.autoKeyAgentPending)await new Promise(resolve=>window.autoKeyResolveAgent=resolve);if(autoKeyAgentFailure)throw new Error('Agent 未运行');return {fingerprint:'SHA256:auto-key'}};`);
    const operation = creating ? 'create' : 'generate';
    const attribute = creating ? 'key-create' : 'key-field';
    const field = key => `dialog.querySelector('[data-${attribute}=${key}]')`;
    const open = async () => {
      await wait('!dialog.open && !dialog.childElementCount');
      await js(creating ? "[...document.querySelectorAll('#keys-page .key-toolbar button')].find(b=>b.textContent==='＋ 创建密钥').click()" : "document.querySelector('#keys-page .key-toolbar .primary').click()");
      await wait(`dialog.open && ${field('add-agent')} && !dialog.getAnimations().some(a=>a.playState==='running')`);
      if (creating) await js(`${field('name')}.value='auto-created';${field('private')}.value='disposable private content'`);
    };
    const submit = () => js("dialog.querySelector('form').requestSubmit()");
    await open();
    assert.equal(await js(`${field('add-agent')}.checked`),false,'Auto Agent loading must be opt-in');
    await js(`${field('name')}.value='auto-unchecked';`);await submit();
    await wait('!dialog.open && !dialog.childElementCount');
    assert.deepEqual(await js('autoKeyCalls.map(([type])=>type)'),[operation],'Unchecked key saving must not touch the Agent');
    await open();
    await js(`${field('add-agent')}.click();dialog.dispatchEvent(new Event('cancel',{cancelable:true}))`);
    await wait("document.querySelector('#host-discard-dialog[open]')");
    await js("[...document.querySelectorAll('#host-discard-dialog button')].find(b=>b.textContent==='继续编辑').click()");
    await wait("!document.querySelector('#host-discard-dialog')");
    assert(await js(`${field('add-agent')}.checked`),'Continue must preserve the auto-load option');
    await js(`${field('name')}.value='auto-encrypted';${field('passphrase')}.value='disposable auto key passphrase';window.autoKeyGeneratePending=true;window.autoKeyAgentPending=true;`);
    await submit();await wait('Boolean(window.autoKeyResolveGenerate)');
    await js(`${field('passphrase')}.value='changed while generating';${field('add-agent')}.checked=false;window.autoKeyGeneratePending=false;autoKeyResolveGenerate()`);
    await wait('Boolean(window.autoKeyResolveAgent)');
    assert.deepEqual(await js('autoKeyCalls.at(-1)'),['agent',{path:'/preview/.ssh/auto-encrypted',passphrase:'disposable auto key passphrase'}],'Auto loading must use the actual generated key and original passphrase');
    await js("dialog.dispatchEvent(new Event('cancel',{cancelable:true}));dialog.querySelector('form').requestSubmit()");
    assert(await js("dialog.open && dialog.querySelector('form').getAttribute('aria-busy')==='true'"),'Agent loading must block closing and duplicate submission');
    assert.equal(await js("autoKeyCalls.filter(([t])=>t==='agent').length"),1);
    await js('window.autoKeyAgentPending=false;autoKeyResolveAgent()');
    await wait("!dialog.open && !dialog.childElementCount && document.querySelector('#keys-page .key-note').textContent.includes('并已加入 SSH Agent')");
    await open();
    await js(`${field('name')}.value='auto-generate-failure';${field('add-agent')}.checked=true;autoKeyGenerateFailure=true`);await submit();
    await wait("dialog.querySelector('.dialog-error').textContent.includes('同名文件')");
    assert.equal(await js("autoKeyCalls.filter(([t])=>t==='agent').length"),1,'Failed generation must not try adding a key');
    await js(`autoKeyGenerateFailure=false;autoKeyAgentFailure=true;${field('name')}.value='auto-agent-failure';${field('passphrase')}.value='partial success passphrase';window.autoKeyPasswordField=${field('passphrase')}`);await submit();
    await wait(`dialog.querySelector('.dialog-error').textContent.includes('${creating ? '密钥已创建并保存' : '密钥已生成并保存'}')`);
    const generatedCount = await js(`autoKeyCalls.filter(([t])=>t==='${operation}').length`);
    assert(await js(`dialog.querySelector('.${creating ? 'key-created-summary' : 'key-generated-summary'}').getClientRects().length && !${field('name')}.getClientRects().length && dialog.querySelector('button[type=submit]').textContent==='重试加入 SSH Agent'`),'Partial success must show the saved key and offer an Agent-only retry');
    await overflow();await shot(`key-${operation}-auto-agent-failure-${width}.png`);
    await js('autoKeyAgentFailure=false');await submit();
    await wait('!dialog.open && !dialog.childElementCount');
    assert.equal(await js(`autoKeyCalls.filter(([t])=>t==='${operation}').length`),generatedCount,'Retry must never regenerate an already saved key');
    assert.equal(await js('autoKeyPasswordField.value'),'','Finishing must clear the retained passphrase field');
    await open();
    await js(`${field('name')}.value='auto-complete-partial';${field('add-agent')}.checked=true;autoKeyAgentFailure=true`);await submit();
    await wait("dialog.querySelector('.dialog-error').textContent.includes('Agent 未运行')");
    await js("[...dialog.querySelectorAll('.actions button')].find(b=>b.textContent==='完成').click()");
    await wait("!dialog.open && !dialog.childElementCount && document.querySelector('#keys-page .key-note').textContent.includes('尚未加入 SSH Agent')");
    assert(!await js("document.querySelector('#host-discard-dialog')"),'Saved keys must remain usable when Agent loading is skipped after failure');
    await js('api.keys.generate=autoKeyOriginal.generate;api.keys.create=autoKeyOriginal.create;api.keys.addAgent=autoKeyOriginal.addAgent;selectTab(undefined,\'hosts\')');
    console.log(`${width}px: PASS opt-in ${operation}-and-load, original passphrase reuse, busy guard, generation failure, Agent-only retry and saved-key completion`);
  };
  if (process.argv.includes('--key-creation-only') || process.argv.includes('--key-auto-agent-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      if (process.argv.includes('--key-creation-only')) await keyCreationChecks(width);
      await keyAutoAgentChecks(width);await keyAutoAgentChecks(width,true);
    }
    return;
  }
  const drawerDismissChecks = async width => {
    const clickBackdrop = async () => {
      const point=await js("({x:6,y:document.querySelector('.titlebar').getBoundingClientRect().bottom+12})");
      await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await run('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await run('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
      await tick();
    };
    const field = label => `[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent===${JSON.stringify(label)}).querySelector('input')`;
    const open = async expression => { await wait('!dialog.open && !dialog.childElementCount');await js(`selectTab(undefined,'hosts');currentGroup='';void ${expression}`);await wait('dialog.open');await wait("!dialog.getAnimations().some(a=>a.playState==='running')"); };
    await open('editHost()');await clickBackdrop();await wait('!dialog.open');
    await open('editHost(hosts[0])');await clickBackdrop();await wait('!dialog.open');
    await open('editHost(hosts[0])');
    const savesBefore=await js("previewCalls.filter(([type])=>type==='save-host').length");
    await js(`(()=>{const name=${field('显示名称')};name.value='unsaved-edit';name.dispatchEvent(new Event('input'))})()`);
    await clickBackdrop();await wait("Boolean($('host-discard-dialog')?.open)");
    assert(await js("dialog.open && dialog.inert && workspace.inert && $('host-discard-dialog').getAttribute('role')==='alertdialog'"));
    await clickBackdrop();
    assert.equal(await js("document.querySelectorAll('#host-discard-dialog[open]').length"),1,'Repeated backdrop clicks must keep one confirmation open');
    await overflow();await shot(`drawer-discard-confirm-${width}.png`);
    await js("[...$('host-discard-dialog').querySelectorAll('button')].find(b=>b.textContent==='继续编辑').click()");
    await wait("!$('host-discard-dialog') && !dialog.inert");
    assert.equal(await js(`${field('显示名称')}.value`),'unsaved-edit','Continuing editing must retain the draft');
    await js("dialog.querySelector('[aria-label=\"关闭主机表单\"]').click()");await wait("Boolean($('host-discard-dialog')?.open)");
    await run('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await run('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await wait("!$('host-discard-dialog') && dialog.open");
    await js("[...dialog.querySelector('form > .actions').querySelectorAll('button')].find(b=>b.textContent==='取消').click()");
    await wait("Boolean($('host-discard-dialog')?.open)");
    await js("[...$('host-discard-dialog').querySelectorAll('button')].find(b=>b.textContent==='放弃修改').click()");await wait('!dialog.open');
    assert.equal(await js("previewCalls.filter(([type])=>type==='save-host').length"),savesBefore,'Discarding must not save host data');
    await open('editHost()');
    await js("dialog.querySelector('.credential-row input[type=password]').value='draft-only-password'");
    await clickBackdrop();await wait("Boolean($('host-discard-dialog')?.open)");
    await js("[...$('host-discard-dialog').querySelectorAll('button')].find(b=>b.textContent==='继续编辑').click()");await wait("!$('host-discard-dialog')");
    assert.equal(await js("dialog.querySelector('.credential-row input[type=password]').value"),'draft-only-password','Cancelling close must retain an unsaved credential');
    await js("dialog.querySelector('.credential-row input[type=password]').value=''");await clickBackdrop();await wait('!dialog.open');
    await open("editHost({...hosts[0],auth:'key',keyPath:'/preview/key'})");
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='选择私钥'||b.getAttribute('aria-label')==='选择私钥').click()");await wait("$('key-dialog').open");
    await clickBackdrop();
    assert(await js("dialog.open && $('key-dialog').open && !$('host-discard-dialog')"),'A nested picker must shield the host drawer from backdrop dismissal');
    await js("[...$('key-dialog').querySelectorAll('button')].find(b=>b.textContent==='关闭').click();dialog.close()");await wait('!dialog.open');
    await open('editHost()');
    await js(`(()=>{${field('主机地址')}.value='busy.example.test';${field('SSH 用户名')}.value='busy-user';const auth=dialog.querySelector('[aria-label="认证方式"]').closest('.dropdown').querySelector('select');auth.value='agent';auth.dispatchEvent(new Event('change'));window.dismissSaveApi=api.hosts.save;api.hosts.save=()=>new Promise(resolve=>{window.finishDismissSave=()=>resolve(previewHosts)});dialog.querySelector('button[value=save]').click()})()`);
    await wait("dialog.querySelector('form').getAttribute('aria-busy')==='true'");await clickBackdrop();
    assert(await js("dialog.open && !$('host-discard-dialog')"),'Saving must block dismissal through the backdrop');
    await js("api.hosts.save=dismissSaveApi;finishDismissSave()");await wait('!dialog.open');
    console.log(`${width}px: PASS backdrop dismissal, dirty confirmation/continue/discard, close/Escape consistency, unsaved credentials, nested picker and busy-save protection`);
  };
  if (process.argv.includes('--drawer-dismiss-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await drawerDismissChecks(width);
    }
    return;
  }
  const hostFormChecks = async width => {
    await js("selectTab(undefined,'hosts');currentGroup='';void editHost()");
    await wait("dialog.open && Boolean(dialog.querySelector('.host-ssh-settings'))");
    await wait("!dialog.getAnimations().some(a=>a.playState==='running')");
    assert.equal(await js('Math.round(dialog.getBoundingClientRect().width)'),480,'Host drawer should provide a wider editing area');
    await js("dialog.querySelector('[aria-label=\"连接路径\"]').closest('details').open=true");
    for (const label of ['分组','认证方式','登录配置','连接路径']) {
      const selector = `dialog [aria-label="${label}"]`;
      for (let click = 0; click < 4; click++) {
        const point = await js(`(()=>{const t=document.querySelector(${JSON.stringify(selector)});t.scrollIntoView({block:'center'});const r=t.getBoundingClientRect();return{x:${click%2 ? 'r.right-14' : 'r.left+30'},y:r.top+r.height/2}})()`);
        await run('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
        await run('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
        await run('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
        await tick();
        assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`),String(click%2===0),`${label}: repeated real pointer clicks must toggle the menu`);
        if (click%2===0) {
          const bounds = await js(`(()=>{const t=document.querySelector(${JSON.stringify(selector)}),p=document.getElementById(t.getAttribute('aria-controls'));return[t.getBoundingClientRect().width,p.getBoundingClientRect().width,t.getBoundingClientRect().left,p.getBoundingClientRect().left]})()`);
          assert((label==='认证方式' ? bounds[1]>=Math.max(bounds[0],176)-1 : Math.abs(bounds[0]-bounds[1])<=1)
            && Math.abs(bounds[2]-bounds[3])<=1,`${label}: form menus must align, allowing the compact authentication switch to expand for readability`);
          await overflow();
          if (click===0) await shot(`host-form-${label}-${width}.png`);
        }
      }
    }
    await js("dialog.querySelector('[aria-label=\"分组\"]').scrollIntoView({block:'center'});dialog.querySelector('[aria-label=\"分组\"]').click()");
    const createPoint = await js("(()=>{const b=document.querySelector('.dropdown-footer button'),r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await run('Input.dispatchMouseEvent',{type:'mouseMoved',...createPoint});
    await run('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...createPoint});
    await run('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...createPoint});
    await wait("dialog.open && dialog.querySelector('h2').textContent==='新建分组'");
    assert.equal(await js("workspace.dataset.view"),'hosts','Creating a group from a host draft must keep the workspace in place');
    await js("[...dialog.querySelectorAll('button')].find(b=>b.textContent==='返回主机').click()");
    await wait("dialog.open && Boolean(dialog.querySelector('.host-ssh-settings'))");
    await js('dialog.close()'); await tick();
    console.log(`${width}px: PASS 480px host drawer, real pointer dropdown toggles and group drawer return, matching searchable/plain popup widths`);
  };
  const hostSaveChecks = async width => {
    await js(`(async()=>{window.saveCallsStart=previewCalls.length;window.saveOriginalHosts=structuredClone(previewHosts);window.saveOriginalApi=api.hosts.save;
      previewHosts.push({id:'edit-save',name:'编辑保存测试',address:'edit-save.example.test',port:22,username:'root',auth:'agent'},
        {id:'existing-target',name:'同地址已有配置',address:'edit-save.example.test',port:22,username:'ubuntu',auth:'agent'});
      selectTab(undefined,'hosts');await refreshHosts();void editHost(hosts.find(h=>h.id==='edit-save'))})()`);
    const userInput = "[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='SSH 用户名').querySelector('input')";
    await wait('dialog.open');
    await js(`(()=>{const u=${userInput};u.value='ubuntu';u.dispatchEvent(new Event('input'));dialog.querySelector('button[value=save]').click()})()`);
    await wait('!dialog.open');
    assert(await js("previewHosts.filter(h=>h.id==='edit-save').length===1 && previewHosts.find(h=>h.id==='edit-save').username==='ubuntu'"),'Save must update the existing record without requiring duplicate confirmation');
    assert.equal(await js("previewCalls.slice(saveCallsStart).filter(([type,value])=>type==='connect'&&value.expected.id==='edit-save').length"),0,'Save alone must not connect');
    // Keep the edited record away from the last position to verify connection uses its ID.
    await js(`(()=>{previewHosts.find(h=>h.id==='edit-save').username='root';api.hosts.save=async value=>{
      await saveOriginalApi(value);previewHosts.sort((a,b)=>a.id.localeCompare(b.id));return previewHosts;};void editHost(previewHosts.find(h=>h.id==='edit-save'))})()`);
    await wait('dialog.open');
    await js(`(()=>{const u=${userInput};u.value='ubuntu';u.dispatchEvent(new Event('input'));dialog.querySelector('button[value=connect]').click()})()`);
    await wait("!dialog.open && previewCalls.slice(saveCallsStart).some(([type,value])=>type==='connect'&&value.expected.id==='edit-save')");
    assert(await js("active.host.id==='edit-save' && active.host.username==='ubuntu' && previewHosts.filter(h=>h.id==='edit-save').length===1"),'Save and connect must use the updated host ID and username even when the returned list is sorted');
    await js("selectTab(undefined,'hosts');currentGroup='';void editHost()");await wait('dialog.open');
    await js(`(()=>{const address=[...dialog.querySelectorAll('label')].find(l=>l.firstChild.textContent==='主机地址').querySelector('input');address.value='edit-save.example.test';address.dispatchEvent(new Event('input'));const u=${userInput};u.value='ubuntu';u.dispatchEvent(new Event('input'));const auth=dialog.querySelector('[aria-label=\"认证方式\"]').closest('.dropdown').querySelector('select');auth.value='agent';auth.dispatchEvent(new Event('change'));dialog.querySelector('button[value=connect]').click()})()`);
    await wait("dialog.querySelector('.drawer-fields > .dialog-error').textContent.includes('重复的连接配置')");
    assert(!await js("previewHosts.some(h=>h.id==='new-host')"),'A new duplicate must remain blocked until explicitly confirmed');
    await js("[...dialog.querySelectorAll('label.checkbox-row')].find(l=>l.textContent.includes('仍保存为另一条配置')).querySelector('input').checked=true;dialog.querySelector('button[value=connect]').click()");
    await wait("!dialog.open && active.host.id==='new-host'");
    assert(await js("previewHosts.some(h=>h.id==='new-host')"),'Explicitly confirmed new duplicates may be saved and connected');
    await js("(async()=>{for(const t of [...tabs.values()].filter(t=>['edit-save','new-host'].includes(t.host?.id)))await closeTab(t);api.hosts.save=saveOriginalApi;previewHosts.splice(0,previewHosts.length,...saveOriginalHosts);selectTab(undefined,'hosts');await refreshHosts()})()");
    console.log(`${width}px: PASS existing-host save/save-and-connect, duplicate endpoint edits, saved-ID routing and new-duplicate confirmation`);
  };
  if (process.argv.includes('--host-save-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await hostSaveChecks(width);
    }
    return;
  }
  if (process.argv.includes('--host-form-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await hostFormChecks(width);
    }
    return;
  }
  if (process.argv.includes('--shared-ui-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await sharedUiChecks(width);
    }
    return;
  }
  if (process.argv.includes('--host-order-only')) {
    for (const [width,height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await hostOrderChecks(width);
    }
    return;
  }
  if (process.argv.includes('--deletion-only')) {
    for (const [width, height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await deletionChecks(width);
    }
    return;
  }
  if (process.argv.includes('--tree-only')) {
    for (const [width, height] of [[1140,740],[550,490]]) {
      await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
      await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
      await hostTreeChecks(width);
    }
    return;
  }
  if (!process.argv.includes('--shortcuts-only')) {
  await run('Emulation.setDeviceMetricsOverride', {width:1140,height:740,deviceScaleFactor:1,mobile:false});
  await run('Page.navigate', {url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
  await wait("typeof hosts!=='undefined' && hosts.length>0");
  await js("window.setupPassword='  主密码 fixture 🌸  ';void enableVault()");
  await wait("dialog.open && dialog.textContent.includes('确认主密码')");
  await js("window.setupFields=[...dialog.querySelectorAll('input[type=password]')];setupFields.forEach(p=>p.value=setupPassword);dialog.querySelector('form').requestSubmit()");
  await wait("dialog.open && dialog.textContent.includes('保存恢复密钥')");
  // Removed password controls may be cleared by the webview or a password manager.
  await js("setupFields.forEach(p=>p.value='');dialog.querySelector('input[type=checkbox]').checked=true;dialog.querySelector('form').requestSubmit()");
  await wait("!dialog.open && vaultStatus.enabled");
  assert.equal(await js("previewCalls.find(([type])=>type==='enable-vault')[1].password"),await js('setupPassword'),
    'The recovery step must use the exact password confirmed in the first step');
  await js("openSettings('security');[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='修改主密码').click()");
  await wait("dialog.open && dialog.textContent.includes('确认新主密码')");
  await js("(()=>{const fields=dialog.querySelectorAll('input[type=password]');fields[0].value=setupPassword;fields[1].value='new password 🌷';fields[2].value='mismatch';dialog.querySelector('form').requestSubmit()})()");
  await wait("dialog.querySelector('.dialog-error').textContent.includes('两次输入')");
  assert.equal(await js("previewCalls.filter(([type])=>type==='change-password').length"),0);
  await js("(()=>{dialog.querySelector('select').value='recovery';dialog.querySelector('select').dispatchEvent(new Event('change'));const fields=dialog.querySelectorAll('input[type=password]');fields[0].value='fixture-recovery';fields[2].value=fields[1].value;dialog.querySelector('form').requestSubmit()})()");
  await wait('!dialog.open');
  assert.deepEqual(await js("previewCalls.find(([type])=>type==='change-password')[1]"),{secret:'fixture-recovery',useRecovery:true,password:'new password 🌷'});
  await js("$('unlock-mode').value='recovery';applyVaultState({...previewProtected,locked:true});");
  assert.equal(await js("$('unlock-mode').value"),'password','A new lock defaults to master-password authentication');
  await js("window.unlockRequest=undefined;api.vault.unlock=async value=>{unlockRequest=value;return previewProtected};$('unlock-secret').value=setupPassword;$('unlock-form').requestSubmit()");
  await wait('!vaultStatus.locked && !$("unlock-submit").disabled');
  assert.deepEqual(await js('unlockRequest'),{secret:await js('setupPassword'),useRecovery:false});
  assert.equal(await js("$('unlock-secret').value"),'');
  console.log('PASS two-step master password retention, mismatch validation, recovery password changes and immediate unlock routing');
  for (const [width,height] of [[1140,740],[550,490]]) {
    await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await run('Page.navigate',{url:pathToFileURL(path.join(root,'dist/ux-review/workspace.html')).href+'#shortcuts'});
    await wait("typeof hostsLoaded!=='undefined' && hostsLoaded");
    await hostLoginChecks(width);await closeAllChecks(width);await keyImportUiChecks(width);await pointerFocusChecks(width);
  }
  await run('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  for (const [width, height] of [[1140, 740], [550, 490]]) {
    await run('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await run('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/ux-review/workspace.html')).href });
    await wait("document.getElementById('smoke-results')", 400);
    const report = await js("document.getElementById('smoke-results').textContent");
    assert.match(report, /^✓/, report);
    console.log(`${width}×${height}: ${report.split('（')[0]}`);
    await js("document.getElementById('smoke-results').hidden=true");
    await updateNoticeChecks(width);
    await hostFormChecks(width);
    await keyCreationChecks(width);
    await keyAutoAgentChecks(width);await keyAutoAgentChecks(width,true);
    await drawerDismissChecks(width);
    await hostSaveChecks(width);
    await inheritanceChecks(width);
    await sharedUiChecks(width);
    await hostOrderChecks(width);
    await hostCardChecks(width);
    await commandOrderChecks(width);
    await hostTreeChecks(width);
    await csvChecks(width);
    await deletionChecks(width);
    for (const theme of ['dark', 'light']) {
      await js(`uiPreferences.theme='${theme}';applyPreferences();selectTab(undefined,'hosts')`); await tick();
      const contrast = await js(`(() => {
        const styles=getComputedStyle(document.documentElement);
        const color=name=>styles.getPropertyValue('--'+name).trim();
        const luminance=value=>{
          const channels=value.slice(1).match(/../g).slice(0,3).map(v=>parseInt(v,16)/255)
            .map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
          return channels.reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        };
        const ratio=(a,b)=>{const [low,high]=[luminance(color(a)),luminance(color(b))].sort((a,b)=>a-b);return(high+.05)/(low+.05)};
        const pairs=['bg','bar','raise','selected'].flatMap(surface=>
          ['text','muted','accent','success','warning','danger'].map(ink=>[ink,surface]));
        pairs.push(...['primary','primary-hover','primary-active'].map(bg=>['primary-text',bg]),
          ['resource-fg','resource-bg'],['group-fg','group-bg'],
          ['terminal-dark-text','terminal-dark'],['terminal-light-text','terminal-light']);
        return pairs.map(([ink,bg])=>({ink,bg,ratio:ratio(ink,bg)}));
      })()`);
      assert(contrast.every(pair=>Number.isFinite(pair.ratio)&&pair.ratio>=4.5),
        `${theme} theme text, states and button colors must retain 4.5:1 contrast: ${JSON.stringify(contrast.filter(pair=>!Number.isFinite(pair.ratio)||pair.ratio<4.5))}`);
      await overflow();
      for (const selector of ['.host-quick-edit','.host-open ~ .host-edit:last-child']) {
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
      await js("document.querySelector('.host-open ~ .host-edit:last-child').click()"); await tick(); await overflow();
      await shot(`hosts-menu-${theme}-${width}.png`);
      await js("closeHostMenu();document.querySelector('.host-quick-edit').click()");
      await wait("document.querySelector('dialog[open] .host-form-section')");
      await wait("!dialog.getAnimations().some(a=>a.playState==='running')"); await overflow();
      await windowChrome('#dialog');
      await shot(`host-editor-${theme}-${width}.png`);
      await js("dialog.querySelector('[aria-label=\"连接路径\"]').closest('details').open = true; dialog.querySelector('[aria-label=\"连接路径\"]').scrollIntoView({block:'center'})");
      await tick();
      await js("dialog.querySelector('[aria-label=\"连接路径\"]').click()");
      await tick(); await overflow(); await shot(`jump-search-${theme}-${width}.png`);
      await stableSearchDialog('.dropdown-searchable','input[type="search"]',['不存在的主机-geometry',''],640,380);
      await js('closeDropdown()');
      await js('dialog.close()'); await tick();
      await js("document.querySelector('.host-open[data-host-id=\"key-host\"]').parentElement.querySelector('.host-quick-edit').click()");
      await wait("document.querySelector('dialog[open] .host-key-selection')");
      await wait("!dialog.getAnimations().some(a=>a.playState==='running')");
      await js("document.querySelector('.host-key-selection').scrollIntoView({block:'center'})");
      await tick(); await overflow(); await shot(`host-key-${theme}-${width}.png`);
      await js("window.originalKeyScan=api.keys.scan;window.pendingKeyScans=[];api.keys.scan=(...args)=>new Promise(resolve=>pendingKeyScans.push(()=>resolve(originalKeyScan(...args))));[...dialog.querySelectorAll('button')].find(b=>b.textContent==='选择私钥'||b.getAttribute('aria-label')==='选择私钥').click()");
      const loadingKeyBounds = await js("(()=>{const r=$('key-dialog').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
      await js("api.keys.scan=originalKeyScan;pendingKeyScans.forEach(release=>release())");
      await wait("document.querySelector('#key-dialog[open] [role=radio]')"); await overflow();
      assert((await js("(()=>{const r=$('key-dialog').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()")).every((value,index)=>Math.abs(value-loadingKeyBounds[index])<=1),
        'Private key picker must keep its frame while loading changes into results');
      await windowChrome('#key-dialog');
      await shot(`key-picker-${theme}-${width}.png`);
      await js("[...document.querySelectorAll('#key-dialog .actions button')].find(b=>b.textContent==='关闭').click();dialog.close()"); await tick();
      for (const page of ['keys','transfers']) {
        await js(`selectTab(undefined,'${page}')`); await tick(); await overflow();
        assert(await js(`!document.querySelector('#${page}-page h1') && document.querySelector('#${page}-page > :first-child').getBoundingClientRect().top <= document.querySelector('#${page}-page').getBoundingClientRect().top+1`),
          `${page} must keep useful controls without a duplicate page-title band`);
        if(page==='keys') assert(await js("document.querySelector('#keys-page .key-toolbar').contains([...document.querySelectorAll('#keys-page button')].find(b=>b.textContent==='＋ 生成密钥'))"),
          'Generate key belongs in the source/search toolbar');
      }
      await js("openSettings('security')"); await tick(); await overflow();
      await settingsAlignment('security');
      await shot(`security-off-${theme}-${width}.png`);
      await js("applyVaultState(previewProtected)"); await tick(); await overflow();
      assert(await js(`[...$('settings-page').querySelectorAll('.security-action-row')].every(row=>{const a=row.querySelector('p').getBoundingClientRect(),b=row.querySelector('button').getBoundingClientRect();return Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<2 && a.right<=b.left})`),
        'Security actions must pair their description on the left with a button on the right');
      await js("[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='修改主密码').click()");
      await wait("dialog.open && dialog.textContent.includes('确认新主密码')");
      await tick(); await overflow(); await shot(`master-password-${theme}-${width}.png`);
      await js('dialog.close()'); await tick();
      await shot(`security-on-${theme}-${width}.png`);
      await js("api.vault.state().then(applyVaultState)");
      await js("previewUpdateState={...previewUpdateState,phase:'idle',canDownload:false,revision:previewUpdateState.revision+1};openSettings('updates')");
      await wait("document.querySelector('#settings-page .update-card')");
      await tick(); await overflow(); await settingsAlignment('updates');
      await js("[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='检查更新').click()");
      await wait("$('settings-page').textContent.includes('当前已是最新版本')");
      await js("previewListener({type:'update',state:{currentVersion:'0.2.2',phase:'available',version:'0.2.3',notes:'更新说明\\n'.repeat(80)+'<script>unsafe</script>',message:'发现新版本，可以下载更新。',downloaded:0,total:100,canDownload:true}})");
      assert(await js("!$('settings-page').querySelector('script') && $('settings-page').querySelector('.update-notes').scrollHeight > $('settings-page').querySelector('.update-notes').clientHeight"),'Release notes must remain plain text with bounded scrolling');
      await js("previewListener({type:'update',state:{...appUpdateState,phase:'downloading',downloaded:25}});window.updateCancelProbe=[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='取消下载');updateCancelProbe.focus();previewListener({type:'update',state:{...appUpdateState,downloaded:50}})");
      assert(await js("document.activeElement===updateCancelProbe && updateCancelProbe.isConnected && $('settings-page').querySelector('progress').value===50"),'Progress must preserve the cancel button and keyboard focus');
      await js("updateCancelProbe.click()");
      await wait("$('settings-page').textContent.includes('下载已取消')");
      await js("previewListener({type:'update',state:{...appUpdateState,revision:appUpdateState.revision-1,phase:'downloading',message:'stale response'}})");
      assert(await js("appUpdateState.phase==='available' && !$('settings-page').querySelector('progress')"),'A late download response cannot overwrite a newer cancellation');
      assert(await js("fileEditor instanceof HTMLDialogElement && !fileEditor.open && !fileEditor.hidden"),'A closed native file-editor dialog has no hidden attribute and must not block installation');
      await js("previewListener({type:'update',state:{...appUpdateState,phase:'ready'}});[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='重启并安装').click()");
      await wait("$('settings-page').textContent.includes('请先关闭 SSH 会话')");
      await js("fileEditor.show();[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='重启并安装').click()");
      await wait("$('settings-page').textContent.includes('保存并关闭文件编辑器')");
      await js("fileEditor.close();[...$('settings-page').querySelectorAll('button')].find(b=>b.textContent==='重启并安装').click()");
      await wait("$('settings-page').textContent.includes('请先关闭 SSH 会话')");
      await tick(); await overflow(); await shot(`updates-${theme}-${width}.png`);
      for (const section of ['preferences','groups','identities','snippets','layouts','logs','trust']) {
        await js(`openSettings('${section}')`);
        await wait("document.querySelector('#settings-page .settings-form')"); await tick(); await overflow();
        await settingsAlignment(section);
        if (['groups','identities','trust'].includes(section)) {
          assert(await js(`(()=>{const toolbar=$('settings-page').querySelector('.settings-list-toolbar');const search=toolbar?.querySelector('input[type=search]');const action=toolbar?.querySelector('button');if(!search||!action)return false;const a=search.getBoundingClientRect(),b=action.getBoundingClientRect();return Math.abs(a.y-b.y)<2 && a.right<=b.left})()`),
            `${section} must align search on the left and its action on the right`);
          await js("(()=>{const search=$('settings-page').querySelector('input[type=search]');search.value='no-matching-resource';search.dispatchEvent(new Event('input'))})()");
          await tick(); await overflow();
          if (['groups','identities'].includes(section)) assert(await js("$('settings-page').textContent.includes('没有匹配')"));
          await js("(()=>{const search=$('settings-page').querySelector('input[type=search]');search.value='';search.dispatchEvent(new Event('input'))})()");
          await shot(`${section}-toolbar-${theme}-${width}.png`);
        }
        if (section === 'snippets') await shot(`command-library-${theme}-${width}.png`);
      }
      await js("openSettings('preferences')"); await wait("document.querySelector('#settings-page .settings-form')");
      await shot(`settings-${theme}-${width}.png`);
      const selectionOrigin = await js('active?.id');
      await js('addNewTab()'); await tick(); await overflow();
      assert(await js("!$('new-tab-page').querySelector('h1') && $('quick-add-host').parentElement===$('quick-connect-form').parentElement"),
        'New tab must combine search and new-host action without its duplicate title');
      await shot(`quick-connect-filters-${theme}-${width}.png`);
      await js('removeTab(active); selectTab([...tabs.values()].find(tab=>tab.kind===\'shell\'))');
      await js('chooseSession()'); await tick(); await overflow();
      await stableSearchDialog('#session-switcher','input[type="search"]',['不存在的会话-geometry','API',''],720,500);
      await shot(`session-filters-${theme}-${width}.png`);
      await js("$('session-switcher').close()"); await tick();
      await js('void openPalette()'); await wait('dialog.open'); await tick(); await overflow();
      await stableSearchDialog('#dialog','input[type="search"]',['disk','不存在的命令-geometry',''],640,600);
      await shot(`palette-filters-${theme}-${width}.png`);
      await js('dialog.close()'); await tick();
      await js("void openPalette('commands')"); await wait('dialog.open'); await tick(); await overflow();
      await stableSearchDialog('#dialog','input[type="search"]',['磁盘空间','不存在的命令-geometry',''],640,600);
      await shot(`quick-commands-${theme}-${width}.png`);
      if(theme==='dark') {
        await run('Emulation.setDeviceMetricsOverride',{width:1800,height:1200,deviceScaleFactor:1,mobile:false}); await tick();
        const capped=await js('({width:dialog.offsetWidth,height:dialog.offsetHeight})');
        assert(capped.width<=640 && capped.height<=600, 'Quick commands must stop growing on a large window');
        await run('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await tick();
      }
      await js('dialog.close()'); await tick();
      if(theme==='dark') {
        await js("window.dialogStressCount=previewSnippets.length;for(let index=0;index<100;index++)previewSnippets.push({id:'dialog-stress-'+index,name:'窗口回归命令 '+index,command:'echo '+index,tags:['dialog-stress'],pinned:index<8,order:1000+index});void openPalette('commands')");
        await wait('dialog.open'); await tick();
        assert(await js("(()=>{const list=dialog.querySelector('.palette-list'),fields=dialog.querySelector('.dialog-fields');const actions=dialog.querySelector('.actions').getBoundingClientRect(),frame=dialog.getBoundingClientRect();return list.clientHeight>0&&list.scrollHeight>list.clientHeight&&fields.scrollHeight<=fields.clientHeight+1&&actions.bottom<=frame.bottom-8})()"),
          'Long command results must scroll internally while search and footer remain visible');
        await stableSearchDialog('#dialog','input[type="search"]',['窗口回归命令 99','不存在的命令-geometry',''],640,600);
        await shot(`quick-commands-overflow-${width}.png`);
        await js('dialog.close();previewSnippets.splice(dialogStressCount)'); await tick();
      }
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
      const draggedLayout = await js('({ ratio: splitLayout.tree.ratio, rowRatio: splitLayout.tree.first.ratio })');
      assert(draggedLayout.ratio > 50 && draggedLayout.rowRatio > 50,
        `Both four-pane separators must respond to pointer dragging: ${JSON.stringify(draggedLayout)}`);
      assert(await js("![...document.querySelectorAll('button')].some(b=>b.getClientRects().length&&['分屏','分屏设置'].includes(b.textContent))"),
        'Drag splitting replaces every split settings entry point');
      await js("$('save-layout').click()");
      await windowChrome('#dialog');
      await tick();await overflow();await shot(`workspace-save-${theme}-${width}.png`);
      await js('dialog.close()');await tick();
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
      await js('toggleServerInfo()'); await tick();
      await wait("$('server-info').querySelectorAll('[role=\"meter\"]').length === 4");
      await overflow();
      assert(await js("$('server-info').scrollWidth <= $('server-info').clientWidth + 1 && $('server-info').getBoundingClientRect().right <= innerWidth"));
      await shot(`server-info-${theme}-${width}.png`);
      await js('active.networkHistory=previewNetworkHistory(); active.resourceHistory=previewResourceHistory(); active.diskHistory=previewDiskHistory(); renderServerInfo()');
      for (const [metric, selector] of [['cpu','[data-metric="cpu"]'], ['memory','[data-metric="memory"]'], ['network','.server-info-network .server-network-chart'], ['disk','.server-disk-chart'], ['iops','[data-disk-metric="iops"]'], ['io-utilization','[data-disk-metric="utilization"]'], ['disk-latency','.server-disk-latency-chart'], ['io-queue','[data-disk-metric="queueLength"]']]) {
        await js(`(()=>{const body=$('server-info').querySelector('.server-info-body');const chart=body.querySelector(${JSON.stringify(selector)});
          body.scrollTop+=chart.getBoundingClientRect().top-body.getBoundingClientRect().top-6;})()`);
        await tick(); await overflow();
        assert(await js(`$('server-info').querySelector(${JSON.stringify(selector)}).getBoundingClientRect().right <= innerWidth`));
        await shot(`${metric}-history-${theme}-${width}.png`);
      }
      await js('toggleServerInfo(); toggleFiles()'); await tick();
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
        const bounds = await js('fileEditor.getBoundingClientRect().toJSON()');
        assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [0, 50, width, height - 50]);
        await windowChrome('#file-editor');
        assert(await js("fileEditor.querySelector('.file-editor-heading .actions').getBoundingClientRect().right > innerWidth - 24"));
        await overflow(); await shot(`file-editor-fullscreen-${width}.png`);
        const wrapButton = "fileEditor.querySelector('[aria-label=自动换行]')";
        const enableWrapHint = await js(`${wrapButton}.title`);
        assert.match(enableWrapHint, /开启自动换行.*折行显示/);
        await js(`${wrapButton}.click()`);
        await wait("Boolean(fileEditor.querySelector('.cm-lineWrapping'))");
        assert.match(await js(`${wrapButton}.title`), /关闭自动换行.*左右滚动/);
        await js("[...fileEditor.querySelectorAll('button')].find(b => b.textContent === '查找').click()");
        await wait("document.activeElement.name === 'search'");
        await overflow();
        await js("fileEditor.querySelector('[aria-label=查找]').click()");
        await wait("!fileEditor.querySelector('.file-search-panel')");
        await js("fileEditor.querySelector('[aria-label=跳行]').click()");
        await wait("!fileEditor.querySelector('.file-jump-row').hidden");
        await js("fileEditor.querySelector('[aria-label=跳行]').click()");
        await wait("fileEditor.querySelector('.file-jump-row').hidden");
        await js(`${wrapButton}.click()`);
        await wait("!fileEditor.querySelector('.cm-lineWrapping')");
        assert.equal(await js(`${wrapButton}.title`), enableWrapHint);
        await js("[...fileEditor.querySelectorAll('button')].find(button => button.textContent === '关闭').click()");
        await tick();
      }
    }
    await dragSplitChecks(width);
    await workspaceInteractionChecks(width);
  }
  await js("splitGroups.clear(); splitLayout=undefined; if (filesOpen) toggleFiles(); selectTab([...tabs.values()].find(tab=>tab.kind==='shell'))");
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
  console.log('PASS: workspace navigation, four-pane layouts and both separators, compact file panel, and fullscreen file editing, text wrapping and search at both window sizes.');
  }
  const userAgent = await js('navigator.userAgent');
  for (const [platform, modifiers, prefix] of [['Win32', 2, 'Ctrl+'], ['MacIntel', 4, '⌘']]) {
    await run('Emulation.setDeviceMetricsOverride', { width: platform === 'Win32' ? 550 : 1140, height: 740, deviceScaleFactor: 1, mobile: false });
    await run('Emulation.setUserAgentOverride', { userAgent, platform });
    await run('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/ux-review/workspace.html')).href + `?platform=${platform}#shortcuts` });
    await wait(`location.hash === '#shortcuts' && navigator.platform === '${platform}' && typeof keyboard !== 'undefined' && keyboard.isMac === ${platform === 'MacIntel'} && hostsLoaded`);
    const vimRendering = await js(`(async () => {
      const surface = document.createElement('div');
      surface.style.cssText = 'position:fixed;left:0;top:0;width:1100px;height:650px';
      document.body.append(surface);
      const terminal = new Terminal({cols:120,rows:30,allowProposedApi:true});
      terminal.open(surface);
      const read = () => Array.from({length:terminal.rows}, (_, row) =>
        terminal.buffer.active.getLine(row).translateToString(true).trimEnd());
      const write = data => new Promise(resolve => terminal.write(data, resolve));
      const frame = '\\x1b[?1049h\\x1b[1;30r\\x1b[H\\x1b[2J' +
        Array.from({length:28}, (_, row) => '\\x1b['+(row+1)+';1HLine '+(row+1)).join('') +
        '\\x1b[29;1HVim status\\x1b[30;1HVim message\\x1b[H';
      // The row delete/insert operations are how Vim scrolls without redrawing
      // the whole screen. Exercise them after a resize races with its old frame.
      const down = '\\x1b[1;26r\\x1b[H\\x1b[4M\\x1b[23;1HLine 29\\r\\nLine 30\\r\\nLine 31\\r\\nLine 32';
      const up = '\\x1b[H\\x1b[2LLine 3\\r\\nLine 4\\x1b[r';
      const expected = [];
      await write(frame); terminal.resize(120,28); expected.push(read());
      await write(down); expected.push(read());
      await write(up); expected.push(read());
      terminal.reset(); terminal.resize(120,30);
      const actual = [];
      const rendering = createTerminalRendering(terminal, () => {terminal.resize(120,28);actual.push(read());});
      rendering.write(frame);
      const fitted = rendering.fit();
      const scrolledDown = new Promise(resolve => rendering.write(down, () => {actual.push(read());resolve();}));
      await fitted; await scrolledDown;
      await new Promise(resolve => rendering.write(up, () => {actual.push(read());resolve();}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dom = [...surface.querySelectorAll('.xterm-rows > div')].map(row => row.textContent.trimEnd());
      const atScreen = terminal.buffer.active.type === 'alternate' &&
        terminal.buffer.active.baseY === 0 && terminal.buffer.active.viewportY === 0;
      rendering.dispose(); terminal.dispose(); surface.remove();
      return {expected,actual,dom,atScreen};
    })()`);
    assert.deepEqual(vimRendering.actual, vimRendering.expected, 'Vim frames must parse before fitting, with correct scroll margins afterwards');
    assert.deepEqual(vimRendering.dom, vimRendering.actual.at(-1), 'Every displayed Vim row must match the terminal buffer after scrolling both directions');
    assert(vimRendering.atScreen, 'Vim scrolling must stay inside the alternate screen');
    console.log(`${platform}: PASS Vim output/resize race, scroll-region line deletion/insertion, and rendered row consistency`);
    const key = async (name, code, virtual, extra = 0) => {
      await run('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: virtual, modifiers: modifiers | extra });
      await run('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtual, modifiers: modifiers | extra });
      await tick();
    };
    assert.equal(await js("document.querySelector('#palette-button kbd').textContent"), `${prefix}K`);
    assert((await js("document.getElementById('add-tab').title")).includes(`${prefix}T`));
    const brandLeft = await js("$('library-button').getBoundingClientRect().left");
    assert(Math.abs(brandLeft-(platform==='MacIntel'?80:10))<=1,'Only macOS reserves space for traffic-light controls');
    await overflow();
    await key('t', 'KeyT', 84);
    assert.equal(await js('active.kind'), 'new');
    await key('w', 'KeyW', 87);
    assert.equal(await js('tabs.size'), 0);
    const collapsed = await js('workspace.dataset.navCollapsed');
    await key('b', 'KeyB', 66);
    assert.notEqual(await js('workspace.dataset.navCollapsed'), collapsed);
    await key('b', 'KeyB', 66);
    await js('void openHost(previewHosts[0])');
    await wait('active?.status === "ready"');
    await js('previewCalls.length = 0; active.terminal.focus()');
    await key('k', 'KeyK', 75);
    assert(await js('dialog.open'));
    assert.equal(await js("previewCalls.filter(([type]) => type === 'input').length"), 0);
    await js('dialog.close()');
    await key('f', 'KeyF', 70);
    assert(await js("!document.getElementById('terminal-find').hidden"));
    await js("document.getElementById('close-find').click()");
    const fontSize = await js('active.terminal.options.fontSize');
    await key('=', 'Equal', 187);
    assert.equal(await js('active.terminal.options.fontSize'), fontSize + 1);
    await key('0', 'Digit0', 48);
    assert.equal(await js('active.terminal.options.fontSize'), fontSize);
    await key('e', 'KeyE', 69);
    assert(await js('filesOpen'));
    await key('e', 'KeyE', 69);
    assert.equal(await js('filesOpen'), false);
    await key('t', 'KeyT', 84);
    await key('1', 'Digit1', 49);
    assert.equal(await js('active.kind'), 'shell');
    await key('j', 'KeyJ', 74);
    assert(await js('sessionSwitcher.open'));
    await js('sessionSwitcher.close()');
    await tick();
    if (platform === 'Win32') {
      await key('Tab', 'Tab', 9);
      assert.equal(await js('active.kind'), 'new');
      await key('Tab', 'Tab', 9, 8);
      assert.equal(await js('active.kind'), 'shell');
    }
    assert.equal(await js("previewCalls.filter(([type]) => type === 'input').length"), 0, 'App shortcuts must not send terminal controls');
    // A synthetic selected-copy key tests xterm routing without touching the OS clipboard.
    await js(`active.terminal.write('copy fixture'); active.terminal.select(0, 0, 4);
      active.terminal.textarea.dispatchEvent(new KeyboardEvent('keydown', { key:'c', code:'KeyC', keyCode:67, bubbles:true, cancelable:true,
        ctrlKey:${platform === 'Win32'}, metaKey:${platform !== 'Win32'} }))`);
    assert.equal(await js("previewCalls.filter(([type]) => type === 'input').length"), 0);
    await js('active.terminal.clearSelection(); active.terminal.focus()');
    for (const [name, virtual] of [['c', 67], ['d', 68], ['r', 82]]) {
      await run('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: virtual, modifiers: 2 });
      await run('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: virtual, modifiers: 2 });
    }
    assert.deepEqual(await js("previewCalls.filter(([type]) => type === 'input').map(([, value]) => value.data)"), ['\x03', '\x04', '\x12']);
    await js("openTerminalPath(active, '/srv/app/config.json')");
    await wait("Boolean(fileEditor.querySelector('.cm-content'))");
    await js("fileEditor.querySelector('[aria-label=编辑]').click(); fileEditor.querySelector('.cm-content').focus(); document.execCommand('insertText', false, ' ')");
    await key('s', 'KeyS', 83);
    assert.equal(await js("previewCalls.filter(([type]) => type === 'save-text').length"), 1);
    assert((await js("[...fileEditor.querySelectorAll('button')].find(b => b.textContent === '保存').title")).includes(`${prefix}S`));
    await overflow();
    await js("[...fileEditor.querySelectorAll('button')].find(b => b.textContent === '关闭').click()");
    await js("applyVaultState({...vaultStatus, enabled:true, locked:false, startupUnlockSupported:true, startupUnlockRequired:true}); void openSettings('security')");
    await wait("Boolean(document.getElementById('vault-startup-unlock'))");
    assert(await js("document.getElementById('vault-startup-unlock').checked"));
    await js("document.getElementById('vault-startup-unlock').click()");
    await tick();
    assert.equal(await js("document.getElementById('vault-startup-unlock').checked"), false);
    assert(await js("document.getElementById('settings-page').textContent.includes('本机的加密凭据')"));
    assert.equal(await js("document.getElementById('settings-page').textContent.includes('钥匙串')"), false);
    await js("selectTab(undefined, 'hosts'); currentGroup = ''; void editHost()");
    await wait("Boolean(dialog.querySelector('.host-form-section'))");
    assert(await js("dialog.querySelector('.group-inheritance-options').hidden"));
    assert.equal(await js("dialog.querySelector('[aria-label=\"连接路径\"]').closest('details').open"), false);
    assert.equal(await js("dialog.querySelector('[aria-label=\"认证方式\"]').closest('.dropdown').querySelector('select').value"), 'password');
    await overflow();
    await shot(`host-create-${platform}.png`);
    await js('dialog.close()');
    console.log(`${platform}: PASS platform hints, tabs, search, find, files, zoom, editor save, copy routing and shell controls`);
    console.log(`${platform}: PASS app-encrypted automatic-unlock setting and platform-neutral help`);
    console.log(`${platform}: PASS simplified new-host form and collapsed advanced connection settings`);
  }
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
