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
const deadline = setTimeout(() => { console.error('UI checks timed out.', stderr); browser.kill(); process.exitCode = 1; }, 90000);
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
        assert(await js(`!document.querySelector('#${page}-page h1') && document.querySelector('#${page}-page > :first-child').getBoundingClientRect().top <= document.querySelector('#${page}-page').getBoundingClientRect().top+1`),
          `${page} must keep useful controls without a duplicate page-title band`);
        if(page==='keys') assert(await js("document.querySelector('#keys-page .key-toolbar').contains([...document.querySelectorAll('#keys-page button')].find(b=>b.textContent==='＋ 生成密钥'))"),
          'Generate key belongs in the source/search toolbar');
      }
      await js("openSettings('security')"); await tick(); await overflow();
      await settingsAlignment('security');
      await shot(`security-off-${theme}-${width}.png`);
      await js("applyVaultState(previewProtected)"); await tick(); await overflow();
      await shot(`security-on-${theme}-${width}.png`);
      await js("api.vault.state().then(applyVaultState)");
      for (const section of ['preferences','groups','identities','snippets','layouts','logs','trust']) {
        await js(`openSettings('${section}')`);
        await wait("document.querySelector('#settings-page .settings-form')"); await tick(); await overflow();
        await settingsAlignment(section);
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
