(async () => {
  const results = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const findButton = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
  try {
    await tick(); await refreshHosts();
    assert($('host-list').textContent.includes('最近连接'), '最近连接跨分组可见');
    await openHost(previewHosts[0]); await tick();
    const production = active;
    assert(getComputedStyle($('sidebar')).display !== 'none' && $('sidebar-sessions').children.length === 1, '终端保留会话导航');
    await openHost(previewHosts[1]); await tick();
    const staging = active;
    await openHost(previewHosts[0]);
    assert(active === production && tabs.size === 2, '再次连接复用既有会话');
    const palette = openPalette(); await tick();
    const search = dialog.querySelector('input'); search.value = 'disk'; search.dispatchEvent(new Event('input'));
    assert(dialog.querySelectorAll('.palette-choice').length === 2, '命令标签搜索包含执行与单行粘贴');
    // Label and target occupy separate spans.
    [...dialog.querySelectorAll('.palette-choice')].find(b => b.firstElementChild.textContent === '粘贴 · 磁盘巡检')?.click();
    await palette;
    assert(previewCalls.some(([type,value]) => type === 'input' && value.id === production.id && value.data === 'df -h'), '粘贴绑定原会话且不追加回车');
    const multi = openPalette('commands'); await tick();
    const multiSearch = dialog.querySelector('input'); multiSearch.value = '服务检查'; multiSearch.dispatchEvent(new Event('input'));
    assert(dialog.querySelectorAll('.palette-choice').length === 1 && dialog.querySelector('.palette-choice').textContent.startsWith('执行'), '多行命令只提供执行预览');
    dialog.close(); await multi;
    toggleFiles(); await tick();
    findButton($('files'), 'var').click(); await tick();
    assert(previewCalls.at(-1)[1].id === production.id && previewCalls.at(-1)[1].directory === '/var', '面包屑按原主机的绝对路径跳转');
    const selected = $('files').querySelector('input[aria-label="选择 error.log"]'); selected.click();
    findButton($('files'), '所选项 ⋯').click();
    assert(!findButton(hostMenu.panel, '跟踪日志').disabled && !findButton(hostMenu.panel, '重命名').disabled, '所选文件菜单保持可用动作');
    hostMenu.panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert(!hostMenu && document.activeElement.textContent === '所选项 ⋯', '菜单 Esc 恢复触发器焦点');
    const filter = $('files').querySelector('input[type="search"]'); filter.value = 'access'; filter.dispatchEvent(new Event('input'));
    assert(production.files.selected.size === 0, '文件筛选清除隐藏选项');
    selectTab(staging); await tick();
    assert(origin() === staging && $('files').textContent.includes('API 预发'), '切换会话同步文件目标');
    splitLayout = {panes:[production.id,staging.id],direction:'horizontal',ratio:50}; selectTab(production); await tick();
    const connectCount = previewCalls.filter(([type]) => type === 'connect').length;
    splitGrip.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    assert(splitLayout.ratio === 55 && connectCount === previewCalls.filter(([type]) => type === 'connect').length, '分屏调整保留连接');
    splitLayout = undefined; selectTab(production);
    assert(document.documentElement.scrollWidth <= innerWidth, '工作台无页面横向溢出');
    const report = document.createElement('details');
    report.id = 'smoke-results'; report.style = 'position:fixed;bottom:32px;right:8px;z-index:20;max-width:420px;background:var(--raise);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:11px;max-height:70vh;overflow:auto';
    const summary = document.createElement('summary'); summary.textContent = `✓ ${results.length} 项界面检查通过（模拟数据）`; report.append(summary);
    const lines = document.createElement('pre'); lines.textContent = results.join('\n'); report.append(lines); document.body.append(report);
  } catch (error) {
    const report = document.createElement('pre'); report.id='smoke-results'; report.style='position:fixed;inset:60px 10px auto;z-index:30;background:#512020;color:white;padding:15px'; report.textContent=`失败：${error.stack}\n已通过：${results.join('、')}`; document.body.append(report);
  }
})();
