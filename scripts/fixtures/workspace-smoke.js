(async () => {
  const results = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const findButton = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
  try {
    await tick(); await refreshHosts();
    const library = $('host-library');
    const hostList = $('host-list');
    const [groupSection, hostSection] = hostList.children;
    const visibleHostIds = () => [...hostList.querySelectorAll('.host-open')].map(item => item.dataset.hostId);
    assert(groupSection.querySelector('h2').textContent === '分组' && hostSection.querySelector('h2').textContent === '主机' &&
      groupSection.getBoundingClientRect().bottom < hostSection.getBoundingClientRect().top &&
      visibleHostIds().join() === 'jump', '首页上方是分组，下方只显示未分组主机');
    assert(hostSection.querySelector('.host-identity small').textContent === endpoint(previewHosts[3]), '主机第二行仅显示连接地址');
    assert(!$('host-count') && !$('host-selection-hint') && !$('host-selection-actions') && $('host-list').getBoundingClientRect().top - $('host-library').getBoundingClientRect().top <= 24, '主机列表直接开始，不再占用数量及选中信息栏空间');
    hostList.querySelector('.group-open[data-group="生产环境"]').click();
    assert(visibleHostIds().sort().join() === 'api,db' && hostList.children.length === 1 &&
      hostList.querySelector('h2').textContent === '主机', '没有子分组时只显示组内主机区块');
    const originalGroups = groupAssets;
    groupAssets = [...groupAssets, { id: 'prod-app', parentId: 'prod', path: '生产环境/应用', hosts: [] }];
    renderHosts();
    assert(hostList.querySelector('h2').textContent === '子分组' &&
      hostList.querySelector('.group-open')?.dataset.group === '生产环境/应用', '有子分组时可继续进入');
    $('host-search').value = '预发';
    $('host-search').dispatchEvent(new Event('input'));
    assert(!hostList.querySelector('.group-open') && hostList.children.length === 1, '组内搜索不会显示其他分组');
    groupAssets = originalGroups;
    $('all-hosts').click();
    assert(!hostList.querySelector('[aria-pressed="true"]') && !$('hosts').contains(document.activeElement),
      '返回主机首页不自动聚焦或选中分组');
    const searchInput = $('host-search');
    searchInput.value = '数据库';
    searchInput.dispatchEvent(new Event('input'));
    assert(visibleHostIds().join() === 'db', '搜索可找到已分组的主机');
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    const initialHosts = hosts;
    hosts = [...hosts, ...Array.from({ length: 36 }, (_, index) => ({
      ...previewHosts[3], id: `overflow-${index}`, name: `滚动检查 ${index}`
    }))];
    renderHosts();
    const entries = hostList.lastElementChild.querySelector('.host-entries');
    if (workspace.dataset.hostLayout === 'cards' && [1140, 550].includes(innerWidth)) {
      const firstRow = entries.firstElementChild.offsetTop;
      assert([...entries.children].filter(card => card.offsetTop === firstRow).length === (innerWidth === 1140 ? 3 : 1),
        '常规窗口每行三张卡片，窄窗口每行一张');
    }
    const topBefore = hostList.getBoundingClientRect().top;
    const toolbarTop = $('host-search-form').getBoundingClientRect().top;
    library.scrollTop = 120;
    assert(library.scrollTop === 120 && hostList.getBoundingClientRect().top === topBefore - 120 &&
      $('host-search-form').getBoundingClientRect().top === toolbarTop, '上下分区共用滚动区域，顶部工具栏固定');
    hosts = initialHosts;
    renderHosts();
    const connect = api.ssh.connect;
    api.ssh.connect = async value => previewCalls.push(['connect', value]);
    await openHost(previewHosts[0]); await tick();
    const production = active;
    previewListener({ type: 'progress', id: production.id, message: '正在验证 SSH 身份…' });
    assert(!$('work').hidden && $('toolbar').hidden && production.surface.inert &&
      production.connectionPage.textContent.includes('正在验证 SSH 身份'), 'SSH 连接期间在标签内显示进度');
    findButton(production.connectionPage, '查看连接日志').click();
    assert(!production.connectionPage.querySelector('pre').hidden &&
      production.connectionPage.querySelector('pre').textContent.includes('正在准备 SSH 连接'),
      '连接日志显示此前的连接阶段');
    const beforeReady = previewResizes.length;
    previewListener({ type: 'session', id: production.id, status: 'ready' });
    api.ssh.connect = connect;
    assert(production.connectionPage.hidden && !$('toolbar').hidden && !production.surface.inert, '连接成功后切入终端');
    assert(previewResizes.slice(beforeReady).some(({ id, size }) =>
      id === production.id && size.cols === production.terminal.cols && size.rows === production.terminal.rows),
      'SSH 握手完成后同步已适配的终端行列数');
    assert(getComputedStyle($('sidebar')).display === 'none' && !$('sidebar-sessions') && !$('sidebar-group-list'), '会话独占内容区域，移除重复会话与分组导航');
    await openHost(previewHosts[1]); await tick();
    const staging = active;
    await openHost(previewHosts[0]);
    assert(active === production && tabs.size === 2, '再次连接复用既有会话');
    $('library-button').click(); await tick();
    assert(workspace.dataset.view === 'hosts' && getComputedStyle($('sidebar')).display !== 'none' &&
      !$('hosts').contains(document.activeElement), '工作台标签恢复主机页面与导航，焦点不跳到搜索框');
    production.tabRow.querySelector('.tab-open').click(); await tick();
    assert(active === production && getComputedStyle($('sidebar')).display === 'none', '顶部会话标签切换到完整终端区域');
    for (const section of ['preferences','groups','identities','snippets','layouts','logs','trust']) {
      openSettings(section); await tick();
      assert(workspace.dataset.view === 'settings' && !dialog.open && $('settings-page').querySelector('.settings-form'), `${section} 在独立设置页面显示`);
    }
    openSettings('preferences'); await tick();
    const preferenceForm=$('settings-page').querySelector('form');
    preferenceForm.requestSubmit(); await tick();
    assert($('settings-page').textContent.includes('已保存。') && !dialog.open, '偏好直接在页面保存并显示结果');
    selectTab(production); $('library-button').click(); await tick();
    assert(workspace.dataset.view === 'settings' && !dialog.open, '切回工作台恢复设置页面，不自动切换主机页');
    openSettings('snippets'); await tick();
    findButton($('settings-page'),'新建命令').click(); await tick();
    assert($('settings-page').textContent.includes('命令文本') && !dialog.open, '命令编辑直接在设置页面进行');
    openSettings('groups'); await tick();
    findButton($('settings-page'),'新建分组').click(); await tick();
    assert($('settings-page').textContent.includes('上级分组') && !dialog.open, '分组编辑直接在设置页面进行');
    selectTab(undefined,'hosts'); await tick();
    const quickEdit=$('host-list').querySelector('.host-quick-edit');
    assert(quickEdit?.getAttribute('aria-label').startsWith('编辑主机'), '主机卡片提供独立快捷编辑按钮');
    quickEdit.click(); await tick();
    assert(dialog.open && dialog.textContent.includes('编辑主机'), '快捷编辑直接打开主机表单');
    assert(getComputedStyle(dialog).animationName === 'host-drawer-enter', '主机抽屉打开时具有滑入动画');
    const drawerClosed = new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
    findButton(dialog,'取消').click();
    assert(dialog.open && dialog.dataset.closing === 'true', '抽屉关闭时先滑出，再结束对话框');
    await drawerClosed; await tick();
    const more=$('host-list').querySelector('.host-edit:last-child'); more.click(); await tick();
    assert(hostMenu.panel.querySelectorAll('button').length >= 5 && [...hostMenu.panel.querySelectorAll('button')].every(b=>b.scrollWidth<=b.clientWidth+1 && b.scrollHeight<=b.clientHeight+1), '主机更多菜单文字完整容纳在按钮内');
    assert([...hostMenu.panel.querySelectorAll('button'), $('import-hosts'), ...$('import-hosts').parentElement.querySelectorAll('button')].every(b=>!/(?:…|\.{3})$/.test(b.textContent.trim())), '导入及主机操作菜单使用完整文字，不带省略号后缀');
    closeHostMenu(); selectTab(production);
    const keyHost={id:'key-host',name:'密钥认证测试',address:'key.example.test',port:22,username:'ops',auth:'key',keyPath:'/preview/key'};
    previewHosts.push(keyHost);
    const editKey=editHost(keyHost); await tick();
    assert(dialog.querySelector('.selected-key-name').textContent === 'key' && !dialog.querySelector('.host-key-selection').textContent.includes('/preview/'), '主机编辑器只显示私钥名称');
    findButton(dialog,'选择私钥').click(); await tick();
    const picker=$('key-dialog');
    assert(picker.querySelectorAll('[role="radio"]').length === 2 && !picker.querySelector('.key-detail,.key-generator,.key-directories,.settings-switcher'), '私钥选择器只列出已有私钥，不含管理及详情面板');
    assert([...picker.querySelectorAll('.actions button')].map(b=>b.textContent).join('/') === '确定/关闭' && getComputedStyle(findButton(picker,'确定')).backgroundColor !== getComputedStyle(findButton(picker,'关闭')).backgroundColor, '确定按钮位于关闭左侧，使用不同颜色');
    picker.querySelectorAll('[role="radio"]')[1].click();
    assert(picker.open && dialog.querySelector('.selected-key-name').textContent === 'key', '点击私钥只更新选择，确认前不应用');
    findButton(picker,'关闭').click(); await tick();
    assert(dialog.querySelector('.selected-key-name').textContent === 'key', '取消选择保留原有私钥');
    findButton(dialog,'选择私钥').click(); await tick();
    picker.querySelector('[role="radiogroup"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert(picker.querySelector('[aria-checked="true"]').dataset.path === '/preview/second-key', '方向键可切换已有私钥');
    findButton(picker,'确定').click(); await tick();
    assert(!picker.open && dialog.querySelector('.selected-key-name').textContent === 'second-key', '底部确定将选择应用到主机表单');
    const savedKeys=previewKeys.splice(0);
    findButton(dialog,'选择私钥').click(); await tick();
    assert(findButton(picker,'确定').disabled && picker.textContent.includes('暂无可选私钥'), '没有已有私钥时不能确认空选择');
    findButton(picker,'关闭').click(); previewKeys.push(...savedKeys); await tick();
    const keySecretInput=[...dialog.querySelectorAll('label')].find(label=>label.textContent.startsWith('私钥口令（仅保存在本机）')).querySelector('input');
    keySecretInput.value='fixture-only-key-secret';
    dialog.querySelector('button[value="save"]').click(); await editKey;
    assert(previewCalls.some(([type,value])=>type==='save-host'&&value.id===keyHost.id&&value.localKeyPassphrase==='fixture-only-key-secret'&&value.keyPath==='/preview/second-key'), '私钥选择和口令从主机编辑表单保存');
    await openHost(keyHost); await tick();
    assert(!dialog.open && previewCalls.some(([type,value])=>type==='connect'&&value.expected.id===keyHost.id&&value.secret===''), '密钥连接不弹出口令输入框');
    selectTab(production);
    const palette = openPalette(); await tick();
    const search = dialog.querySelector('input'); search.value = 'disk'; search.dispatchEvent(new Event('input'));
    assert(dialog.querySelectorAll('.palette-choice').length === 2, '命令标签搜索包含执行与单行粘贴');
    // Label and target occupy separate spans.
    [...dialog.querySelectorAll('.palette-choice')].find(b => b.firstElementChild.textContent === '填入终端 · 磁盘巡检')?.click();
    await palette;
    assert(previewCalls.some(([type,value]) => type === 'input' && value.id === production.id && value.data === 'df -h'), '粘贴绑定原会话且不追加回车');
    const multi = openPalette('commands'); await tick();
    const multiSearch = dialog.querySelector('input'); multiSearch.value = '服务检查'; multiSearch.dispatchEvent(new Event('input'));
    assert(dialog.querySelectorAll('.palette-choice').length === 1 && dialog.querySelector('.palette-choice').textContent.startsWith('独立执行'), '多行命令保留独立执行预览');
    dialog.close(); await multi;
    const beforeShortcut = tabs.size;
    const shortcut = configureCommand(production, 'disk');
    findButton(dialog, '填入终端').click();
    await shortcut;
    assert(tabs.size === beforeShortcut && active === production && previewCalls.at(-1)[1].data === 'df -h', '内置快捷命令填入当前会话，不回车或创建标签');
    const folder = openLinkedTerminalPath(production, undefined, 'config');
    await tick();
    assert(dialog.open && !dialog.querySelector('input') && document.activeElement.id === 'dialog-title' &&
      [...dialog.querySelectorAll('.actions button')].map(b => b.textContent).join('、') === '进入、下载、文件区打开、取消',
      '远端目录按顺序显示操作，焦点停在标题');
    const pendingInputs = previewCalls.filter(([type]) => type === 'input').length;
    findButton(dialog, '进入').click();
    await tick();
    assert(dialog.open && dialog.querySelector('[role=alert]').textContent.includes('空的 Shell 提示符') &&
      previewCalls.filter(([type]) => type === 'input').length === pendingInputs, '目录操作保留尚未提交的终端输入');
    dialog.close();
    await folder;
    production.terminal.input('\r', true);
    await new Promise(resolve => production.terminal.write('\r\n[ops@api ~]$ ', resolve));
    const enterFolder = openLinkedTerminalPath(production, "/srv/app/it's ready");
    await tick();
    findButton(dialog, '进入').click();
    await enterFolder;
    assert(previewCalls.at(-1)[0] === 'input' && previewCalls.at(-1)[1].id === production.id &&
      previewCalls.at(-1)[1].data === "cd -- '/srv/app/it'\\''s ready'\r", '目录操作直接执行安全引用的 cd');
    const readText = api.files.readText;
    api.files.readText = async () => { throw new Error('文件超出编辑器大小限制'); };
    await openLinkedTerminalPath(production, '/srv/app/unreadable.json');
    await tick();
    api.files.readText = readText;
    assert(document.activeElement.id === 'file-editor-title' &&
      [...fileEditor.querySelectorAll('.actions button')].map(b => b.textContent).join('、') === '下载、保存、取消',
      '文件无法编辑时，焦点停在标题，操作顺序一致');
    findButton(fileEditor, '取消').click();
    await tick();
    await openLinkedTerminalPath(production, '/srv/app/config.json');
    await tick();
    assert(fileEditor.open && !dialog.open && fileEditor.querySelector('.cm-line span'), `文件直接打开，按 JSON 格式高亮（${fileEditor.querySelector('[role=status]')?.textContent || '无提示'}）`);
    findButton(fileEditor, '全屏').click();
    await tick();
    assert(fileEditor.clientWidth === innerWidth && fileEditor.clientHeight === innerHeight, '编辑器可填满应用窗口');
    findButton(fileEditor, '下载').click();
    await tick();
    assert(fileEditor.open && previewCalls.at(-1)[0] === 'prepare' && previewCalls.at(-1)[1].names[0] === 'config.json', '下载绑定当前远端文件，保留编辑器');
    fileEditor.querySelector('.cm-content').focus();
    document.execCommand('insertText', false, ' ');
    await tick();
    findButton(fileEditor, '保存').click();
    await tick();
    assert(previewCalls.at(-1)[0] === 'save-text' && previewCalls.at(-1)[1].text.startsWith(' {\r\n') &&
      previewCalls.at(-1)[1].revision === 'original' && findButton(fileEditor, '保存').disabled, '编辑器保存绑定初始版本并保留 CRLF');
    findButton(fileEditor, '取消').click();
    await tick();
    toggleFiles(); await tick();
    assert(!$('files').querySelector('form') && !findButton($('files'), '编辑任务'), '文件区收起路径输入和独立编辑任务入口');
    findButton($('files'), '前往').click();
    await tick();
    const remotePath = dialog.querySelector('input');
    assert(remotePath.value === production.files.directory, '前往目录时填入当前远端路径');
    remotePath.value = '/var/log/归档';
    remotePath.form.requestSubmit();
    await tick();
    assert(production.files.directory === '/var/log/归档', '前往按钮打开指定的远端目录');
    findButton($('files'), '新建 / 上传').click();
    assert([...hostMenu.panel.querySelectorAll('button')].map(b => b.textContent).join('、') === '新建文件、新建目录、上传文件、上传目录',
      '新建和上传共用一个菜单');
    findButton(hostMenu.panel, '上传文件').click();
    await tick();
    assert(previewCalls.at(-1)[0] === 'prepare' && previewCalls.at(-1)[1].direction === 'up' &&
      previewCalls.at(-1)[1].directory === '/var/log/归档', '上传文件沿用当前远端目录');
    findButton($('files'), 'var').click(); await tick();
    assert(previewCalls.at(-1)[1].id === production.id && previewCalls.at(-1)[1].directory === '/var', '面包屑按原主机的绝对路径跳转');
    const selected = $('files').querySelector('input[aria-label="选择 error.log"]'); selected.click();
    findButton($('files'), '所选项 ⋯').click();
    assert(!findButton(hostMenu.panel, '跟踪日志').disabled && !findButton(hostMenu.panel, '重命名').disabled &&
      !findButton(hostMenu.panel, '下载所选项').disabled, '批量下载和文件操作归入所选项菜单');
    hostMenu.panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert(!hostMenu && document.activeElement.textContent === '所选项 ⋯', '菜单 Esc 恢复触发器焦点');
    findButton($('files'), '更多 ⋯').click();
    findButton(hostMenu.panel, '按文件大小排序').click();
    assert(production.files.sort === 'size' && production.files.selected.has('error.log'), '更改排序保留选择');
    const filter = $('files').querySelector('input[type="search"]'); filter.value = 'access'; filter.dispatchEvent(new Event('input'));
    assert(production.files.selected.size === 0, '文件筛选清除隐藏选项');
    selectTab(staging); await tick();
    assert(origin() === staging && $('files').textContent.includes('API 预发'), '切换会话同步文件目标');
    splitLayout = {panes:[production.id,staging.id],direction:'horizontal',ratio:50}; selectTab(production); await tick();
    const connectCount = previewCalls.filter(([type]) => type === 'connect').length;
    splitGrip.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    assert(splitLayout.ratio === 55 && connectCount === previewCalls.filter(([type]) => type === 'connect').length, '分屏调整保留连接');
    splitLayout = undefined; selectTab(production);
    const terminalOverflow = tab => tab.view.querySelector('.xterm-screen').getBoundingClientRect().bottom
      - tab.view.querySelector('.terminal-surface').getBoundingClientRect().bottom;
    await new Promise(resolve => production.terminal.write('output\r\n'.repeat(150) + 'prompt$ ', resolve));
    await tick();
    assert(terminalOverflow(production) <= 0.5, '输出滚到底后最后一行完整显示');
    splitLayout = {panes:[production.id,staging.id],direction:'vertical',ratio:50};
    selectTab(production); await tick();
    const overflow = [production, staging].map(terminalOverflow);
    assert(overflow.every(pixels => pixels <= 0.5), `上下分屏各自完整显示最后一行（溢出像素 ${overflow.join(', ')}）`);
    splitLayout = undefined; selectTab(production);
    assert(document.documentElement.scrollWidth <= innerWidth, '工作台无页面横向溢出');
    api.ssh.connect = async value => previewCalls.push(['connect', value]);
    await openHost(previewHosts[0], { force: true });
    const retryTab = active;
    api.ssh.connect = connect;
    previewListener({ type: 'session', id: retryTab.id, status: 'closed', exited: false, message: 'SSH 连接超时。' });
    assert(tabs.has(retryTab.id) && retryTab.connectionPage.textContent.includes('连接失败') &&
      retryTab.connectionPage.textContent.includes('SSH 连接超时。'), '连接失败留在原标签并显示错误');
    findButton(retryTab.connectionPage, '重新连接').click();
    await tick();
    assert(active === retryTab && retryTab.connectionPage.hidden, '重试在原标签打开终端');
    previewListener({ type: 'session', id: retryTab.id, status: 'closed', exited: false, retryable: true, message: 'SSH 连接已断开。' });
    assert(tabs.has(retryTab.id) && retryTab.connectionPage.textContent.includes('连接已断开'), '意外断线保留标签');
    findButton(retryTab.connectionPage, '重新连接').click();
    await tick();
    splitLayout = { panes: [production.id, retryTab.id], direction: 'horizontal', ratio: 50 };
    selectTab(retryTab);
    previewListener({ type: 'session', id: retryTab.id, status: 'closed', exited: true });
    assert(!tabs.has(retryTab.id) && active === production && !splitLayout, '远端 Shell 正常退出关闭标签并返回另一分屏');
    const report = document.createElement('details');
    report.id = 'smoke-results'; report.style = 'position:fixed;bottom:32px;right:8px;z-index:20;max-width:420px;background:var(--raise);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:11px;max-height:70vh;overflow:auto';
    const summary = document.createElement('summary'); summary.textContent = `✓ ${results.length} 项界面检查通过（模拟数据）`; report.append(summary);
    const lines = document.createElement('pre'); lines.textContent = results.join('\n'); report.append(lines); document.body.append(report);
  } catch (error) {
    const report = document.createElement('pre'); report.id='smoke-results'; report.style='position:fixed;inset:60px 10px auto;z-index:30;background:#512020;color:white;padding:15px'; report.textContent=`失败：${error.stack}\n已通过：${results.join('、')}`; document.body.append(report);
  }
})();
