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
    const infoButton = () => $('session-actions').querySelector('[aria-controls="server-info"]');
    const inputsBeforeInfo = previewCalls.filter(([type]) => type === 'input').length;
    infoButton().click(); await tick();
    assert(!$('server-info').hidden && infoButton().getAttribute('aria-expanded') === 'true' &&
      $('server-info').textContent.includes('Ubuntu 24.04 LTS') && $('server-info').querySelectorAll('[role="meter"]').length === 4,
      '服务器信息一键展开，显示系统、CPU、内存和各挂载点的占用图');
    assert($('server-info').querySelectorAll('.server-info-network').length === 2 &&
      $('server-info').querySelector('.server-info-network').firstChild.textContent === 'eth0' &&
      $('server-info').textContent.includes('2.0 MiB/s') && $('server-info').textContent.includes('512.0 KiB/s') &&
      $('server-info').textContent.includes('累计接收') && $('server-info').textContent.includes('累计发送'),
      '网络优先显示默认路由网卡，按网卡显示速率与累计流量，并排除回环接口');
    assert($('server-info').querySelector('.server-info-network .server-network-chart svg[role="img"]') &&
      Number($('server-info').querySelector('.server-info-network .server-network-chart').dataset.samples) >= 1,
      '网络曲线显示真实采样点和最近五分钟时间范围');
    for (const metric of ['cpu', 'memory']) {
      const chart = $('server-info').querySelector(`.server-usage-chart[data-metric="${metric}"]`);
      assert(chart?.querySelector('svg[role="img"]') && Number(chart.dataset.samples) >= 1 &&
        chart.querySelector('.network-chart-y').textContent === '100%50%0%',
        `${metric} 显示独立的最近五分钟使用率曲线，刻度为 0–100%`);
    }
    assert($('server-info').querySelectorAll('.server-info-disk-io').length === 2 &&
      $('server-info').querySelector('.server-info-disk-io').textContent.includes('2.0 MiB/s') &&
      $('server-info').querySelector('.server-disk-chart svg').getAttribute('aria-label').includes('磁盘读写速度曲线') &&
      Number($('server-info').querySelector('.server-disk-chart').dataset.samples) >= 1,
      '磁盘按设备显示读取/写入速度和最近五分钟双曲线');
    for (const metric of ['iops', 'utilization', 'queueLength']) {
      const charts = [...$('server-info').querySelectorAll(`[data-disk-metric="${metric}"]`)];
      assert(charts.length === 2 && charts.every(chart => Number(chart.dataset.samples) >= 1 &&
        chart.querySelector('svg[role="img"]')) && (metric !== 'utilization' ||
        charts.every(chart => chart.querySelector('.network-chart-y').textContent === '100%50%0%')),
        `每块磁盘显示独立的 ${metric} 五分钟曲线及正确刻度`);
    }
    assert($('server-info').querySelector('.server-info-disk-io').textContent.includes('24 IOPS') &&
      $('server-info').querySelector('.server-info-disk-io').textContent.includes('40%'),
      '磁盘同时显示每秒读写次数与设备忙碌时间占比');
    assert($('server-info').querySelectorAll('.server-disk-latency-chart').length === 2 &&
      [...$('server-info').querySelectorAll('.server-disk-latency-chart')].every(chart => Number(chart.dataset.samples) >= 1 &&
        chart.querySelector('svg').getAttribute('aria-label').includes('平均读写延迟曲线')) &&
      $('server-info').querySelector('.server-info-disk-io').textContent.includes('20 ms') &&
      $('server-info').querySelector('.server-info-disk-io').textContent.includes('60 ms') &&
      $('server-info').querySelector('.server-info-disk-io').textContent.includes('0.8 个请求'),
      '磁盘独立展示平均读写延迟、毫秒双曲线及平均队列长度');
    const originalInfoHeader = $('server-info').querySelector('header');
    findButton($('server-info'), '刷新').click(); await tick();
    assert($('server-info').querySelector('header') === originalInfoHeader &&
      previewCalls.filter(([type]) => type === 'server-info').length === 2 &&
      previewCalls.filter(([type]) => type === 'input').length === inputsBeforeInfo,
      '刷新信息不向终端输入命令，并保留操作按钮和焦点');
    const otherNetworks = $('server-info').querySelector('.server-network-others');
    assert(!otherNetworks.open, '其余网卡默认收起');
    otherNetworks.querySelector('summary').click();
    otherNetworks.querySelector('summary').focus();
    findButton($('server-info'), '刷新').click(); await tick();
    assert($('server-info').querySelector('.server-network-others').open &&
      document.activeElement === $('server-info').querySelector('.server-network-others summary'),
      '刷新保留其他网卡的展开状态及键盘焦点');
    $('server-info').querySelector('.server-network-others summary').click();
    findButton($('session-actions'), '文件').click(); await tick();
    assert($('server-info').hidden && !serverInfoOpen && filesOpen, '文件与服务器信息共用侧栏空间');
    toggleFiles(); infoButton().click(); await tick();
    const serverInfo = api.ssh.serverInfo;
    api.ssh.serverInfo = async () => { throw new Error('fixture timeout'); };
    findButton($('server-info'), '刷新').click(); await tick();
    assert($('server-info').textContent.includes('采集失败') && $('server-info').textContent.includes('上次成功采集'),
      '刷新失败保留上一份数据并明确标记');
    api.ssh.serverInfo = serverInfo;
    findButton($('server-info'), '刷新').click(); await tick();
    assert(!$('server-info').textContent.includes('采集失败'), '采集失败后可刷新重试');
    assert($('server-info').textContent.includes('每 5 秒自动刷新'), '服务器信息说明自动刷新间隔');
    if (innerWidth === 1140) {
      const body = $('server-info').querySelector('.server-info-body');
      body.scrollTop = 120;
      const scroll = body.scrollTop;
      const count = previewCalls.filter(([type]) => type === 'server-info').length;
      await new Promise(resolve => setTimeout(resolve, 5200));
      assert(previewCalls.filter(([type]) => type === 'server-info').length > count &&
        $('server-info').querySelector('.server-info-body').scrollTop === scroll &&
        $('server-info').querySelector('.server-info-network').textContent.includes('2.0 MiB/s'),
        '展开时自动刷新系统与网络数据，保留正在查看的滚动位置');
      assert(Number($('server-info').querySelector('.server-info-network .server-network-chart').dataset.samples) >= 2,
        '自动刷新将新数据追加到网络历史曲线');
      assert([...$('server-info').querySelectorAll('.server-usage-chart')].every(chart => Number(chart.dataset.samples) >= 2),
        '每五秒采集同时更新 CPU 与内存历史曲线');
      assert([...$('server-info').querySelectorAll('.server-disk-chart')].every(chart => Number(chart.dataset.samples) >= 2),
        '每五秒采集同时更新所有磁盘的读写曲线');
      assert([...$('server-info').querySelectorAll('.server-disk-metric-chart')].every(chart => Number(chart.dataset.samples) >= 2),
        'IOPS 和 I/O 利用率随同一轮采样自动追加历史');
      assert([...$('server-info').querySelectorAll('.server-disk-latency-chart, [data-disk-metric="queueLength"]')]
        .every(chart => Number(chart.dataset.samples) >= 2), '延迟和队列长度随同一轮采集自动追加历史');
    }
    findButton($('server-info'), '×').click(); await tick();
    assert($('server-info').hidden && document.activeElement === infoButton(), '关闭服务器信息后焦点回到入口');
    if (innerWidth === 1140) {
      const count = previewCalls.filter(([type]) => type === 'server-info').length;
      const samples = production.networkHistory.length;
      const resourceSamples = production.resourceHistory.length;
      const diskSamples = production.diskHistory.length;
      await new Promise(resolve => setTimeout(resolve, 5200));
      assert(previewCalls.filter(([type]) => type === 'server-info').length === count && production.networkHistory.length === samples &&
        production.resourceHistory.length === resourceSamples && production.diskHistory.length === diskSamples,
        '收起面板后 CPU、内存、网络和磁盘均不再采集或追加曲线数据');
    }
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
      assert(!$('settings-page').querySelector('h1, .page-toolbar') && $('settings-page').getAttribute('aria-label') &&
        $('settings-page').querySelector('form').getAttribute('aria-label'), `${section} 不保留重复标题栏，使用可访问区域名称`);
    }
    openSettings('preferences'); await tick();
    assert($('settings-page').firstElementChild.matches('.settings-form') &&
      !$('settings-page').querySelector('.settings-inline-actions'), '偏好页面移除整个空标题区域，直接显示配置');
    const preferenceForm=$('settings-page').querySelector('form');
    const fontPicker = preferenceForm.querySelector('[role="combobox"][aria-label="终端字体"]');
    assert(fontPicker?.textContent.includes('当前设置（Menlo, monospace）'), '终端字体下拉保留已有的字体设置');
    fontPicker.click();
    const fontOptions = $(fontPicker.getAttribute('aria-controls'));
    assert(fontOptions.textContent.includes('系统默认') && fontOptions.textContent.includes('JetBrains Mono'),
      '终端字体下拉列出默认和本机字体');
    [...fontOptions.querySelectorAll('[role="option"]')].find(option => option.querySelector('.dropdown-text').textContent === 'Menlo').click();
    preferenceForm.requestSubmit(); await tick();
    assert($('settings-page').textContent.includes('已保存。') && !dialog.open, '偏好直接在页面保存并显示结果');
    assert(previewPreferences.fontFamily === '"Menlo", monospace' && production.terminal.options.fontFamily === previewPreferences.fontFamily,
      '所选字体保存后应用到已打开的终端');
    selectTab(production); $('library-button').click(); await tick();
    assert(workspace.dataset.view === 'settings' && !dialog.open, '切回工作台恢复设置页面，不自动切换主机页');
    openSettings('snippets'); await tick();
    findButton($('settings-page'),'新建命令').click(); await tick();
    assert($('settings-page').textContent.includes('命令文本') && !dialog.open, '命令编辑直接在设置页面进行');
    openSettings('groups'); await tick();
    findButton($('settings-page'),'新建分组').click(); await tick();
    assert($('settings-page').textContent.includes('上级分组') && !dialog.open, '分组编辑直接在设置页面进行');
    openSettings('identities'); await tick();
    const identitiesPage = $('settings-page');
    assert(identitiesPage.textContent.includes('可给多台主机复用'), '登录配置列表说明使用位置');
    findButton(identitiesPage, '新建登录配置').click(); await tick();
    const identityForm = identitiesPage.querySelector('form');
    const identityOption = (label, text) => {
      const control = identityForm.querySelector(`[role="combobox"][aria-label="${label}"]`);
      control.click();
      const options = $(control.getAttribute('aria-controls')).querySelectorAll('[role="option"]');
      [...options].find(option => option.querySelector('.dropdown-text > span').textContent === text).click();
    };
    const keyButton = findButton(identityForm, '选择私钥');
    const identityPassword = identityForm.querySelector('input[type="password"]');
    const username = identityForm.querySelector('input[aria-label="SSH 用户名"]');
    assert(!keyButton.getClientRects().length && !identityPassword.getClientRects().length,
      'SSH Agent 只显示 Agent 说明');
    identityOption('从已有主机带入', `${previewHosts[0].name} · ${previewHosts[0].username}`);
    assert(username.value === previewHosts[0].username, '选择主机后带入用户名');
    identityForm.querySelector('button[aria-label="选择SSH 用户名"]').click();
    [...$(username.getAttribute('aria-controls')).querySelectorAll('[role="option"]')]
      .find(option => option.querySelector('.dropdown-text').textContent === 'ops').click();
    assert(username.value === 'ops', '用户名可从已有值直接选择');
    identityOption('认证方式', 'SSH 密码');
    identityPassword.value = 'discarded-test-draft';
    identityOption('认证方式', '本机私钥');
    identityForm.requestSubmit(); await tick();
    assert(!identityPassword.value && !identityPassword.getClientRects().length &&
      identityForm.textContent.includes('请选择要用于此登录配置的私钥'),
      '切换认证会清理旧密码，缺少私钥时不能保存');
    keyButton.click(); await tick();
    $('key-dialog').querySelector('[data-path="/preview/second-key"]').click();
    findButton($('key-dialog'), '确定').click(); await tick();
    assert(identityForm.querySelector('.selected-key-name').textContent === 'second-key', '登录配置从私钥列表选择文件');
    identityForm.requestSubmit(); await tick();
    const identitySave = previewCalls.find(([action]) => action === 'save-identity')?.[1];
    assert(identitySave?.identity.name === 'ops · second-key' && identitySave.identity.keyPath === '/preview/second-key' &&
      !identitySave.localPassword && !identitySave.sourceHostId, '保存时自动命名，只提交所选认证且不关联原主机');
    $('workspace-tools').querySelector('[data-section="security"]').click(); await tick();
    const security = $('settings-page');
    assert(security.getAttribute('aria-label') === '安全与同步' && !security.querySelector('h1') && !document.querySelector('[data-page="vault"]') &&
      !$('vault-protection').checked && !$('vault-startup-unlock') && !$('vault-git-enabled') &&
      findButton(security, '从 Git 恢复'), '主密码保护默认关闭，安全设置保留恢复入口');
    applyVaultState(previewProtected); await tick();
    assert($('vault-auto-lock') && $('security-touch-id').hidden, '应用锁开启时显示闲置策略；不支持触控 ID 时隐藏');
    api.vault.touchIdAvailable = async () => true;
    await refreshTouchIdAvailability();
    assert(!$('security-touch-id').hidden && $('vault-touch-id'), '检测到已录入的触控 ID 后显示解锁选项');
    $('vault-startup-unlock').click(); await tick();
    assert(!$('vault-auto-lock') && !$('vault-touch-id') && $('vault-git-enabled').checked, '关闭应用锁只隐藏锁定策略，Git 同步保持开启');
    findButton(security, '拉取更新').click(); await tick();
    assert(previewCalls.some(([type, request]) => type === 'git-sync' && request.pullOnly) &&
      $('security-git-summary').textContent.includes('最近拉取'), '拉取更新发起只读同步并显示时间');
    $('vault-git-enabled').click(); await tick();
    assert(!$('vault-git-enabled').checked && !findButton(security, '立即同步') && !findButton(security, '保存同步策略'),
      '暂停 Git 后保留绑定，隐藏同步操作与策略');
    $('vault-git-enabled').click(); await tick();
    assert($('vault-git-enabled').checked && findButton(security, '保存同步策略'), '恢复 Git 后重新显示自动同步策略');
    const autoUnlock = security.querySelector('.vault-policy input');
    autoUnlock.click();
    previewListener({ type: 'git-auto', state: { ...vaultStatus, syncAttention: '需要处理冲突。' } });
    assert(autoUnlock.isConnected && autoUnlock.checked && $('security-git-attention').textContent.includes('冲突'),
      '后台状态会更新提示，且保留未保存的策略');
    findButton(security, '保存同步策略').click(); await tick();
    assert(vaultStatus.gitSettings.onUnlock, '自动同步策略保存到当前设备');
    $('vault-protection').click(); await tick();
    assert(dialog.open && dialog.textContent.includes('不加密保存'), '关闭主密码保护前说明影响并要求验证');
    findButton(dialog, '取消').click(); await tick();
    assert($('vault-protection').checked && $('vault-git-enabled').checked, '取消关闭后保留保护和 Git 同步');
    api.vault.touchIdAvailable = async () => false;
    applyVaultState(await api.vault.state());
    selectTab(undefined,'hosts'); await tick();
    const quickEdit=$('host-list').querySelector('.host-quick-edit');
    assert(quickEdit?.getAttribute('aria-label').startsWith('编辑主机'), '主机卡片提供独立快捷编辑按钮');
    quickEdit.click(); await tick();
    assert(dialog.open && dialog.textContent.includes('编辑主机'), '快捷编辑直接打开主机表单');
    assert(!dialog.matches(':modal') && workspace.inert && !document.querySelector('.titlebar').inert &&
      document.elementFromPoint(innerWidth / 2, 6).closest('.titlebar'), '抽屉只阻止内容操作，标题栏仍可接收窗口操作');
    assert(getComputedStyle(dialog).animationName === 'host-drawer-enter', '主机抽屉打开时具有滑入动画');
    const drawerClosed = new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
    findButton(dialog,'取消').click();
    assert(dialog.open && dialog.dataset.closing === 'true', '抽屉关闭时先滑出，再结束对话框');
    await drawerClosed; await tick();
    assert(!workspace.inert && !document.body.classList.contains('overlay-open'), '关闭抽屉恢复工作区交互');
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
    assert(dialog.inert && !picker.inert && picker.getAttribute('aria-modal') === 'true', '嵌套选择器只允许操作最上层弹窗');
    assert(picker.querySelectorAll('[role="radio"]').length === 2 && !picker.querySelector('.key-detail,.key-generator,.key-directories,.settings-switcher'), '私钥选择器只列出已有私钥，不含管理及详情面板');
    assert([...picker.querySelectorAll('.actions button')].map(b=>b.textContent).join('/') === '确定/关闭' && getComputedStyle(findButton(picker,'确定')).backgroundColor !== getComputedStyle(findButton(picker,'关闭')).backgroundColor, '确定按钮位于关闭左侧，使用不同颜色');
    picker.querySelectorAll('[role="radio"]')[1].click();
    assert(picker.open && dialog.querySelector('.selected-key-name').textContent === 'key', '点击私钥只更新选择，确认前不应用');
    findButton(picker,'关闭').click(); await tick();
    assert(dialog.querySelector('.selected-key-name').textContent === 'key' && !dialog.inert && workspace.inert,
      '取消选择保留原有私钥，并恢复下层表单');
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
    const resultsList = dialog.querySelector('.palette-list');
    const choice = resultsList.querySelector('.palette-choice');
    const detail = choice.querySelector('small');
    detail.textContent = 'ops@api.production.example.test · 生产环境 · 后台服务 · 只读运维';
    assert(resultsList.scrollHeight > resultsList.clientHeight &&
      resultsList.getBoundingClientRect().right - choice.getBoundingClientRect().right >= 12 &&
      detail.scrollWidth <= detail.clientWidth + 1 && detail.scrollHeight <= detail.clientHeight + 1,
      '快速查找滚动时为滚动条留出空间，较长的说明可完整换行');
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
    assert(fileEditor.clientWidth === innerWidth && fileEditor.clientHeight === innerHeight - 50 &&
      fileEditor.getBoundingClientRect().top === 50, '编辑器填满内容区并保留窗口标题栏');
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
    assert(splitLayout.tree.ratio === 55 && connectCount === previewCalls.filter(([type]) => type === 'connect').length, '分屏调整保留连接');
    splitLayout = splitFromTree(layoutState.presetTree([staging.id, production.id], 'horizontal', 55));
    selectTab(staging);
    const savedTabIds = [...tabs.keys()];
    $('save-layout').click(); await tick();
    assert(dialog.open && dialog.querySelector('h2').textContent === '保存会话布局',
      '分屏工作区从终端工具栏保存布局');
    dialog.querySelector('input').value = '生产巡检布局';
    dialog.querySelector('form').requestSubmit(); await tick();
    const savedLayout = previewLayouts[0];
    assert(savedLayout.name === '生产巡检布局' && savedLayout.tabs.length === 2 && savedLayout.split.root.ratio === 55 &&
      savedLayout.tabs[savedLayout.split.root.first.index].hostId === staging.host.id &&
      savedLayout.tabs[savedLayout.split.root.second.index].hostId === production.host.id,
      '只保存当前分屏两端及比例，额外标签不加入布局');
    openSettings('layouts'); await tick();
    assert(!$('settings-page').textContent.includes('保存当前布局') &&
      findButton($('settings-page'), '重命名') && findButton($('settings-page'), '删除'),
      '会话布局设置页只提供管理操作');
    findButton($('settings-page'), '重命名').click(); await tick();
    $('settings-page').querySelector('input').value = '巡检双会话';
    $('settings-page').querySelector('form').requestSubmit(); await tick();
    assert(previewLayouts[0].name === '巡检双会话', '会话布局可在管理页重命名');
    const beforeLayoutOpen = previewCalls.filter(([type]) => type === 'connect').length;
    const layoutPalette = openPalette(); await tick();
    const layoutSearch = dialog.querySelector('input');
    layoutSearch.value = '巡检双会话'; layoutSearch.dispatchEvent(new Event('input'));
    const layoutChoice = dialog.querySelector('.palette-choice');
    assert(layoutChoice.textContent.includes('打开布局 · 巡检双会话'), '快速查找直接列出匹配的已保存会话布局');
    layoutChoice.click(); await layoutPalette; await tick();
    const openedLayoutTabs = [...tabs.values()].filter(tab => !savedTabIds.includes(tab.id));
    assert(openedLayoutTabs.length === savedLayout.tabs.length && openedLayoutTabs.every(tab => tab.status === 'idle') &&
      savedTabIds.every(id => tabs.has(id)) && splitLayout.tree.ratio === 55 &&
      splitLayout.panes.map(id => tabs.get(id).host.id).join() === [staging.host.id, production.host.id].join() &&
      active.id === splitLayout.panes[0] &&
      beforeLayoutOpen === previewCalls.filter(([type]) => type === 'connect').length,
      '快速打开布局新建空闲标签并还原分屏，不自动发起 SSH');
    for (const tab of openedLayoutTabs) removeTab(tab);
    openSettings('layouts'); await tick();
    findButton($('settings-page'), '删除').click(); await tick();
    findButton(dialog, '删除').click(); await tick();
    assert(previewLayouts.length === 0 && $('settings-page').textContent.includes('还没有会话布局'),
      '删除后返回会话布局管理空状态');
    const unavailableLayout = { ...savedLayout, id: 'unavailable-layout',
      tabs: [...savedLayout.tabs, { hostId: 'deleted-host', title: '' }] };
    previewLayouts.push(unavailableLayout);
    const beforeUnavailableLayout = tabs.size;
    let unavailableLayoutError;
    try { await openSessionLayout(unavailableLayout); } catch (error) { unavailableLayoutError = error; }
    assert(unavailableLayoutError?.message.includes('主机已删除') && tabs.size === beforeUnavailableLayout,
      '包含已删除主机的布局会提示问题，并在创建标签前停止');
    previewLayouts.length = 0;
    splitGroups.clear(); splitLayout = undefined; selectTab(production);
    const unrelated = await openHost(previewHosts[3], { force: true, connectNow: false });
    selectTab(production);
    const beforeGridConnections = previewCalls.filter(([type]) => type === 'connect').length;
    const gridExtra = await openHost(production.host, { force: true, connectNow: false });
    const gridCreated = await openHost(production.host, { force: true, connectNow: false });
    splitLayout = installSplitLayout(splitFromTree(layoutState.presetTree([production.id, staging.id, gridExtra.id, gridCreated.id], 'grid')));
    selectTab(production); await tick();
    assert(splitLayout.direction === 'tree' && splitLayout.panes.length === 4 &&
      !splitLayout.panes.includes(unrelated.id) && gridCreated?.status === 'idle' &&
      beforeGridConnections === previewCalls.filter(([type]) => type === 'connect').length,
      '布局模型可组合已有会话与空闲会话，保留其他标签');
    const panes = splitLayout.panes.map(id => tabs.get(id));
    const rectangles = panes.map(tab => tab.view.getBoundingClientRect());
    assert(rectangles[0].top < rectangles[1].top && rectangles[0].left < rectangles[2].left &&
      rectangles[2].top < rectangles[3].top &&
      panes.every(tab => !tab.view.hidden) && unrelated.view.hidden,
      '四个会话按左上、右上、左下、右下显示');
    panes[3].view.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    splitGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    splitRowGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert(active === panes[3] && splitLayout.tree.ratio === 55 && splitLayout.tree.first.ratio === 55,
      '点击切换四屏焦点，可分别调整列宽和行高');
    const saveGrid = saveSessionLayout(); await tick();
    dialog.querySelector('input').value = '四屏巡检';
    dialog.querySelector('form').requestSubmit(); await saveGrid; await tick();
    const savedGrid = previewLayouts[0];
    assert(savedGrid.tabs.length === 4 && savedGrid.split.version === 2 &&
      savedGrid.split.root.first.ratio === 55 && !savedGrid.tabs.some(tab => tab.hostId === unrelated.host.id),
      '四屏布局只保存本组会话及行列比例');
    await openSessionLayout(savedGrid); await tick();
    const restoredGrid = splitLayout.panes.map(id => tabs.get(id));
    assert(restoredGrid.length === 4 && restoredGrid.every(tab => tab.status === 'idle') &&
      splitLayout.tree.ratio === 55 && splitLayout.tree.first.ratio === 55 &&
      beforeGridConnections === previewCalls.filter(([type]) => type === 'connect').length,
      '打开四屏布局还原行列尺寸，并等待用户连接');
    removeTab(restoredGrid[0]); await tick();
    assert(splitLayout.panes.length === 3 && splitLayout.direction === 'tree' &&
      restoredGrid.slice(1).every(tab => !tab.view.hidden), '四屏关闭一屏后保留其余三屏');
    removeTab(restoredGrid[1]); await tick();
    assert(splitLayout.panes.length === 2 && splitLayout.tree.axis === 'row',
      '剩余两个会话保留原分支的上下排列');
    restoredGrid[2].paneHeader.querySelector('button:last-child').click(); await tick();
    assert(!splitLayout && tabs.has(restoredGrid[2].id) && active === restoredGrid[2],
      '移出分屏保留会话标签，并聚焦移出的会话');
    const singleLayoutCount = previewLayouts.length;
    let singleLayoutError;
    try { await saveSessionLayout(); } catch (error) { singleLayoutError = error; }
    assert(singleLayoutError?.message.includes('分屏工作区') && previewLayouts.length === singleLayoutCount &&
      $('save-layout').hidden && !dialog.open,
      '独立会话不显示保存布局，也不会创建单屏布局');
    assert(![...document.querySelectorAll('button')].some(button => button.getClientRects().length && ['分屏', '分屏设置'].includes(button.textContent)),
      '分屏设置入口已移除，分屏由拖拽完成');
    for (const tab of restoredGrid.slice(2)) removeTab(tab);
    removeTab(unrelated); removeTab(gridCreated); removeTab(gridExtra);
    previewLayouts.length = 0;
    splitGroups.clear(); splitLayout = undefined; selectTab(production);
    const terminalOverflow = tab => tab.view.querySelector('.xterm-screen').getBoundingClientRect().bottom
      - tab.view.querySelector('.terminal-surface').getBoundingClientRect().bottom;
    await new Promise(resolve => production.terminal.write('output\r\n'.repeat(150) + 'prompt$ ', resolve));
    await tick();
    assert(terminalOverflow(production) <= 0.5, '输出滚到底后最后一行完整显示');
    const terminalBackgroundMatches = tab => {
      const rendered = getComputedStyle(tab.view.querySelector('.xterm-scrollable-element')).backgroundColor;
      return getComputedStyle(tab.view.querySelector('.xterm-viewport')).backgroundColor === rendered &&
        getComputedStyle(tab.view).backgroundColor === rendered;
    };
    const previousTerminalTheme = uiPreferences.terminalTheme;
    const previousHostThemes = [production, staging].map(tab => [tab, tab.host.terminalTheme]);
    for (const theme of ['dark', 'light']) {
      delete production.host.terminalTheme;
      uiPreferences.terminalTheme = theme; applyPreferences(); await tick();
      assert(terminalBackgroundMatches(production), `${theme} 终端底部余量与渲染内容同色，没有默认黑条`);
      const terminalColors = { ...production.terminal.options.theme };
      const previousUITheme = uiPreferences.theme;
      uiPreferences.theme = previousUITheme === 'dark' ? 'light' : 'dark'; applyPreferences();
      assert(['background', 'foreground', 'cursor', 'selectionBackground'].every(key =>
        production.terminal.options.theme[key] === terminalColors[key]),
        `${theme} 终端背景、文字、光标与选区保持独立，不随应用主题改变`);
      uiPreferences.theme = previousUITheme; applyPreferences();
    }
    uiPreferences.terminalTheme = 'dark';
    production.host.terminalTheme = 'dark'; staging.host.terminalTheme = 'light'; applyPreferences();
    splitLayout = {panes:[production.id,staging.id],direction:'vertical',ratio:50};
    selectTab(production); await tick();
    const overflow = [production, staging].map(terminalOverflow);
    assert(overflow.every(pixels => pixels <= 0.5), `上下分屏各自完整显示最后一行（溢出像素 ${overflow.join(', ')}）`);
    assert(terminalBackgroundMatches(production) && terminalBackgroundMatches(staging) &&
      getComputedStyle(production.view).backgroundColor !== getComputedStyle(staging.view).backgroundColor,
      '混合深浅配色分屏的底部余量分别跟随主机配色');
    for (const [tab, theme] of previousHostThemes) {
      if (theme === undefined) delete tab.host.terminalTheme;
      else tab.host.terminalTheme = theme;
    }
    uiPreferences.terminalTheme = previousTerminalTheme; applyPreferences();
    splitGroups.clear(); splitLayout = undefined; selectTab(production);
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

    const resourceHostCount = previewHosts.length;
    const resourceIdentityCount = previewIdentities.length;
    const resourceHosts = Array.from({ length: 120 }, (_, index) => ({
      id: `resource-host-${index}`, name: index > 116 ? '同名主机' : `批量资源 ${index}`,
      address: `resource-${index}.example.test`, port: 2222, username: `operator-${index}`, auth: 'agent',
      group: index % 2 ? '批量甲组' : '批量乙组', tags: ['audit', '批量验证'],
      ...(index === 119 ? { jumpHostId: production.host.id } : {})
    }));
    const resourceIdentities = Array.from({ length: 80 }, (_, index) => ({
      id: `resource-identity-${index}`, name: `批量登录配置 ${index}`, username: `account-${index}`,
      auth: index % 2 ? 'password' : 'agent', hosts: [], groups: []
    }));
    previewHosts.push(...resourceHosts); previewIdentities.push(...resourceIdentities);
    await refreshHosts();
    const resourceCalls = previewCalls.length;
    const setResourceFilter = (root, label, value) => {
      const select = root.querySelector(`[role="combobox"][aria-label="${label}"]`).closest('.dropdown').querySelector('select');
      select.value = value; select.dispatchEvent(new Event('change'));
    };
    const searchResourcePicker = async (root, label, query) => {
      root.querySelector(`[role="combobox"][aria-label="${label}"]`).click(); await tick();
      const panel = root.querySelector('.dropdown-searchable') || document.querySelector('.dropdown-searchable');
      const search = panel.querySelector('input');
      search.value = query; search.dispatchEvent(new Event('input')); await tick();
      return { panel, search };
    };
    const chooseResource = search => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    const routeForm = editHost(production.host); await tick();
    let resourcePicker = await searchResourcePicker(dialog, '连接路径', 'RESOURCE-118 audit');
    const routeSelect = dialog.querySelector('[aria-label="连接路径"]').closest('.dropdown').querySelector('select');
    assert(![...routeSelect.options].some(option => [production.host.id, resourceHosts[119].id].includes(option.value)),
      '可搜索的跳板列表仍排除当前主机和已使用跳板的主机');
    const resourceGroup = resourcePicker.panel.querySelector('select');
    resourceGroup.value = 'group:批量乙组'; resourceGroup.dispatchEvent(new Event('change'));
    assert(resourcePicker.panel.querySelectorAll('[role="option"]').length === 1 &&
      resourcePicker.panel.querySelector('[role="option"]').title.includes('operator-118@resource-118'),
      '跳板机可按地址、标签和分组组合筛选，区分同名主机');
    chooseResource(resourcePicker.search); await tick();
    assert(routeSelect.value === resourceHosts[118].id, '跳板搜索结果按原主机 ID 选中');
    resourcePicker = await searchResourcePicker(dialog, '连接路径', '直连');
    chooseResource(resourcePicker.search); await tick();
    assert(!routeSelect.value, '搜索选择仍可恢复直连');
    resourcePicker = await searchResourcePicker(dialog, '登录配置', 'account-79');
    resourcePicker.panel.querySelector('[data-source="password"]').click();
    assert(resourcePicker.panel.querySelectorAll('[role="option"]').length === 1 &&
      resourcePicker.panel.textContent.includes('SSH 密码'), '登录配置支持用户名搜索和认证方式筛选');
    chooseResource(resourcePicker.search); await tick();
    assert(dialog.querySelector('[aria-label="登录配置"]').closest('.dropdown').querySelector('select').value === 'resource-identity-79',
      '选择登录配置保留其 ID 关联');
    dialog.close(); await routeForm;

    const importIdentity = editIdentity(undefined, undefined, undefined, previewIdentities); await tick();
    resourcePicker = await searchResourcePicker(dialog, '从已有主机带入', 'resource-118 audit');
    assert(!resourcePicker.panel.textContent.includes('其他位置'), '主机带入选择器不显示分屏专用提示');
    chooseResource(resourcePicker.search); await tick();
    assert(dialog.querySelector('input[aria-label="SSH 用户名"]').value === 'operator-118',
      '从大量主机搜索带入登录资料，未混入同名主机');
    dialog.close(); await importIdentity;

    openSettings('groups'); await tick();
    findButton($('settings-page'), '新建分组').click(); await tick();
    resourcePicker = await searchResourcePicker($('settings-page'), '分组登录配置', 'account-79');
    assert(resourcePicker.panel.querySelectorAll('[role="option"]').length === 1,
      '分组默认登录配置同样支持搜索');
    chooseResource(resourcePicker.search); await tick();
    resourcePicker = await searchResourcePicker($('settings-page'), '上级分组', '生产环境');
    assert(resourcePicker.panel.querySelectorAll('[role="option"]').length === 1, '上级分组可按名称和路径搜索');
    closeDropdown(); selectTab(production); await tick();

    const resourceSession = await openHost(resourceHosts[118], { force: true, connectNow: false });
    resourceSession.title = '巡检窗口';
    selectTab(production); chooseSession(); await tick();
    $('session-switcher-search').value = 'RESOURCE-118 audit';
    $('session-switcher-search').dispatchEvent(new Event('input'));
    setResourceFilter($('session-switcher'), '会话切换主机分组', 'group:批量乙组');
    setResourceFilter($('session-switcher'), '会话切换状态', 'idle');
    assert($('session-switcher-results').querySelectorAll('.tab-choice').length === 1 &&
      $('session-switcher-results').textContent.includes('巡检窗口'), '会话切换支持地址与标签搜索、分组与状态组合筛选');
    setResourceFilter($('session-switcher'), '会话切换状态', 'ready');
    assert(!$('session-switcher-results').querySelector('.tab-choice'), '状态筛选排除不匹配的空闲会话');
    previewListener({ type: 'session', id: resourceSession.id, status: 'ready' });
    assert($('session-switcher-results').querySelectorAll('.tab-choice').length === 1,
      '会话状态变化后自动更新筛选结果');
    $('session-switcher-results').querySelector('.tab-choice').click(); await tick();
    assert(active === resourceSession && !$('session-switcher').open, '会话搜索切换复用原连接');

    await addNewTab(); await tick(); const resourceDraft = active;
    $('quick-connect-search').value = 'RESOURCE-118 audit';
    $('quick-connect-search').dispatchEvent(new Event('input'));
    setResourceFilter($('quick-connect-filters'), '新建标签类型', 'host');
    setResourceFilter($('quick-connect-filters'), '新建标签主机分组', 'group:批量乙组');
    setResourceFilter($('quick-connect-filters'), '新建标签标签', 'tag:audit');
    assert($('quick-connect-results').querySelectorAll('.tab-choice').length === 1 &&
      $('quick-connect-results').textContent.includes('resource-118'), '新建标签可组合筛选保存的主机');
    setResourceFilter($('quick-connect-filters'), '新建标签类型', 'session');
    assert($('quick-connect-results').querySelectorAll('.tab-choice').length === 1 &&
      $('quick-connect-results').textContent.includes('巡检窗口'), '新建标签可切换到已有会话搜索');
    $('quick-connect-results').querySelector('.tab-choice').click(); await tick();
    selectTab(resourceDraft); await tick();
    assert(quickConnectFilters.values.type === 'session' && quickConnectFilters.values.group === 'group:批量乙组' &&
      $('quick-connect-search').value === 'RESOURCE-118 audit', '新建标签保留各自的搜索和筛选条件');

    selectTab(production);
    const resourcePalette = openPalette(); await tick();
    const resourceQuery = dialog.querySelector('input[type="search"]');
    resourceQuery.value = 'RESOURCE-118 audit'; resourceQuery.dispatchEvent(new Event('input'));
    setResourceFilter(dialog, '快捷查找类型', 'host');
    assert(dialog.querySelectorAll('.palette-choice').length === 1, '快捷查找可只筛选主机');
    setResourceFilter(dialog, '快捷查找主机分组', 'group:批量甲组');
    assert(!dialog.querySelector('.palette-choice') && dialog.querySelector('button[type="submit"]').disabled,
      '组合筛选无结果时不允许打开其他目标');
    setResourceFilter(dialog, '快捷查找主机分组', 'group:批量乙组');
    setResourceFilter(dialog, '快捷查找类型', 'session');
    assert(dialog.querySelectorAll('.palette-choice').length === 1 && dialog.textContent.includes('巡检窗口'),
      '快捷查找的已有会话也可按原主机地址、标签和分组匹配');
    dialog.querySelector('.palette-choice').click(); await resourcePalette; await tick();
    assert(active === resourceSession && !previewCalls.slice(resourceCalls).some(([type]) =>
      ['connect','input','run','save-host','save-identity','save-layout'].includes(type)),
      '搜索与筛选不连接、不发命令、不写入配置，选中会话沿用原目标');
    selectTab(resourceDraft); await tick();
    const staleResourceChoice = $('quick-connect-results').querySelector('.tab-choice');
    removeTab(resourceSession); await tick();
    assert(!$('quick-connect-results').querySelector('.tab-choice'), '后台会话关闭后立即更新选择结果');
    staleResourceChoice.click(); await tick();
    assert(active === resourceDraft && $('status').textContent.includes('会话已关闭'), '过期的选择操作不能打开已关闭会话');
    removeTab(resourceDraft);
    previewHosts.splice(resourceHostCount); previewIdentities.splice(resourceIdentityCount);
    await refreshHosts(); selectTab(production); await tick();
    const report = document.createElement('details');
    report.id = 'smoke-results'; report.style = 'position:fixed;bottom:32px;right:8px;z-index:20;max-width:420px;background:var(--raise);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:11px;max-height:70vh;overflow:auto';
    const summary = document.createElement('summary'); summary.textContent = `✓ ${results.length} 项界面检查通过（模拟数据）`; report.append(summary);
    const lines = document.createElement('pre'); lines.textContent = results.join('\n'); report.append(lines); document.body.append(report);
  } catch (error) {
    const report = document.createElement('pre'); report.id='smoke-results'; report.style='position:fixed;inset:60px 10px auto;z-index:30;background:#512020;color:white;padding:15px'; report.textContent=`失败：${error.stack}\n已通过：${results.join('、')}`; document.body.append(report);
  }
})();
