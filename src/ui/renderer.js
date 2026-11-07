'use strict';

const api = window.termlume;
const terminalPaths = window.terminalPaths;
const { selectControl, editableControl, close: closeDropdown } = window.dropdowns;
const $ = (id) => document.getElementById(id);
const workspace = $('workspace');
const dialog = $('dialog');
const pageButtons = $('workspace-nav').querySelectorAll('[data-page]');
const tabs = new Map();
const jobs = new Map();
const jobRows = new Map();
const removedJobs = new Set();
const transferFilters = $('transfer-filters').querySelectorAll('button');
const transferHistoryLimit = 200;
const recent = new Map();
const actionLabels = { tail: '查看日志末尾', follow: '跟踪日志', journal: '查看服务日志', disk: '查看磁盘' };
const authLabels = { password: '密码', key: '私钥', agent: 'Agent' };
const jobLabels = { queued: '等待', running: '传输中', committing: '提交中', done: '完成', canceled: '已取消', skipped: '已跳过', failed: '失败', unverified: '待确认' };
const terminalFontSize = 14;
const searchOptions = { decorations: {
  matchBackground: '#544622', matchBorder: '#b49352', matchOverviewRuler: '#b49352',
  activeMatchBackground: '#795120', activeMatchBorder: '#ffd68d', activeMatchColorOverviewRuler: '#ffd68d'
} };
let hosts = [];
let hostsLoaded = false;
let currentGroup = '';
let selectedGroup = '';
let active;
let filesOpen = false;
let vaultStatus = {};
let draggedFileCount = 0;
let transferDirection = '';
let loadingHistory;
let historyReady = false;
let editingHistory = false;

function node(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

function summaryText(tag, text) {
  const element = node(tag, 'text-ellipsis', text);
  element.title = text;
  return element;
}

function message(error) { return String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function sessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function status(text) { $('status').textContent = text; $('status').title = text; }

function button(label, action, className, accessibleName) {
  const element = node('button', className, label);
  element.type = 'button';
  if (accessibleName) { element.setAttribute('aria-label', accessibleName); element.title = accessibleName; }
  element.addEventListener('click', async () => {
    try { await action(); } catch (error) { status(message(error)); }
  });
  return element;
}

function input(value = '', type = 'text') {
  const element = node('input');
  element.type = type;
  element.value = value;
  return element;
}

function field(label, element) { return node('label', '', label, element); }
function chromeIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chrome-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', {
    key: 'M15.5 13.5a5 5 0 1 0-5-5 5 5 0 0 0 .5 2.2L4 17.7V21h3.3l1.5-1.5V17h2.5l2.5-2.5m3.6-7.2h.01',
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
    file: 'M6 3h8l4 4v14H6zM14 3v5h4m-9 5h6m-6 4h6',
    folder: 'M3 6h7l2 2h9v11H3z',
    'new-tab': 'M4 4h16v16H4zM12 8v8m-4-4h8',
    terminal: 'M3 5h18v14H3zM7 9l3 3-3 3m6 0h4',
    sync: 'M20 10a8 8 0 0 0-14-4L4 8m0-4v4h4m-4 6a8 8 0 0 0 14 4l2-2m0 4v-4h-4'
  }[kind]);
  svg.append(path);
  return svg;
}
function settingsIcon(kind) { return node('span', 'settings-icon', chromeIcon(kind)); }
function endpoint(host) { return `${host.username}@${host.address}${host.port === 22 ? '' : `:${host.port}`}`; }
function origin(tab = active) {
  return tab?.kind === 'command' ? tabs.get(tab.sessionId) : tab?.kind === 'shell' ? tab : undefined;
}
function address(path) { return path === '/' ? '' : path.replace(/\/$/, ''); }
function pathOf(tab, name) { return `${address(tab.files.directory)}/${name}`; }

function prompt(title, fields, submit, onSubmit, extra = [], options = {}) {
  if (vaultStatus.locked) return Promise.reject(new Error('请先解锁保险库。'));
  if (dialog.open) return Promise.reject(new Error('请先完成当前弹窗。'));
  return new Promise((resolve) => {
    let result;
    let busy = false;
    dialog.returnValue = '';
    const heading = node('h2', '', title);
    heading.id = 'dialog-title';
    const error = node('p', 'dialog-error');
    error.setAttribute('role', 'alert');
    const canClose = () => !busy && (!options.canClose || options.canClose());
    const cancel = button('取消', () => { if (canClose()) dialog.close(); });
    const confirm = node('button', 'primary', submit);
    confirm.type = 'submit';
    confirm.value = options.submitValue || '';
    const controls = node('div', 'actions', ...extra, cancel, confirm);
    const form = options.drawer
      ? node('form', '', node('div', 'drawer-fields', ...fields, error), controls)
      : node('form', '', ...fields, error, controls);
    dialog.replaceChildren(heading, form);
    dialog.classList.toggle('host-drawer', Boolean(options.drawer));
    const cancelEvent = (event) => { if (!canClose()) event.preventDefault(); };
    dialog.addEventListener('cancel', cancelEvent);
    dialog.addEventListener('close', () => { dialog.removeEventListener('cancel', cancelEvent); dialog.replaceChildren(); resolve(result); }, { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      form.setAttribute('aria-busy', 'true');
      const enabled = [...form.querySelectorAll('button:not(:disabled)')];
      enabled.forEach((control) => { control.disabled = true; });
      error.textContent = '';
      try {
        result = await onSubmit(event.submitter?.value);
        dialog.close();
      } catch (failure) {
        error.textContent = message(failure);
        form.removeAttribute('aria-busy');
        enabled.forEach((control) => { control.disabled = false; });
        busy = false;
      }
    });
    dialog.showModal();
    (options.focus || form.querySelector('input:not([hidden]), .dropdown-trigger'))?.focus();
  });
}

async function confirm(title, text, submit) {
  return prompt(title, [node('p', '', text)], submit, () => true);
}

async function refreshHosts() {
  const [result, timestamps] = await Promise.all([api.hosts.list(), api.hosts.recent()]);
  if (vaultStatus.locked) return;
  hosts = result;
  hostsLoaded = true;
  for (const [id, time] of Object.entries(timestamps)) recent.set(id, time);
  renderHosts();
  if (active?.kind === 'new') renderQuickConnect(active);
}

function applyVaultState(state) {
  vaultStatus = state;
  const transfersSupported = state.fileTransfers !== false;
  document.querySelector('[data-page="transfers"]').hidden = $('queue-button').hidden = !transfersSupported;
  document.body.classList.toggle('vault-locked', state.locked);
  $('vault-lock').hidden = !state.locked;
  if (state.locked) {
    historyReady = false;
    $('terminal-drop').hidden = true;
    closeDropdown();
    for (const pane of [$('key-dialog'), $('session-switcher'), dialog]) if (pane.open) pane.close();
    $('keys-page').replaceChildren();
    hosts = [];
    hostsLoaded = false;
    renderHosts();
    $('quick-connect-results').replaceChildren();
    $('unlock-error').textContent = '';
    $('unlock-secret').focus();
  } else if (transfersSupported && !historyReady) void loadTransferHistory();
  if (workspace.dataset.view === 'vault') renderVaultPage();
}

async function enableVault() {
  const password = input('', 'password');
  const repeated = input('', 'password');
  password.required = repeated.required = true;
  password.minLength = 12;
  password.autocomplete = repeated.autocomplete = 'new-password';
  try {
    while (await prompt('设置主密码', [
      node('p', 'step-label', '第 1 步，共 2 步'),
      node('p', 'muted', '主密码用于解锁保险库，至少需要 12 个字符。'),
      field('主密码', password), field('确认主密码', repeated)
    ], '继续', () => {
      if (password.value.length < 12) throw new Error('主密码至少需要 12 个字符。');
      if (password.value !== repeated.value) throw new Error('两次输入的主密码不同。');
      return true;
    })) {
      const recovery = await api.vault.recoveryCode();
      const saved = input('', 'checkbox');
      saved.required = true;
      const copyStatus = node('small');
      copyStatus.setAttribute('role', 'status');
      let back = false;
      const state = await prompt('保存恢复密钥', [
        node('p', 'step-label', '第 2 步，共 2 步'),
        node('p', 'muted', '忘记主密码时可以用这串密钥解锁。请将它保存在独立的安全位置。'),
        node('div', 'recovery-box', node('code', '', recovery), node('div', 'settings-actions',
          button('复制恢复密钥', async () => { await api.vault.copyRecovery(recovery); copyStatus.textContent = '已复制'; }, 'outlined'), copyStatus)),
        node('label', 'checkbox-row', saved, '我已保存恢复密钥')
      ], '启用保险库', () => api.vault.enable({ password: password.value, recovery }), [
        button('上一步', () => { back = true; dialog.close(); }, 'step-back')
      ], { focus: saved });
      if (state) { applyVaultState(state); status('保险库已启用。'); }
      if (!back) return;
    }
  } finally { password.value = repeated.value = ''; }
}

function unlockMethod() {
  const select = node('select');
  for (const [value, text] of [['password', '主密码'], ['recovery', '恢复密钥']]) {
    const option = node('option', '', text); option.value = value; select.append(option);
  }
  return select;
}

const defaultSyncBranch = 'termlume-vault';

function gitAddressMethod(value) {
  if (/^https:\/\//i.test(value)) return 'https';
  if (/^(ssh:\/\/|[^@\s]+@[^:\s]+:)/i.test(value)) return 'ssh';
}

function githubHttpsAddress(value) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([\w.-]+\/[\w.-]+)\/?$/i.exec(value);
  if (!match) return '';
  return 'https://github.com/' + match[1] + (/\.git$/i.test(match[1]) ? '' : '.git');
}

function gitConnection(remote = '', { allowSaved = false, fixedAddress = false } = {}) {
  const sshAvailable = vaultStatus.gitSsh !== false;
  const savedMethod = gitAddressMethod(remote);
  let method = savedMethod === 'ssh' && (sshAvailable || fixedAddress) ? 'ssh' : 'https';
  const address = input(method === savedMethod || fixedAddress ? remote : githubHttpsAddress(remote));
  address.required = true;
  address.autocomplete = 'off';
  address.readOnly = fixedAddress;
  const username = input();
  username.autocomplete = 'off';
  const token = input('', 'password');
  token.autocomplete = 'off';
  const credentials = node('div', 'git-credential-fields',
    field('Git 用户名', username), field('仓库访问 Token', token),
    node('small', '', 'Token 用来读写仓库。应用会将它保存在本机加密保险库中。'));
  const hint = node('p', 'muted');
  const methods = node('div', 'settings-switcher git-connection-methods');
  methods.setAttribute('role', 'group');
  methods.setAttribute('aria-label', '连接方式');
  const drafts = { [method]: address.value };
  const controls = new Map();
  for (const [value, label] of [['https', 'HTTPS + Token'], ['ssh', 'SSH']]) {
    const control = button(label, () => {
      if (value === method) return;
      drafts[method] = address.value;
      const nextAddress = drafts[value] ?? (value === 'https' ? githubHttpsAddress(address.value.trim()) : '');
      method = value;
      address.value = nextAddress;
      refresh();
    });
    controls.set(value, control);
    methods.append(control);
  }
  const refresh = () => {
    const https = method === 'https';
    for (const [value, control] of controls) control.setAttribute('aria-pressed', String(value === method));
    credentials.hidden = !https;
    address.placeholder = https ? 'https://github.com/owner/repo.git' : 'git@github.com:owner/repo.git';
    hint.textContent = https
      ? '填写 HTTPS 地址。仓库访问 Token 在下方单独填写。'
      : 'SSH 使用本机已有的 SSH 配置。没有配置 SSH 时，请选择 HTTPS + Token。';
    const canReuse = allowSaved && address.value.trim() === remote;
    username.required = token.required = https && (!canReuse || Boolean(username.value || token.value));
  };
  address.addEventListener('input', () => {
    const detected = gitAddressMethod(address.value.trim());
    if (detected === 'https' || (detected === 'ssh' && sshAvailable)) method = detected;
    drafts[method] = address.value;
    token.value = '';
    refresh();
  });
  for (const control of [username, token]) control.addEventListener('input', refresh);
  refresh();
  return {
    token,
    fields: [...(sshAvailable && !fixedAddress ? [methods] : []), hint, field('Git 仓库地址', address), credentials],
    request() {
      const remoteAddress = address.value.trim();
      if (gitAddressMethod(remoteAddress) !== method) {
        throw new Error(method === 'https' ? '请填写以 https:// 开头的仓库地址。' : '请填写仓库的 SSH 地址。');
      }
      return {
        address: remoteAddress,
        ...(method === 'https' && (username.value || token.value) ? { auth: { username: username.value, token: token.value } } : {})
      };
    }
  };
}

function legacyGitKey() {
  const secret = input('', 'password');
  secret.autocomplete = 'off';
  const fieldView = field('旧版同步密钥', secret);
  fieldView.hidden = true;
  return {
    fieldView, secret,
    async submit(action, request) {
      try { return await action({ ...request, ...(secret.value ? { syncKey: secret.value } : {}) }); }
      catch (error) {
        if (message(error).includes('旧版同步密钥')) {
          fieldView.hidden = false;
          secret.required = true;
        }
        throw error;
      }
    }
  };
}

async function restoreVault(fromGit) {
  const connection = fromGit ? gitConnection() : null;
  const branch = input(defaultSyncBranch);
  const legacy = legacyGitKey();
  const secret = input('', 'password');
  secret.required = true;
  const mode = unlockMethod();
  const fields = [node('p', 'muted', '恢复需要空工作区。')];
  if (fromGit) fields.push(...connection.fields, field('同步分支', branch), legacy.fieldView);
  fields.push(field('解锁方式', selectControl(mode, '解锁方式')), field('解锁凭据', secret));
  try {
    const state = await prompt(fromGit ? '从 Git 恢复' : '从加密备份恢复', fields, fromGit ? '恢复' : '选择备份并恢复', () => {
      const request = { secret: secret.value, useRecovery: mode.value === 'recovery' };
      return fromGit
        ? legacy.submit(api.vault.restoreGit, { ...request, ...connection.request(), branch: branch.value })
        : api.vault.restoreFile(request);
    });
    if (state) { applyVaultState(state); await refreshHosts(); status('保险库已恢复。'); }
  } finally {
    secret.value = legacy.secret.value = '';
    if (connection) connection.token.value = '';
  }
}

function conflictDescription(host) {
  if (host.deleted) return '已删除';
  return `${host.name} · ${endpoint(host)} · ${host.auth}${host.group ? ` · ${host.group}` : ''}${host.passwordSaved ? ' · 含已保存密码' : ''}`;
}

async function syncVault(mode) {
  const { remote, branch: currentBranch } = vaultStatus;
  const changeBranch = mode === 'branch';
  const changeConnection = mode === 'connection';
  const connection = !remote || changeConnection ? gitConnection(remote, { allowSaved: Boolean(remote) }) : null;
  const legacy = legacyGitKey();
  let request = {};
  let result;
  try {
    if (connection || changeBranch) {
      const branch = input(currentBranch || defaultSyncBranch);
      const fields = connection ? [...connection.fields] : [];
      if (changeBranch) fields.push(node('p', 'muted', '请先在 Git 服务上创建包含上次同步提交的目标分支，或重命名原分支。'));
      if (!remote || changeBranch) fields.push(field('同步分支', branch));
      const title = changeBranch ? '更改同步分支' : changeConnection ? '更改仓库连接' : '绑定 Git 同步仓库';
      result = await prompt(title, [...fields, legacy.fieldView], remote ? '保存并同步' : '绑定并同步', () => {
        request = { ...connection?.request(), ...(changeConnection ? { changeConnection: true } : {}) };
        if (!remote || changeBranch) request.branch = branch.value;
        return legacy.submit(api.vault.sync, request);
      });
      if (!result && !remote) applyVaultState(await api.vault.state());
    } else {
      status('正在同步保险库…');
      try { result = await legacy.submit(api.vault.sync, request); }
      catch (error) {
        if (legacy.fieldView.hidden) throw error;
        result = await prompt('兼容旧 Git 快照', [
          node('p', 'muted', '这份快照使用了旧版独立密钥。输入一次后，应用会改用保险库主密码保护后续快照。'),
          legacy.fieldView
        ], '解开并同步', () => legacy.submit(api.vault.sync, request));
      }
    }
    await finishGitOperation(result, request, (value) => legacy.submit(api.vault.sync, value), '应用选择并同步', '保险库已同步。');
  } finally {
    legacy.secret.value = '';
    if (connection) connection.token.value = '';
  }
}

async function migrateVault() {
  const pending = vaultStatus.gitMigration;
  const connection = gitConnection(pending?.remote || '', { allowSaved: Boolean(pending), fixedAddress: Boolean(pending) });
  const branch = input(pending?.branch || vaultStatus.branch || defaultSyncBranch);
  branch.readOnly = Boolean(pending);
  const legacy = legacyGitKey();
  const fields = [
    node('p', 'muted', '请使用新的空私有仓库。应用会在新仓库写入一份由保险库主密码保护的快照。其他设备请先同步，再暂停写入旧仓库。'),
    ...connection.fields, field('新同步分支', branch), legacy.fieldView
  ];
  let request = {};
  try {
    const result = await prompt(pending ? '继续迁移 Git 仓库' : '迁移到新仓库', fields, pending ? '继续迁移' : '开始迁移', () => {
      request = { ...connection.request(), branch: branch.value };
      return legacy.submit(api.vault.migrateGit, request);
    });
    await finishGitOperation(result, request, (value) => legacy.submit(api.vault.migrateGit, value), '应用选择并迁移', '保险库已迁移到新仓库。');
  } finally {
    legacy.secret.value = connection.token.value = '';
    const state = await api.vault.state();
    if (state.gitMigration) {
      if (!pending) applyVaultState(state);
      await refreshHosts();
    }
  }
}

async function abandonGitMigration() {
  if (!await confirm('放弃 Git 迁移', '本机将继续使用旧仓库。若新仓库已经收到快照，该快照会保留。', '放弃迁移')) return;
  const result = await api.vault.migrateGit({ abandon: true });
  applyVaultState(result.state);
  await refreshHosts();
  status('已放弃 Git 迁移。');
}

async function finishGitOperation(result, request, submit, label, success) {
  while (result?.conflicts) {
    const { ticket } = result;
    const rows = result.conflicts.map((conflict) => {
      const select = node('select');
      for (const [value, text] of [['', '请选择'], ['local', '保留本机版本'], ['remote', '保留仓库版本']]) {
        const option = node('option', '', text); option.value = value; select.append(option);
      }
      select.required = true;
      const view = node('div', 'import-row', node('p', '', `本机 · ${conflictDescription(conflict.local)}`),
        node('p', '', `仓库 · ${conflictDescription(conflict.remote)}`), selectControl(select, '冲突处理方式'));
      return { id: conflict.id, select, view };
    });
    result = await prompt('解决同步冲突', [node('p', 'muted', '逐条选择保留的版本，密码内容已隐藏。'), node('div', 'key-list', ...rows.map((row) => row.view))], label, () => {
      return submit({ ...request, ticket, choices: Object.fromEntries(rows.map(({ id, select }) => [id, select.value])) });
    });
    if (!result) status('同步冲突待处理。');
  }
  if (result?.state) {
    applyVaultState(result.state);
    await refreshHosts();
    status(result.pending ? `${success}还有较新的本机修改待同步。` : success);
  }
}

function settingsHeading(title, subtitle, actions) {
  return node('header', 'settings-heading', node('div', '', node('h1', '', title), node('p', 'muted', subtitle)), ...(actions ? [actions] : []));
}

function renderVaultPage() {
  const { enabled, remote, branch, fileTransfers, gitMigration, lastSynced, locked } = vaultStatus;
  const page = $('vault-page');
  if (locked) { page.replaceChildren(); return; }
  if (typeof enabled !== 'boolean') {
    page.replaceChildren(settingsHeading('保险库', '正在读取保险库状态…'));
    return;
  }
  const hero = node('section', 'vault-hero', settingsIcon('lock'), node('div', 'vault-summary',
    node('span', enabled ? 'vault-badge online' : 'vault-badge muted', enabled ? '已启用 · 已解锁' : '未启用'),
    node('h2', '', enabled ? '主机资料已加密' : '为主机资料启用加密'),
    node('p', 'muted', enabled ? '闲置 15 分钟后自动锁定。' : '设置主密码后，可用它解锁工作台，也可以导出加密备份。')),
    enabled ? button('锁定保险库', async () => applyVaultState(await api.vault.lock()), 'outlined') : button('启用保险库', enableVault, 'primary'));
  const card = (icon, title, text, action, detail) => node('section', 'vault-card',
    settingsIcon(icon), node('h3', '', title), node('p', 'muted', text), ...(detail ? [detail] : []), action);
  const runGitAction = (action) => async () => {
    const actions = [...page.querySelectorAll('.vault-sync')];
    actions.forEach((action) => { action.disabled = true; });
    try { await action(); } finally {
      actions.forEach((action) => { action.disabled = false; });
    }
  };
  const gitActions = gitMigration ? [
    button('继续迁移', runGitAction(migrateVault), 'primary vault-sync'),
    button('放弃迁移', runGitAction(abandonGitMigration), 'outlined vault-sync')
  ] : [
    button(remote ? '立即同步' : '绑定 Git 仓库', runGitAction(() => syncVault()), 'primary vault-sync')
  ];
  const gitControls = node('div', 'vault-git-controls');
  const gitActionRow = node('div', 'settings-actions', ...gitActions);
  gitControls.append(gitActionRow);
  if (!gitMigration && remote) {
    const settings = node('div', 'vault-git-settings',
      node('div', 'vault-git-setting',
        button('更改仓库连接', runGitAction(() => syncVault('connection')), 'outlined vault-sync'),
        node('small', '', '更新仓库访问 Token，或切换同一仓库的连接方式。')));
    if (lastSynced) settings.append(
      node('div', 'vault-git-setting',
        button('更改同步分支', runGitAction(() => syncVault('branch')), 'outlined vault-sync'),
        node('small', '', '在当前仓库切换分支，沿用已有提交。')),
      node('div', 'vault-git-setting',
        button('迁移到新仓库', runGitAction(migrateVault), 'outlined vault-sync'),
        node('small', '', '在空仓库创建加密快照，旧提交留在原仓库。')));
    settings.id = 'vault-git-settings';
    settings.hidden = true;
    const toggle = button('同步设置', () => {
      settings.hidden = !settings.hidden;
      toggle.setAttribute('aria-expanded', String(!settings.hidden));
    }, 'outlined vault-sync');
    toggle.setAttribute('aria-controls', settings.id);
    toggle.setAttribute('aria-expanded', 'false');
    gitActionRow.append(toggle);
    gitControls.append(settings);
  }
  const gitStatus = gitMigration ? '迁移尚未完成' : remote
    ? (lastSynced ? `最近同步 · ${new Date(lastSynced).toLocaleString()}` : '尚未完成首次同步')
    : '通过专用私有 Git 仓库同步加密资料。';
  const gitDetails = remote ? node('div', 'vault-remote',
    summaryText('code', remote),
    summaryText('code', `分支 · ${branch || defaultSyncBranch}`)) : null;
  const cards = enabled ? [
    ...(fileTransfers === false ? [] : [card('file', '加密备份', '把保险库导出为本地加密文件。', button('导出加密备份', async () => {
      if (await api.vault.export()) status('加密备份已导出。');
    }, 'outlined'))]),
    card('sync', 'Git 同步', gitStatus, gitControls, gitDetails)
  ] : [
    ...(fileTransfers === false ? [] : [card('file', '本地备份', '使用备份文件和原有凭据恢复。', button('从加密备份恢复…', () => restoreVault(false), 'outlined'))]),
    card('sync', 'Git 仓库', '从已同步的私有 Git 仓库恢复。', button('从 Git 恢复…', () => restoreVault(true), 'outlined'))
  ];
  page.replaceChildren(settingsHeading('保险库', '管理主机资料的加密、备份和同步。'), hero,
    node('h2', 'settings-section-label', enabled ? '备份与同步' : '已有保险库？'), node('div', 'vault-grid', ...cards));
}

let keyDirectory;
function keyBrowser(onSelect) {
  const browser = node('div', 'key-browser');
  const list = node('div', 'key-grid');
  const detail = node('section', 'key-detail');
  detail.setAttribute('aria-label', '密钥详情');
  detail.hidden = true;
  const location = node('code', 'key-location', '~/.ssh');
  const note = node('p', 'key-note muted');
  note.setAttribute('role', 'status');
  const search = input('', 'search');
  search.placeholder = '搜索名称、类型或指纹';
  search.setAttribute('aria-label', '搜索密钥');
  const name = input('id_ed25519_termlume');
  name.required = true;
  const passphrase = input('', 'password');
  passphrase.autocomplete = 'new-password';
  const submit = node('button', 'primary', '生成密钥');
  submit.type = 'submit';
  const generator = node('form', 'key-generator', node('h2', '', '生成 Ed25519 密钥'),
    field('密钥文件名', name), field('私钥口令（可选）', passphrase),
    node('div', 'settings-actions', button('取消', hideGenerator), submit));
  generator.hidden = true;
  const generate = button('＋ 生成密钥', () => {
    setSource(false);
    generator.hidden = false;
    name.focus();
    generator.scrollIntoView({ block: 'nearest' });
  }, 'primary');
  const localTab = button('本机密钥', () => setSource(false));
  const agentTab = button('SSH Agent', () => setSource(true));
  const directories = node('div', 'key-directories', node('div', '', node('span', 'muted', '扫描目录'), location),
    node('div', 'settings-actions', button('扫描 ~/.ssh', () => scan(), 'outlined'),
      button('选择目录…', async () => { const directory = await api.keys.directory(); if (directory && browser.isConnected) await scan(directory); }, 'outlined')));
  let rows = [];
  let agentRows = [];
  let localNote = '正在扫描本机密钥…';
  let agentNote = '';
  let fromAgent = false;
  let selected;
  let revision = 0;
  let agentRevision = 0;
  let directoryReady = false;

  function hideGenerator() { passphrase.value = ''; generator.hidden = true; }
  function describe(key) {
    return fromAgent ? key.type : `${key.type} · ${key.private ? (key.encrypted ? '加密私钥' : '私钥') : '仅公钥'}`;
  }
  function showDetail(key) {
    selected = key;
    detail.hidden = !key;
    for (const card of list.children) if (card.key) card.setAttribute('aria-pressed', String(card.key === key));
    if (!key) { detail.replaceChildren(); return; }
    const controls = node('div', 'settings-actions');
    if (key.publicKey) controls.append(button('复制公钥', async () => {
      await api.keys.copy(key.publicKey);
      note.textContent = '已复制公钥。';
    }, 'outlined'));
    if (key.private && onSelect) controls.append(button('使用此密钥', () => onSelect(key.path), 'primary'));
    const facts = node('dl', '',
      node('dt', '', '类型'), node('dd', '', describe(key)),
      node('dt', '', '指纹'), node('dd', '', node('code', '', key.fingerprint || '暂无指纹')));
    if (key.path) facts.append(node('dt', '', '文件路径'), node('dd', '', node('code', '', key.path)));
    detail.replaceChildren(node('div', 'key-detail-heading', node('h2', '', key.name),
      button('×', () => { const card = [...list.children].find((item) => item.key === selected); showDetail(); card?.focus(); }, '', '关闭密钥详情')),
      facts, controls);
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = (fromAgent ? agentRows : rows).filter((key) => (!onSelect || fromAgent || key.private) &&
      `${key.name} ${key.type} ${key.fingerprint || ''}`.toLowerCase().includes(query));
    list.replaceChildren();
    for (const key of visible) {
      const card = button('', () => {
        showDetail(selected === key ? undefined : key);
        if (!detail.hidden) detail.scrollIntoView({ block: 'nearest' });
      }, 'key-card');
      card.key = key;
      card.append(settingsIcon('key'), node('span', 'key-card-label', node('strong', '', key.name), node('small', '', describe(key))));
      list.append(card);
    }
    if (!visible.length) list.append(node('p', 'settings-empty muted', query ? '没有匹配的密钥。' :
      (fromAgent ? '暂无可显示的 Agent 身份。' : onSelect ? '此目录中没有可选的私钥。' : '此目录中没有找到 SSH 密钥。')));
    showDetail(visible.includes(selected) ? selected : undefined);
  }
  function setSource(agent) {
    if (fromAgent !== agent) { selected = undefined; search.value = ''; }
    fromAgent = agent;
    localTab.setAttribute('aria-pressed', String(!agent));
    agentTab.setAttribute('aria-pressed', String(agent));
    directories.hidden = agent;
    if (agent) hideGenerator();
    note.textContent = agent ? agentNote : localNote;
    render();
    if (agent) void loadAgent();
  }
  async function loadAgent() {
    const current = ++agentRevision;
    note.textContent = '正在读取 SSH Agent…';
    try {
      const agent = await api.keys.agent();
      if (current !== agentRevision || !browser.isConnected) return;
      agentRows = agent.keys;
      agentNote = agent.available ? `已加载 ${agent.keys.length} 个身份。` : 'SSH Agent 暂不可用。';
    } catch (error) { agentNote = message(error); }
    if (current === agentRevision && browser.isConnected && fromAgent) { note.textContent = agentNote; render(); }
  }
  async function scan(directory, reveal) {
    const current = ++revision;
    directoryReady = false;
    submit.disabled = true;
    localNote = '正在扫描本机密钥…';
    if (!fromAgent) note.textContent = localNote;
    try {
      const result = await api.keys.scan(directory);
      if (current !== revision || !browser.isConnected) return;
      keyDirectory = result.directory;
      rows = result.keys;
      location.textContent = keyDirectory;
      directoryReady = true;
      localNote = reveal ? `已生成 ${reveal.name}。` : onSelect ? '选择一把私钥用于此主机。' : `找到 ${rows.length} 项密钥。`;
      if (reveal && !fromAgent) { search.value = ''; selected = rows.find((key) => key.path === reveal.path); }
    } catch (error) { if (current === revision) localNote = message(error); }
    if (current !== revision || !browser.isConnected) return;
    submit.disabled = !directoryReady;
    if (!fromAgent) { note.textContent = localNote; render(); }
  }
  generator.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!directoryReady || submit.disabled) return;
    submit.disabled = true;
    try {
      const directory = location.textContent;
      const key = await api.keys.generate({ directory, name: name.value, passphrase: passphrase.value });
      hideGenerator();
      if (browser.isConnected) await scan(directory, key);
    } catch (error) { note.textContent = message(error); }
    finally { passphrase.value = ''; submit.disabled = !directoryReady; }
  });
  search.addEventListener('input', render);
  const heading = onSelect ? node('div', 'key-picker-intro', node('p', 'muted', '选择此主机使用的本机私钥。'), generate)
    : settingsHeading('SSH 密钥', '查找、生成和管理本机 SSH 密钥。', generate);
  browser.append(heading, node('div', 'key-toolbar', node('div', 'settings-switcher', localTab, agentTab), search),
    directories, generator, note, node('div', 'key-body', list, detail));
  setSource(false);
  // Scan after the page or dialog has attached the browser.
  queueMicrotask(() => { if (browser.isConnected) void scan(keyDirectory); });
  return browser;
}

function manageKeys(onSelect) {
  const pane = $('key-dialog');
  if (pane.open) return;
  const title = node('h2', '', '选择 SSH 密钥');
  title.id = 'key-dialog-title';
  pane.replaceChildren(title, keyBrowser((path) => { onSelect(path); pane.close(); }),
    node('div', 'actions', button('关闭', () => pane.close())));
  pane.addEventListener('close', () => pane.replaceChildren(), { once: true });
  pane.showModal();
}

function passwordEditor(host, auth, hasPassword, sameTarget) {
  const password = input('', 'password');
  password.autocomplete = 'new-password';
  password.spellcheck = false;
  password.setAttribute('autocorrect', 'off');
  password.setAttribute('autocapitalize', 'off');
  password.maxLength = 4096;
  const revealed = input();
  revealed.readOnly = true;
  revealed.autocomplete = 'off';
  revealed.spellcheck = false;
  revealed.setAttribute('aria-label', '已保存的 SSH 密码');
  revealed.hidden = true;
  const hint = node('small');
  hint.setAttribute('role', 'status');
  let generation = 0;
  let timer;
  let loading = false;
  const eligible = () => hasPassword && sameTarget();
  const visible = () => password.type === 'text' || !revealed.hidden;
  const update = () => {
    pane.hidden = auth.value !== 'password';
    const saved = eligible();
    password.placeholder = saved ? '留空保留已保存的密码' : '留空可在连接时输入';
    toggle.textContent = visible() ? '隐藏' : !password.value && saved ? '查看已保存' : '显示';
    toggle.setAttribute('aria-label', visible() ? '隐藏 SSH 密码' : !password.value && saved ? '查看已保存的 SSH 密码' : '显示 SSH 密码');
    toggle.disabled = loading || password.form?.getAttribute('aria-busy') === 'true' || (!password.value && !saved);
    hint.textContent = hasPassword && !saved
      ? '连接信息有变更，请为新目标输入密码。'
      : '填写后保存到 macOS 钥匙串。';
  };
  const hide = () => {
    generation++;
    clearTimeout(timer);
    password.type = 'password';
    revealed.value = '';
    revealed.hidden = true;
    loading = false;
    update();
  };
  const toggle = button('显示', async () => {
    if (visible()) { hide(); return; }
    if (password.value) {
      password.type = 'text';
    } else if (eligible()) {
      const request = ++generation;
      loading = true;
      update();
      try {
        const secret = await api.hosts.revealPassword(host.id);
        if (request !== generation || !dialog.open || !dialog.contains(revealed) || !eligible()) return;
        revealed.value = secret;
        revealed.hidden = false;
      } finally {
        if (request === generation) loading = false;
        update();
      }
    } else return;
    update();
    timer = setTimeout(hide, 20_000);
  }, 'outlined');
  const pane = node('div', 'credential-pane', node('div', 'credential-row', field('SSH 密码', password), toggle), revealed, hint);
  password.addEventListener('input', () => {
    if (!revealed.hidden || loading) hide();
    else update();
  });
  return { pane, password, hide, update };
}

async function editHost(host, draftTab) {
  const hasPassword = host?.auth === 'password' && await api.hosts.hasPassword(host.id);
  const name = input(host?.name);
  const addressField = input(host?.address);
  const port = input(host?.port || '22', 'number');
  port.min = 1; port.max = 65535;
  const username = input(host?.username);
  const group = input(host?.group ?? currentGroup);
  group.placeholder = '选择或输入分组';
  const tags = input(host?.tags?.join(', ') || '');
  tags.placeholder = '以逗号分隔';
  const note = input(host?.note);
  const logPath = input(host?.logPath);
  const service = input(host?.service);
  const groups = [...new Set(hosts.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const groupPicker = editableControl(group, '分组', (query) => {
    const matches = groups.filter((value) => !query || value.toLowerCase().includes(query.toLowerCase())).map((value) => ({ value, label: value }));
    if (!query) return [{ value: '', label: '无分组' }, ...matches];
    if (!groups.includes(query)) matches.push({ value: query, label: `新建「${query}」` });
    return matches;
  });
  const auth = node('select');
  for (const [value, label] of [['', '请选择认证方式'], ['agent', 'SSH Agent'], ['key', '本机私钥'], ['password', 'SSH 密码']]) {
    const option = node('option', '', label);
    option.value = value;
    auth.append(option);
  }
  auth.required = true;
  auth.value = host?.auth || 'password';
  const authPicker = selectControl(auth, '认证方式');
  const key = input(host?.keyPath);
  key.placeholder = '选择或填写本机私钥路径';
  const select = button('浏览文件…', async () => { const path = await api.hosts.pickKey(); if (path) key.value = path; }, 'outlined');
  const keyRow = node('div', 'credential-pane', field('私钥文件', key),
    node('div', 'credential-actions', button('从密钥库选择…', () => manageKeys((file) => { key.value = file; }), 'outlined'), select));
  const normalizedAddress = () => addressField.value.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const matches = (item) => item.address.toLowerCase() === normalizedAddress() && item.port === Number(port.value) && item.username === username.value.trim();
  const sameTarget = () => Boolean(host?.auth === 'password' && auth.value === 'password' && matches(host));
  const editor = api.hosts.revealPassword ? passwordEditor(host, auth, hasPassword, sameTarget) : null;
  const updateAuth = () => {
    keyRow.hidden = auth.value !== 'key';
    key.required = auth.value === 'key' && !(host?.auth === 'key' && !host.keyPath);
    if (editor) {
      if (auth.value !== 'password') editor.password.value = '';
      editor.hide();
    }
  };
  auth.addEventListener('change', updateAuth);
  updateAuth();
  for (const required of [addressField, username, port]) required.required = true;
  const draft = () => ({ id: host?.id, name: name.value, address: addressField.value, port: Number(port.value), username: username.value, group: group.value,
    auth: auth.value, keyPath: key.value || undefined, tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), note: note.value, logPath: logPath.value, service: service.value });
  const original = JSON.stringify(draft());
  const duplicate = input('', 'checkbox');
  const duplicateRow = node('label', 'checkbox-row', duplicate, '已有相同地址、端口和用户名，仍保存为另一条配置');
  const duplicateHost = () => !(host && matches(host)) && hosts.some((item) => item.id !== host?.id && matches(item));
  const updateDuplicate = () => {
    duplicateRow.hidden = !duplicateHost();
    duplicate.checked = false;
    editor?.hide();
  };
  for (const element of [addressField, port, username]) element.addEventListener('input', updateDuplicate);
  updateDuplicate();
  const pasteHint = node('p', 'muted', '可粘贴 user@host 或 ssh -p 2222 user@host');
  addressField.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text')?.trim();
    if (!pasted || (!pasted.includes('@') && !/^ssh\s/i.test(pasted))) return;
    event.preventDefault();
    const match = /^(?:ssh\s+)?(?:-p\s+(\d+)\s+)?([^@\s]+)@(\[[\da-f:.%\w-]+\]|[^\s:]+)(?::(\d+))?(?:\s+-p\s+(\d+))?$/i.exec(pasted);
    if (!match || [match[1], match[4], match[5]].filter(Boolean).length > 1) {
      addressField.value = pasted;
      pasteHint.textContent = '无法解析这条命令，请手动填写连接字段。';
      updateDuplicate();
      return;
    }
    username.value = match[2];
    addressField.value = match[3];
    port.value = match[1] || match[4] || match[5] || port.value;
    pasteHint.textContent = '已填入连接信息，请核对后保存。';
    updateDuplicate();
  });
  const details = node('details', 'host-form-section', node('summary', '', '更多设置'), field('标签', tags), field('备注', note), field('常用日志路径', logPath), field('常用 systemd 服务', service));
  const management = host && node('details', 'host-form-section', node('summary', '', '管理主机'), node('div', 'management-actions',
    ...(hasPassword ? [button('清除已保存密码', () => { dialog.close('clear-password'); }, 'outlined')] : []),
    button('忘记指纹', () => { dialog.close('forget'); }, 'outlined'),
    button('删除主机', () => { dialog.close('delete'); }, 'outlined danger')));
  management?.addEventListener('toggle', () => {
    if (management.open) management.scrollIntoView({ block: 'nearest' });
  });
  const save = node('button', '', '保存');
  save.type = 'submit';
  save.value = 'save';
  const conceal = () => editor?.hide();
  let result;
  window.addEventListener('blur', conceal);
  document.addEventListener('visibilitychange', conceal);
  try {
    result = await prompt(host ? '编辑主机' : '新建主机', [
      node('section', 'host-form-section', node('h3', '', '基本信息'), field('主机地址', addressField), pasteHint,
        node('div', 'dialog-row', field('显示名称', name), field('分组', groupPicker))),
      node('section', 'host-form-section', node('h3', '', 'SSH 连接'),
        node('div', 'dialog-row', field('SSH 用户名', username), field('端口', port)), field('认证方式', authPicker),
        keyRow, ...(editor ? [editor.pane] : []), duplicateRow),
      details, ...(management ? [management] : [])
    ], '保存并连接', async (action) => {
      if (duplicateHost() && !duplicate.checked) throw new Error('请确认是否保存重复的连接配置。');
      conceal();
      const localPassword = auth.value === 'password' ? editor?.password.value || undefined : undefined;
      return { hosts: await api.hosts.save({ ...draft(), localPassword }), connect: action === 'connect' };
    }, [save], {
      drawer: true, focus: addressField, submitValue: 'connect',
      canClose: () => (JSON.stringify(draft()) === original && !editor?.password.value) || window.confirm('放弃尚未保存的主机修改？')
    });
  } finally {
    conceal();
    if (editor) editor.password.value = '';
    window.removeEventListener('blur', conceal);
    document.removeEventListener('visibilitychange', conceal);
  }
  if (result) {
    hosts = result.hosts;
    renderHosts();
    if (active?.kind === 'new') renderQuickConnect(active);
    if (result.connect) await openHost(hosts.at(-1), { draftTab });
    return;
  }
  const choice = dialog.returnValue;
  dialog.returnValue = '';
  if (host && choice === 'clear-password' && await confirm('清除已保存密码', `清除「${host.name}」的 SSH 密码？如果它已加入保险库，下次同步时会从仓库的当前快照移除。`, '清除密码')) {
    await api.hosts.clearPassword(host.id);
    status('已清除本机保存的 SSH 密码。');
  } else if (host && choice === 'forget' && await confirm('忘记主机指纹', `仅在你已核对 ${endpoint(host)} 的密钥变更后继续。这也会清除该地址的本机密码记录。`, '忘记指纹')) {
    await api.hosts.forget(host.id);
    status('已清除该地址的信任记录。');
  } else if (host && choice === 'delete' && await confirm('删除主机', `从列表删除「${host.name}」？`, '删除')) {
    hosts = await api.hosts.remove(host.id);
    renderHosts();
  }
}

function openGroup(group) {
  closeDropdown();
  const previous = currentGroup;
  currentGroup = group;
  selectedGroup = group ? '' : previous;
  $('host-search').value = '';
  $('tag-filter').value = '';
  $('tag-filter').dispatchEvent(new Event('input'));
  renderHosts();
  $('host-list').scrollTop = 0;
  const returnCard = [...$('host-list').querySelectorAll('.group-open')].find((card) => card.dataset.group === previous);
  (group ? $('all-hosts') : returnCard || $('host-search')).focus({ preventScroll: true });
}

function groupCard(group, count) {
  const folder = node('span', 'host-icon folder-icon');
  folder.setAttribute('aria-hidden', 'true');
  const card = node('button', 'group-open', folder, node('span', 'host-identity',
    node('strong', '', group), node('small', '', `${count} 台主机`)), node('span', 'group-arrow', '›'));
  card.type = 'button';
  card.dataset.group = group;
  card.setAttribute('aria-label', `打开分组 ${group}，${count} 台主机`);
  card.setAttribute('aria-pressed', String(selectedGroup === group));
  card.title = `${group} · 双击打开分组`;
  card.addEventListener('click', (event) => {
    if (event.detail === 0) { openGroup(group); return; }
    selectedGroup = group;
    for (const item of $('host-list').querySelectorAll('.group-open')) {
      item.setAttribute('aria-pressed', String(item === card));
    }
  });
  card.addEventListener('dblclick', () => openGroup(group));
  return node('div', 'host-row group-row', card);
}

function hostCard(host, showGroup) {
  const icon = node('span', 'host-icon', '›_');
  icon.setAttribute('aria-hidden', 'true');
  const open = button('', () => openHost(host), 'host-open', `连接 ${host.name}`);
  const address = showGroup && host.group ? `${endpoint(host)} · ${host.group}` : endpoint(host);
  open.replaceChildren(icon, node('span', 'host-identity', node('strong', '', host.name), node('small', '', address)));
  open.title = [host.name, address, host.tags?.join(', '), host.note].filter(Boolean).join('\n');
  return node('div', 'host-row', open, node('small', 'host-auth', authLabels[host.auth] || 'SSH'),
    button('⋯', () => editHost(host), 'host-edit', `编辑 ${host.name}`));
}

function hostSection(title, entries) {
  return node('section', 'host-section', node('h2', 'host-group', title), node('div', 'host-entries', ...entries));
}

function hostMatches(host, query) {
  return `${host.name} ${endpoint(host)} ${host.group || ''} ${(host.tags || []).join(' ')} ${host.note || ''}`.toLowerCase().includes(query);
}

function recentFirst(a, b) {
  return (recent.get(b.id) || 0) - (recent.get(a.id) || 0) || a.name.localeCompare(b.name, 'zh-CN');
}

function renderHosts() {
  const groups = new Map();
  for (const host of hosts) {
    if (host.group) groups.set(host.group, (groups.get(host.group) || 0) + 1);
  }
  const tagControl = $('tag-filter');
  if (currentGroup && !groups.has(currentGroup)) {
    currentGroup = selectedGroup = '';
    $('host-search').value = '';
    tagControl.value = '';
    tagControl.dispatchEvent(new Event('input'));
  }
  const scope = currentGroup ? hosts.filter((host) => host.group === currentGroup) : hosts;
  const tags = ['', ...[...new Set(scope.flatMap((host) => host.tags || []).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))];
  if (tags.length !== tagControl.length || tags.some((tag, index) => tagControl.options[index].value !== tag)) {
    const selected = tagControl.value;
    tagControl.replaceChildren(...tags.map((tag) => {
      const option = node('option', '', tag || '全部标签');
      option.value = tag;
      return option;
    }));
    tagControl.value = tags.includes(selected) ? selected : '';
  }
  const tag = tagControl.value;
  const query = $('host-search').value.trim().toLowerCase();
  const searching = Boolean(query || tag);
  const matching = scope.filter((host) => (!tag || host.tags?.includes(tag)) && hostMatches(host, query));
  const visibleHosts = currentGroup || searching ? matching : matching.filter((host) => !host.group);
  visibleHosts.sort(recentFirst);
  const matchingGroups = new Set(matching.map((host) => host.group));
  const visibleGroups = currentGroup ? [] : [...groups]
    .filter(([group]) => !searching || matchingGroups.has(group))
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
  $('host-breadcrumb').hidden = !currentGroup;
  $('current-group').textContent = currentGroup;
  $('remove-group').hidden = !currentGroup;
  $('host-count').textContent = scope.length;
  const list = $('host-list');
  const sections = [];
  if (visibleGroups.length) sections.push(hostSection('分组', visibleGroups.map(([group, count]) => groupCard(group, count))));
  if (visibleHosts.length) sections.push(hostSection(searching ? '匹配的主机' : '主机', visibleHosts.map((host) => hostCard(host, searching && !currentGroup))));
  else if (!searching && visibleGroups.length) sections.push(hostSection('主机', [node('p', 'muted', '暂无未分组的主机')]));
  if (!sections.length) {
    sections.push(searching
      ? node('div', 'host-empty', node('strong', '', '没有匹配的结果'), node('p', '', '试试其他搜索词或清除筛选。'))
      : node('div', 'host-empty', node('span', 'host-icon', '›_'), node('strong', '', '还没有已保存的主机'),
        node('p', '', '保存连接信息后，可从这里打开 SSH 会话。'), button('新建主机', () => editHost(), 'primary')));
  }
  list.replaceChildren(...sections);
}

async function importHosts() {
  const preview = await api.hosts.importPreview();
  if (!preview) return;
  const duplicates = input('', 'checkbox');
  const rows = preview.rows.map((row) => {
    const selected = input('', 'checkbox');
    selected.checked = !row.issue;
    selected.disabled = Boolean(row.issue) && !row.editable;
    const username = input(row.username);
    username.placeholder = 'SSH 用户名';
    const label = node('label', 'checkbox-row', selected, `${row.name} · ${row.address}:${row.port} · ${row.username || '待填写用户'}${row.issue ? ` · ${row.issue}` : ''}`);
    const authentication = node('small', '', row.auth === 'key' ? `本机私钥 · ${row.keyPath}` : 'SSH Agent');
    return { row, selected, username, view: node('div', 'import-row', label, authentication, ...(row.editable ? [field('SSH 用户名', username)] : [])) };
  });
  const result = await prompt('预览 OpenSSH 导入', [...preview.warnings.map((warning) => node('p', 'muted', warning)),
    node('div', 'key-list', ...rows.map((row) => row.view)), node('label', 'checkbox-row', duplicates, '保留重复配置')], '导入所选主机', () => {
    const selected = rows.filter((row) => row.selected.checked).map(({ row, username }) => ({ ...row, username: username.value }));
    if (!selected.length) throw new Error('请选择至少一条可导入的主机。');
    return api.hosts.import({ rows: selected, keepDuplicates: duplicates.checked });
  });
  if (result) { hosts = result.hosts; renderHosts(); status(`已导入 ${result.count} 台主机。`); }
}

function attachTerminal(tab) {
  const view = node('div', 'terminal-view');
  view.hidden = true;
  $('terminal-views').append(view);
  const terminal = new Terminal({
    fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: terminalFontSize, lineHeight: 1.2, scrollback: 6000,
    cursorBlink: tab.kind === 'shell', disableStdin: tab.kind === 'command',
    convertEol: tab.kind === 'command', allowProposedApi: true, minimumContrastRatio: 4.5, theme: {
      background: '#11161f', foreground: '#e8edf6', cursor: '#a6ceff', selectionBackground: '#365579',
      black: '#596578', brightBlack: '#9aa9bf', red: '#f58291', brightRed: '#ffacb7',
      green: '#84d5a4', brightGreen: '#a2e9bb', yellow: '#e7c47d', brightYellow: '#ffdb97',
      blue: '#83aff6', brightBlue: '#a6c7ff', magenta: '#c9a2f4', brightMagenta: '#e0bfff',
      cyan: '#7ccedb', brightCyan: '#a0e7f0', white: '#d3dceb', brightWhite: '#f4f7fc'
    }
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(view);
  const paths = terminalPaths.observe(terminal, (path, text) => {
    const action = path ? openTerminalPath(tab, path) : chooseTerminalPath(tab, text);
    void action.catch((error) => status(message(error)));
  }, () => { if (active === tab) renderTerminalDirectory(); }, () => tab.kind === 'shell' && tab.status === 'ready');
  view.addEventListener('contextmenu', (event) => {
    const selected = terminal.getSelection().trim();
    if (!selected || selected.includes('\n') || !readySession(origin(tab))) return;
    event.preventDefault();
    void chooseTerminalPath(tab, selected).catch((error) => status(message(error)));
  });
  terminal.attachCustomKeyEventHandler((event) => !event.metaKey);
  terminal.onData((data) => {
    paths.invalidate(data);
    if (tab.status === 'ready') api.ssh.input({ id: tab.id, data });
  });
  terminal.onResize((size) => { if (tab.kind === 'shell') api.ssh.resize({ id: tab.id, size }); });
  for (const event of [terminal.onScroll, terminal.onWriteParsed]) event(() => {
    if (active === tab) renderTerminalBottom();
  });
  view.addEventListener('paste', async (event) => {
    if (tab.kind !== 'shell' || tab.status !== 'ready') return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !/[\r\n]/.test(text)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const preview = node('code', 'command-preview', text.length > 1600 ? `${text.slice(0, 1600)}…` : text);
      if (await prompt('确认多行粘贴', [node('p', '', `目标 ${endpoint(tab.host)}`), preview], '粘贴', () => true) && active === tab && tab.status === 'ready') terminal.paste(text);
    } catch (error) { status(message(error)); }
  }, true);
  Object.assign(tab, { view, terminal, fit, search, paths });
}

function selectTab(tab, view = tab?.kind === 'new' ? 'new-tab' : tab ? 'session' : 'hosts') {
  closeDropdown();
  active = tab;
  workspace.dataset.view = view;
  $('work').hidden = view !== 'session';
  $('new-tab-page').hidden = view !== 'new-tab';
  for (const control of pageButtons) {
    const current = control.dataset.page === view;
    $(control.getAttribute('aria-controls')).hidden = !current;
    if (current) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  if (view === 'keys' && !$('keys-page').firstChild) $('keys-page').append(keyBrowser());
  if (view !== 'keys') $('keys-page').replaceChildren();
  if (view === 'vault') renderVaultPage();
  if (view === 'transfers') {
    refreshTransferActions();
    void loadTransferHistory();
  }
  if (tab) tab.used = Date.now();
  if (tab?.kind === 'shell' && tab.status === 'ready') {
    recent.set(tab.host.id, tab.used);
    status(`${tab.host.name} · SSH 已连接`);
  }
  else if (tab?.kind === 'command') status(`${tab.host.name} · ${actionLabels[tab.action]}`);
  else if (view !== 'session') status(({ hosts: '已保存的主机', 'new-tab': '选择要连接的主机', keys: 'SSH 密钥', transfers: '上传和下载记录', vault: '保险库' })[view]);
  $('terminal-find').hidden = true;
  $('terminal-drop').hidden = true;
  renderTerminalBottom();
  for (const entry of tabs.values()) if (entry.view) entry.view.hidden = entry !== tab;
  renderTabs();
  revealActiveTab('smooth');
  if (view === 'hosts') renderHosts();
  renderContext();
  renderFiles();
  if (filesOpen) ensureFiles(origin());
  if (tab?.kind === 'new') {
    $('quick-connect-search').value = tab.query;
    renderQuickConnect(tab);
    $('new-tab-page').scrollTop = 0;
    if (!vaultStatus.locked) $('quick-connect-search').focus({ preventScroll: true });
  } else if (tab) {
    requestAnimationFrame(() => {
      if (active !== tab) return;
      tab.fit.fit();
      focusTerminal(tab);
    });
  }
}

function focusTerminal(tab) {
  if (active === tab && !vaultStatus.locked && !dialog.open && !$('key-dialog').open && !$('session-switcher').open) {
    tab?.terminal?.focus();
  }
}

function updateTabEdges() {
  const strip = $('tabs');
  strip.dataset.moreLeft = String(strip.scrollLeft > 1);
  strip.dataset.moreRight = String(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
}

function revealActiveTab(behavior = 'auto') {
  const strip = $('tabs');
  const row = active?.tabRow;
  if (row) {
    const viewport = strip.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const delta = bounds.left < viewport.left + 2 ? bounds.left - viewport.left - 2
      : Math.max(0, bounds.right - viewport.right + 2);
    if (Math.abs(delta) > 1) {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) behavior = 'auto';
      strip.scrollTo({ left: strip.scrollLeft + delta, behavior });
    }
  }
  updateTabEdges();
}

function tabName(tab) {
  if (tab.kind === 'new') return '新建标签';
  return tab.kind === 'command' ? `${tab.host.name} · ${actionLabels[tab.action]}` : tab.host.name;
}

function tabTitle(tab) {
  return tabName(tab) + (tab.number > 1 ? ` · ${tab.number}` : '');
}

function tabIcon(tab) {
  return chromeIcon(({ new: 'new-tab', command: 'file', shell: 'terminal' })[tab.kind]);
}

function renderTabs() {
  const strip = $('tabs');
  for (const tab of tabs.values()) {
    if (tab.tabRow?.dataset.kind !== tab.kind) {
      const title = tabTitle(tab);
      const open = button('', () => selectTab(tab), 'tab-open', title);
      open.replaceChildren(node('span', 'tab-title', tabName(tab)),
        ...(tab.number > 1 ? [node('span', 'tab-number', String(tab.number))] : []));
      const close = button('×', () => closeTab(tab), 'tab-close', `关闭 ${title}`);
      const icon = tabIcon(tab);
      const leading = tab.kind === 'new' ? node('span', 'tab-leading', icon, close) : close;
      if (tab.kind !== 'new') open.append(icon);
      const row = node('div', 'tab', leading, open);
      row.dataset.kind = tab.kind;
      if (tab.tabRow) tab.tabRow.replaceWith(row);
      else strip.append(row);
      tab.tabRow = row;
    }
    tab.tabRow.dataset.active = String(tab === active);
    tab.tabRow.querySelector('.tab-open').setAttribute('aria-pressed', String(tab === active));
  }
  $('switch-tabs').hidden = tabs.size < 2;
  updateTabEdges();
}

function tabChoice(tab) {
  const detail = tab === active ? '当前标签' : tab.host ? endpoint(tab.host) : '选择主机';
  const choice = button('', () => {
    if ($('session-switcher').open) $('session-switcher').close();
    selectTab(tab);
  }, 'tab-choice');
  choice.append(tabIcon(tab), node('span', '', tabTitle(tab)), node('small', '', detail));
  if (tab === active) choice.setAttribute('aria-current', 'true');
  return choice;
}

function matchingTabs(query) {
  return [...tabs.values()].filter((tab) =>
    `${tabTitle(tab)} ${tab.host ? endpoint(tab.host) : ''}`.toLowerCase().includes(query));
}

function renderSessionSwitcher() {
  const query = $('session-switcher-search').value.trim().toLowerCase();
  const entries = matchingTabs(query).map(tabChoice);
  $('session-switcher-results').replaceChildren(...(entries.length ? entries : [node('p', 'muted', '没有匹配的标签。')]));
}

function chooseSession() {
  const switcher = $('session-switcher');
  if (tabs.size < 2 || vaultStatus.locked || dialog.open || $('key-dialog').open || switcher.open) return;
  closeDropdown();
  $('session-switcher-search').value = '';
  renderSessionSwitcher();
  $('switch-tabs').setAttribute('aria-expanded', 'true');
  switcher.showModal();
  $('session-switcher-search').focus();
}

function quickConnectGroup(title, entries) {
  return node('section', 'quick-connect-group', node('h2', '', title), ...entries);
}

function renderQuickConnect(draftTab) {
  const results = $('quick-connect-results');
  const query = draftTab.query.trim().toLowerCase();
  const matching = hosts.filter((host) => hostMatches(host, query)).sort(recentFirst);
  const visited = query ? [] : matching.filter((host) => recent.has(host.id)).slice(0, 8);
  const groups = [];
  const hostChoice = (host) => {
    const choice = button('', () => openHost(host, { draftTab }), 'tab-choice');
    choice.append(chromeIcon('terminal'), node('span', '', host.name),
      node('small', '', [endpoint(host), host.group].filter(Boolean).join(' · ')));
    choice.title = [host.name, endpoint(host), host.group].filter(Boolean).join(' · ');
    return choice;
  };
  if (visited.length) groups.push(quickConnectGroup('最近连接', visited.map(hostChoice)));
  const saved = matching.filter((host) => !visited.includes(host));
  if (saved.length) groups.push(quickConnectGroup(query ? '匹配的主机' : '已保存的主机', saved.map(hostChoice)));
  if (query) {
    const entries = matchingTabs(query).filter((tab) => tab !== draftTab).map(tabChoice);
    if (entries.length) groups.push(quickConnectGroup('已打开的标签', entries));
  }
  if (!groups.length) {
    const hint = query ? '没有匹配的主机或标签。' : hostsLoaded ? '还没有已保存的主机。' : draftTab.loadError || '正在读取主机…';
    groups.push(quickConnectGroup('快速连接', [node('p', 'muted', hint)]));
  }
  results.replaceChildren(...groups);
}

async function addNewTab() {
  if (vaultStatus.locked) return;
  const tab = { id: sessionId(), kind: 'new', query: '' };
  tabs.set(tab.id, tab);
  selectTab(tab);
  if (!hostsLoaded) {
    try { await refreshHosts(); }
    catch (error) {
      tab.loadError = message(error);
      if (active === tab && tab.kind === 'new') renderQuickConnect(tab);
    }
  }
}

function renderContext() {
  const tab = active;
  const session = origin(tab);
  $('toolbar').hidden = !tab?.terminal;
  renderTerminalDirectory();
  $('session-notice').hidden = true;
  if (!tab?.terminal) return;
  const labels = { idle: '等待连接', connecting: '连接中', trust: '核对主机指纹', ready: '已连接', closed: '已断开', running: '运行中', done: '已完成', stopped: '已停止', failed: '失败' };
  $('context').replaceChildren(node('strong', '', endpoint(tab.host)), node('span', tab.status === 'ready' ? 'online' : 'muted', labels[tab.status] || tab.status));
  const controls = $('session-actions');
  controls.replaceChildren();
  if (tab.kind === 'shell' && tab.status === 'closed') controls.append(button(tab.promptForPassword ? '重新输入密码' : '重连', () => connect(tab)));
  if (tab.kind === 'command') {
    if (session) controls.append(button('返回终端', () => selectTab(session), 'outlined'));
    if (tab.action === 'follow' && ['running', 'connecting'].includes(tab.status)) controls.append(button('停止跟踪', () => api.commands.stop(tab.id)));
  } else {
    const output = [...tabs.values()].findLast((entry) => entry.kind === 'command' && entry.sessionId === tab.id);
    if (output) controls.append(button('查看输出', () => selectTab(output), 'outlined', `查看输出 · ${actionLabels[output.action]}`));
  }
  const shortcuts = button('快捷命令', () => openPalette('commands'));
  shortcuts.disabled = session?.status !== 'ready';
  controls.append(shortcuts);
  const fileButton = button('文件', toggleFiles);
  fileButton.setAttribute('aria-expanded', String(filesOpen && Boolean(session)));
  fileButton.setAttribute('aria-controls', 'files');
  fileButton.disabled = !session;
  controls.append(fileButton);

  const notice = $('session-notice');
  if (tab.status === 'trust') {
    notice.hidden = false;
    notice.replaceChildren(node('strong', '', '核对服务器指纹'), node('p', '', `${endpoint(tab.host)} · ${tab.fingerprint}`), node('div', '',
      button('信任并连接', () => trust(tab, true), 'primary'), button('取消连接', () => trust(tab, false))));
  } else if ((tab.message && ['closed', 'failed'].includes(tab.status)) || tab.passwordSaveError) {
    notice.hidden = false;
    const actions = node('div');
    if (tab.status === 'closed' && tab.usedSavedPassword && !tab.promptForPassword) actions.append(button('重新输入密码', () => connect(tab, true)));
    actions.append(button('收起提示', () => { tab.passwordSaveError = ''; notice.hidden = true; }));
    notice.replaceChildren(node('div', '', tab.message || tab.passwordSaveError), actions);
  }
}

async function trust(tab, accepted) {
  tab.status = 'connecting';
  renderContext();
  await api.ssh.trust({ id: tab.id, accepted });
}

async function enterCredential(tab) {
  const passwordAuth = tab.host.auth === 'password';
  const credential = input('', 'password');
  credential.required = passwordAuth;
  const label = passwordAuth ? 'SSH 密码' : '私钥口令（未加密可留空）';
  const remember = input('', 'checkbox');
  const share = input('', 'checkbox');
  const fields = [node('p', '', endpoint(tab.host)), field(label, credential)];
  if (passwordAuth) {
    fields.push(node('label', 'checkbox-row', remember, '在本机记住密码'));
    if (vaultStatus.enabled) {
      const portable = node('label', 'checkbox-row', share, '同时加入加密备份和 Git 同步');
      portable.hidden = true;
      remember.addEventListener('change', () => { portable.hidden = !remember.checked; if (!remember.checked) share.checked = false; });
      fields.push(portable);
    }
  }
  try {
    return await prompt('SSH 认证', fields, '连接', () => ({ secret: credential.value, remember: remember.checked, sharePassword: share.checked }));
  } finally {
    credential.value = '';
  }
}

async function connect(tab, enterPassword = false) {
  if (tab.status === 'connecting' || !tabs.has(tab.id)) return;
  tab.status = 'connecting';
  tab.paths.reset();
  tab.message = '';
  tab.passwordSaveError = '';
  renderContext();
  try {
    const passwordAuth = tab.host.auth === 'password';
    const useSaved = passwordAuth && !enterPassword && !tab.promptForPassword && await api.hosts.hasPassword(tab.host.id);
    if (!tabs.has(tab.id)) return;
    tab.usedSavedPassword = useSaved;
    if (enterPassword) tab.promptForPassword = true;
    const credentials = tab.host.auth === 'agent' || useSaved ? { secret: '' } : await enterCredential(tab);
    if (!tabs.has(tab.id)) return;
    if (!credentials) { updateSession(tab, 'closed', '已取消连接。'); return; }
    tab.files.generation = (tab.files.generation || 0) + 1;
    tab.files.entries = undefined;
    tab.files.error = '';
    tab.files.loading = false;
    if (tab.attempts++) tab.terminal.write('\r\n\x1b[90m── 正在建立新 SSH 会话 ──\x1b[0m\r\n');
    await api.ssh.connect({ id: tab.id, expected: tab.host, ...credentials, useSaved, dimensions: { rows: tab.terminal.rows, cols: tab.terminal.cols } });
  } catch (error) {
    if (tabs.has(tab.id)) updateSession(tab, 'closed', message(error));
  }
}

async function openHost(host, { force = false, draftTab } = {}) {
  if (draftTab && (active !== draftTab || draftTab.kind !== 'new')) return;
  if (host.auth === 'key' && !host.keyPath) { await editHost(host, draftTab); return; }
  const sessions = [...tabs.values()].filter((tab) => tab.kind === 'shell' && tab.host.id === host.id);
  const existing = sessions.filter((tab) => ['ready', 'trust', 'connecting'].includes(tab.status)
    && ['address', 'port', 'username', 'auth', 'keyPath'].every((field) => tab.host[field] === host[field])).sort((a, b) => b.used - a.used)[0];
  if (existing && !force && !draftTab) { selectTab(existing); return; }
  const tab = draftTab || { id: sessionId() };
  Object.assign(tab, { kind: 'shell', host, status: 'idle', number: Math.max(0, ...sessions.map((entry) => entry.number)) + 1,
    attempts: 0, files: { selected: new Set() } });
  attachTerminal(tab);
  tabs.set(tab.id, tab);
  selectTab(tab);
  await connect(tab);
}

async function closeTab(tab) {
  if (tab.kind === 'shell') {
    const ongoing = [...jobs.values()].filter((job) => job.sessionId === tab.id && ['queued', 'running', 'committing'].includes(job.status));
    if (ongoing.some((job) => job.status === 'committing')) { status('文件正在提交，请等待完成后再关闭会话。'); return; }
    if (ongoing.length && !await confirm('关闭 SSH 会话', `取消「${tab.host.name}」正在传输的 ${ongoing.length} 项任务？`, '取消任务并关闭')) return;
    await api.ssh.close(tab.id);
  } else if (tab.kind === 'command') {
    await api.commands.close(tab.id);
  }
  tabs.delete(tab.id);
  tab.tabRow.remove();
  refreshTransferActions(tab.id);
  for (const acknowledge of tab.pendingAcks?.values() || []) acknowledge();
  tab.terminal?.dispose();
  tab.view?.remove();
  if (active === tab) selectTab(tabs.get(tab.sessionId) || [...tabs.values()].sort((a, b) => b.used - a.used)[0]);
  else {
    renderTabs();
    if (active?.sessionId === tab.id || active?.id === tab.sessionId) {
      renderContext();
      renderFiles();
    }
  }
}

function updateSession(tab, next, detail = '') {
  tab.status = next;
  tab.message = detail;
  if (next === 'ready') {
    recent.set(tab.host.id, Date.now());
    void api.hosts.touch(tab.host.id).catch(() => {});
    status(`${tab.host.name} · SSH 已连接`);
    focusTerminal(tab);
    if (active?.kind === 'new') renderQuickConnect(active);
    if (filesOpen && origin() === tab) ensureFiles(tab);
  } else if (next === 'closed') {
    tab.paths.reset();
    tab.terminal.write(`\r\n\x1b[90m${detail.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m\r\n`);
    status(`${tab.host.name} · ${detail}`);
  }
  if (active === tab || origin() === tab) renderContext();
  if (filesOpen && origin() === tab) renderFiles();
  refreshTransferActions(tab.id);
}

async function openPalette(scope = 'all') {
  const source = active;
  const session = origin();
  const search = input('', 'search');
  const searchLabel = scope === 'commands' ? '搜索快捷命令' : '搜索主机或命令';
  search.placeholder = `${searchLabel}…`;
  search.setAttribute('aria-label', searchLabel);
  const choices = node('div', 'palette-list');
  let selected;
  let entries;
  const choose = (run) => { selected = run; dialog.close(); };
  const update = () => {
    const all = [];
    if (scope !== 'commands') {
      for (const host of hosts) all.push([host.name, endpoint(host), () => openHost(host)]);
    }
    if (readySession(session)) {
      for (const [action, label] of Object.entries(actionLabels)) all.push([label, session.host.name, () => configureCommand(session, action)]);
      all.push(['在新标签连接', session.host.name, () => openHost(session.host, { force: true })]);
    }
    const q = search.value.trim().toLowerCase();
    entries = all.filter(([label, detail]) => `${label} ${detail}`.toLowerCase().includes(q));
    choices.replaceChildren(...entries.map(([label, detail, run]) => {
      const choice = button('', () => choose(run));
      choice.replaceChildren(node('span', '', label), node('small', '', detail));
      return choice;
    }));
    if (!entries.length) {
      const hint = node('p', 'muted', '没有可用的结果。');
      hint.setAttribute('role', 'status');
      choices.append(hint);
    }
    const submit = search.form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !entries.length;
  };
  search.addEventListener('input', update);
  const title = scope === 'commands' ? '快捷命令' : '主机与命令';
  const selection = prompt(title, [search, choices], '打开首项', () => entries[0]?.[2]);
  update();
  const first = await selection;
  const run = selected || first;
  if (!vaultStatus.locked && run) await run();
  else focusTerminal(source);
}

async function configureCommand(session, action, file) {
  const source = active;
  const attempt = session.attempts;
  const profile = hosts.find((host) => host.id === session.host.id && endpoint(host) === endpoint(session.host)) || session.host;
  const argument = input(file || (action === 'journal' ? profile.service || 'sshd.service' : profile.logPath || ''));
  argument.placeholder = action === 'journal' ? '例如 nginx.service' : '/var/log/example.log';
  argument.required = action !== 'disk';
  const lines = input('100', 'number');
  lines.min = 1; lines.max = 10000; lines.required = true;
  const preview = node('code', 'command-preview');
  const request = () => ({ action, argument: argument.value, lines: Number(lines.value) });
  let generation = 0;
  const update = async () => {
    const revision = ++generation;
    try {
      const command = await api.commands.preview(request());
      if (revision === generation) preview.textContent = command;
    } catch (error) { if (revision === generation) preview.textContent = message(error); }
  };
  for (const element of [argument, lines]) element.addEventListener('input', update);
  void update();
  const fields = [node('p', '', `目标 ${endpoint(session.host)}`)];
  if (action !== 'disk') fields.push(field(action === 'journal' ? '服务名' : '日志文件绝对路径', argument), field('行数', lines));
  const details = await prompt(actionLabels[action], [...fields, preview], file ? '打开输出标签' : '运行命令', async () => {
    if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。');
    const command = request();
    return { request: command, preview: await api.commands.preview(command) };
  });
  if (!details || !readySession(session, attempt)) { focusTerminal(source); return; }
  const tab = { id: sessionId(), kind: 'command', sessionId: session.id, host: session.host, action, status: 'connecting' };
  attachTerminal(tab);
  tab.terminal.write(`\x1b[90m$ ${details.preview}\x1b[0m\r\n`);
  tabs.set(tab.id, tab);
  if (file) selectTab(tab);
  else {
    selectTab(session);
    status(`已启动「${actionLabels[action]}」 · 查看输出可打开命令标签`);
  }
  try { await api.commands.start({ id: tab.id, sessionId: session.id, request: details.request }); }
  catch (error) {
    if (!tabs.has(tab.id)) return;
    updateSession(tab, 'failed', message(error));
    if (active === session) status(`${actionLabels[action]}失败 · ${message(error)}`);
  }
}

function toggleFiles() {
  filesOpen = !filesOpen;
  renderContext();
  renderFiles();
  if (filesOpen) ensureFiles(origin());
  else focusTerminal(active);
}

function readySession(tab, attempt = tab?.attempts) {
  return !vaultStatus.locked && tab?.status === 'ready' && tabs.get(tab.id) === tab && tab.attempts === attempt;
}

function renderTerminalDirectory() {
  const control = $('terminal-path');
  const tab = active;
  const directory = tab?.paths?.directory;
  control.hidden = !readySession(origin(tab));
  control.title = directory ? `Shell 上次报告的目录 ${directory} · 打开路径操作` : '打开远端路径 · ⌘ 单击终端中的路径';
}

function renderTerminalBottom() {
  const control = $('terminal-bottom');
  const buffer = active?.terminal?.buffer.active;
  control.hidden = !buffer || buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY;
  if (control.hidden && active) active.newOutput = false;
  control.textContent = active?.newOutput ? '有新输出 · 回到底部 ↓' : '回到底部 ↓';
}

async function currentTerminalDirectory(tab) {
  const reported = tab.paths.uploadDirectory;
  if (reported) return reported;
  const probed = await api.ssh.directory?.(tab.id);
  return terminalPaths.absolute(probed) ? probed : undefined;
}

async function chooseTerminalPath(source = active, selected) {
  const tab = origin(source);
  if (!readySession(tab) || active !== source || dialog.open) return;
  const attempt = tab.attempts;
  const directory = source === tab && !terminalPaths.absolute(selected) ? await currentTerminalDirectory(tab) : undefined;
  if (active !== source || !readySession(tab, attempt) || dialog.open) return;
  const value = input(selected ? terminalPaths.resolve(selected, directory) || selected : directory);
  value.placeholder = '/var/log/app.log';
  const fields = [field('路径', value),
    node('p', 'muted', '可按住 ⌘ 单击路径，也可选中文字后右键打开此窗口。请核对远端路径。')];
  if (source.kind === 'shell') {
    const report = String.raw`termlume_report_dir() { if [[ $PWD != *[[:cntrl:]]* ]]; then printf '\033]1337;CurrentDir=%s\007' "$PWD"; fi; }`;
    const bash = report + String.raw`; PROMPT_COMMAND+=(termlume_report_dir); PS1+='\[\e]133;B\a\]'`;
    const zsh = report + String.raw`; autoload -Uz add-zsh-hook; add-zsh-hook precmd termlume_report_dir; PROMPT+=$'%{\e]133;B\a%}'`;
    fields.push(node('details', 'terminal-path-help', node('summary', '', '启用当前会话的目录识别'),
      node('p', 'muted', '关闭此窗口，在远端空提示符粘贴并执行对应命令一次。'),
      node('strong', '', 'Bash 5.1+'), node('code', 'command-preview', bash),
      node('strong', '', 'Zsh'), node('code', 'command-preview', zsh)));
  }
  const inspected = await prompt('远端路径', fields, '打开', () => {
    const path = terminalPaths.resolve(value.value, directory);
    if (!path) throw new Error('请输入有效的远端路径。');
    if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新选择路径。');
    return api.files.inspect({ id: tab.id, path });
  });
  if (inspected && readySession(tab, attempt)) await openTerminalPath(source, inspected.path, inspected);
}

async function openTerminalPath(source, candidate, inspected) {
  const tab = origin(source);
  if (active !== source || !readySession(tab) || dialog.open) return;
  const attempt = tab.attempts;
  const emptyPrompt = source === tab ? tab.paths.emptyPrompt : undefined;
  const { path, kind, downloadable } = inspected || await api.files.inspect({ id: tab.id, path: candidate });
  if (active !== source || !readySession(tab, attempt) || dialog.open) return;

  const detail = node('p', '', endpoint(tab.host), ' · ', node('code', '', path));
  const downloadPath = async () => {
    if (!readySession(tab, attempt)) return;
    const split = path.lastIndexOf('/');
    await prepareTransfer(tab, 'down', [path.slice(split + 1)], { directory: path.slice(0, split) || '/' });
  };
  if (kind === 'file') {
    const download = await prompt('远端文件', [detail], '下载到本机', () => true);
    if (download) await downloadPath();
  } else if (kind === 'directory') {
    const command = `cd -- '${path.replaceAll("'", "'\\''")}'`;
    if (emptyPrompt && emptyPrompt === tab.paths.emptyPrompt && !tab.pendingAcks?.size) {
      tab.paths.invalidate('\r');
      tab.terminal.focus();
      api.ssh.input({ id: tab.id, data: command + '\r' });
      return;
    }
    const copy = input(command);
    copy.readOnly = true;
    let download = false;
    const actions = path !== '/' && downloadable && api.files.directoryDownloads
      ? [button('下载目录…', () => { download = true; dialog.close(); }, 'outlined')]
      : [];
    const browse = await prompt('远端目录', [detail, field('切换目录命令（可复制）', copy)], '在文件面板中打开', () => true, actions);
    if (download) await downloadPath();
    if (browse && readySession(tab, attempt) && active === source) {
      filesOpen = true;
      renderContext();
      await loadFiles(tab, path);
    }
  } else {
    status('该路径是链接或特殊文件。');
  }
}

function handleFileDrag({ phase, position, count, ticket }) {
  if (phase === 'enter' || phase === 'drop') draggedFileCount = count;
  if (phase === 'leave') draggedFileCount = 0;
  const overlay = $('terminal-drop');
  const tab = active;
  const rect = $('terminal-stage').getBoundingClientRect();
  const eligible = draggedFileCount > 0 && readySession(tab) && !dialog.open &&
    !$('session-switcher').open &&
    position && position.x >= rect.left && position.x < rect.right && position.y >= rect.top && position.y < rect.bottom;
  overlay.hidden = phase === 'drop' || !eligible;
  if (phase === 'drop') {
    draggedFileCount = 0;
    if (eligible) void uploadDroppedFiles(tab, ticket, count).catch((error) => status(message(error)));
  } else if (eligible) {
    const directory = tab.paths.uploadDirectory;
    overlay.textContent = draggedFileCount > 100 ? '每次可上传最多 100 个普通文件。'
      : directory ? `上传到 ${endpoint(tab.host)}:${directory}` : `上传到 ${endpoint(tab.host)} · 松手后读取终端目录`;
  }
}

async function uploadDroppedFiles(tab, ticket, count) {
  if (count > 100) throw new Error('每次可上传最多 100 个普通文件。');
  const attempt = tab.attempts;
  status('正在核对当前终端目录…');
  let directory = await currentTerminalDirectory(tab);
  if (!readySession(tab, attempt) || active !== tab || dialog.open || $('session-switcher').open) return;
  status(`${tab.host.name} · SSH 已连接`);
  if (!directory) {
    directory = await chooseRemoteDirectory(tab, attempt, count);
  }
  if (directory && readySession(tab, attempt)) await prepareTransfer(tab, 'up', undefined, { directory, dropTicket: ticket });
}

async function chooseRemoteDirectory(tab, attempt, count) {
  const path = input(tab.files.directory);
  path.placeholder = '/srv/app';
  const entries = node('div', 'palette-list');
  let revision = 0;
  const browse = async (directory) => {
    const version = ++revision;
    const typed = path.value;
    entries.replaceChildren(node('p', 'muted', '正在读取目录…'));
    try {
      const result = await api.files.list({ id: tab.id, directory });
      if (version !== revision || !entries.isConnected) return;
      if (path.value === typed) path.value = result.directory;
      const folders = result.entries.filter(({ kind }) => kind === 'directory');
      entries.replaceChildren(...folders.map(({ name }) => button(`▸ ${name}`, () => browse(`${address(result.directory)}/${name}`))));
      if (!folders.length) entries.append(node('p', 'muted', '没有子目录。'));
    } catch (error) {
      if (version === revision && entries.isConnected) entries.replaceChildren(node('p', 'danger', message(error)));
    }
  };
  const parent = button('上一级', () => browse(path.value.replace(/\/[^/]+\/?$/, '') || '/'));
  const open = button('浏览', () => browse(path.value), 'outlined');
  const selection = prompt('选择上传目录', [
    node('p', '', `${endpoint(tab.host)} · ${count} 个本机项目`),
    node('p', 'muted', '当前终端目录无法确认。请选择一个远端目录。'),
    field('远端目录', path), node('div', 'file-tools', parent, open), entries
  ], '使用此目录', async () => {
    if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新拖入文件。');
    if (!terminalPaths.absolute(path.value)) throw new Error('请选择远端目录。');
    const result = await api.files.inspect({ id: tab.id, path: path.value });
    if (result.kind !== 'directory') throw new Error('请选择远端目录。');
    return result.path;
  });
  void browse(path.value);
  return selection;
}

function ensureFiles(tab) {
  if (tab?.status === 'ready' && !tab.files.entries && !tab.files.loading && !tab.files.error) {
    void loadFiles(tab, tab.files.directory || tab.paths.uploadDirectory);
  }
}

async function loadFiles(tab, directory) {
  const files = tab.files;
  const generation = files.generation = (files.generation || 0) + 1;
  files.loading = true;
  files.error = '';
  if (origin() === tab) renderFiles();
  try {
    const result = await api.files.list({ id: tab.id, directory });
    if (files.generation !== generation) return;
    if (files.directory !== result.directory) {
      files.selected.clear();
      files.scrollTop = 0;
    }
    Object.assign(files, result);
  } catch (error) {
    if (files.generation === generation) files.error = message(error);
  } finally {
    if (files.generation === generation) { files.loading = false; if (origin() === tab) renderFiles(); }
  }
}

function bytes(size) {
  if (!Number.isFinite(size)) return '—';
  if (size >= 2 ** 30) return `${(size / 2 ** 30).toFixed(1)} GiB`;
  if (size >= 2 ** 20) return `${(size / 2 ** 20).toFixed(1)} MiB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

function renderFiles() {
  const panel = $('files');
  const tab = origin();
  const open = filesOpen && Boolean(tab);
  panel.inert = !open;
  workspace.dataset.files = open ? 'open' : 'closed';
  if (!open) return;
  const files = tab.files;
  const host = node('small', 'file-host', tab.host.name);
  host.title = tab.host.name;
  const heading = node('header', 'file-heading', chromeIcon('folder'),
    node('div', '', node('strong', '', '远端文件'), host), button('×', toggleFiles, '', '关闭文件区'));
  panel.replaceChildren(heading);
  if (tab.status !== 'ready') { panel.append(node('p', 'inline-status muted', '连接 SSH 后可浏览文件。')); return; }
  const directory = input(files.directory || '');
  directory.placeholder = '远端路径';
  directory.setAttribute('aria-label', '远端路径');
  directory.title = files.directory || '';
  const form = node('form', '', directory);
  form.addEventListener('submit', (event) => { event.preventDefault(); void loadFiles(tab, directory.value); });
  const parent = button('↑', () => loadFiles(tab, (files.directory || '').replace(/\/[^/]+\/?$/, '') || '/'), '', '上一级');
  parent.disabled = !files.directory || files.directory === '/';
  panel.append(node('div', 'file-address', parent, form, button('↻', () => loadFiles(tab, files.directory), '', '刷新远端文件')));
  if (files.loading) { panel.append(node('p', 'inline-status muted', '正在读取目录…')); return; }
  if (files.error) panel.append(node('p', 'inline-status danger', files.error));
  if (!files.directory || !files.entries) return;

  const selectable = (kind) => kind === 'file' || (kind === 'directory' && api.files.directoryDownloads);
  const selection = () => files.entries.filter(({ name, kind }) => selectable(kind) && files.selected.has(name));
  const logPath = () => {
    const [entry, other] = selection();
    return entry?.kind === 'file' && !other ? pathOf(tab, entry.name) : undefined;
  };
  const upload = button('↑ 上传', () => prepareTransfer(tab, 'up'));
  const download = button('↓ 下载', () => prepareTransfer(tab, 'down', selection().map(({ name }) => name)));
  const follow = button('跟踪日志', () => configureCommand(tab, 'follow', logPath()));
  const tail = button('查看末尾', () => configureCommand(tab, 'tail', logPath()));
  const mkdir = button('新建文件夹', () => createRemoteItem(tab, true), 'outlined');
  mkdir.prepend(chromeIcon('folder'));
  const touch = button('新建文件', () => createRemoteItem(tab, false), 'outlined');
  touch.prepend(chromeIcon('file'));
  const selectedCount = node('small', 'muted');
  const updateSelection = () => {
    const count = selection().length;
    download.disabled = count === 0;
    follow.disabled = tail.disabled = !logPath();
    selectedCount.textContent = count ? `已选 ${count} 项` : '';
    selectedCount.hidden = count === 0;
  };
  updateSelection();
  panel.append(node('div', 'file-toolbar', node('div', 'file-tools', upload, download, follow, tail),
    node('div', 'file-tools file-create', mkdir, touch, selectedCount)));
  const list = node('div', 'file-list');
  for (const { name, kind, size } of files.entries) {
    const row = node('div', 'file-row');
    if (selectable(kind)) {
      const checkbox = input('', 'checkbox');
      checkbox.checked = files.selected.has(name);
      checkbox.setAttribute('aria-label', `选择 ${name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) files.selected.add(name);
        else files.selected.delete(name);
        row.classList.toggle('selected', checkbox.checked);
        updateSelection();
      });
      row.classList.toggle('selected', checkbox.checked);
      row.append(checkbox);
      if (kind === 'file') row.append(fileEntry(name, kind, () => checkbox.click()));
    }
    if (kind === 'directory') row.append(fileEntry(name, kind, () => loadFiles(tab, pathOf(tab, name))));
    if (kind === 'other') row.append(node('span', 'muted', name));
    row.append(node('small', '', kind === 'directory' ? '目录' : kind === 'file' ? bytes(size) : '链接或特殊文件'));
    if (selectable(kind)) row.append(button('↓', () => prepareTransfer(tab, 'down', [name]), 'file-download', `下载 ${name}`));
    list.append(row);
  }
  if (!files.entries.length) list.append(node('p', 'inline-status muted', '空目录'));
  panel.append(list);
  list.scrollTop = files.scrollTop || 0;
  list.addEventListener('scroll', () => {
    if (list.isConnected) files.scrollTop = list.scrollTop;
  }, { passive: true });
}

function fileEntry(name, kind, action) {
  const entry = button('', action, `file-entry file-entry-${kind}`, name);
  entry.replaceChildren(chromeIcon(kind === 'directory' ? 'folder' : 'file'), node('span', '', name));
  return entry;
}

async function createRemoteItem(tab, folder) {
  const directory = tab.files.directory;
  const attempt = tab.attempts;
  const name = input();
  name.required = true;
  const created = await prompt(folder ? '新建文件夹' : '新建文件', [
    node('p', '', `${tab.host.name} · ${directory}`), field('名称', name)
  ], '创建', async () => {
    if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新打开文件抽屉。');
    await api.files[folder ? 'mkdir' : 'createFile']({ id: tab.id, directory, name: name.value });
    return true;
  });
  if (created && readySession(tab, attempt) && tab.files.directory === directory) await loadFiles(tab, directory);
}

async function prepareTransfer(tab, direction, names, { directory = tab.files.directory, dropTicket } = {}) {
  const attempt = tab.attempts;
  const preparing = direction === 'down' ? '正在准备下载，请选择本机保存位置…' : '正在准备上传…';
  if (origin() === tab) status(preparing);
  let prepared;
  try {
    prepared = await api.files.prepare({ id: tab.id, direction, directory, names, dropTicket });
  } finally {
    if ($('status').textContent === preparing && origin() === tab) status(`${tab.host.name} · SSH 已连接`);
  }
  if (!prepared) return;
  const { ticket, files } = prepared;
  try {
    if (!readySession(tab, attempt)) return;
    const choices = node('select');
    const conflicts = files.filter((file) => file.exists);
    for (const [value, label] of [['skip', '跳过同名文件'], ['keep', '另存为新名称'], ['replace', '覆盖已确认的同名普通文件']]) {
      if (value === 'replace' && conflicts.some((file) => !file.canReplace)) continue;
      const option = node('option', '', label);
      option.value = value;
      choices.append(option);
    }
    const targets = node('ul', 'target-list', ...files.map((file) => node('li', '',
      `${file.target}${file.kind === 'directory' ? '（目录）' : ''}${file.exists ? '（已存在）' : ''}`)));
    const fields = [node('p', '', `${tab.host.name} · ${directory}`), targets];
    const skipped = files.reduce((sum, file) => sum + (file.skipped || 0), 0);
    if (skipped) fields.push(node('p', 'muted', `将跳过 ${skipped} 个链接、特殊文件或不支持的文件名。`));
    if (conflicts.length) fields.push(field('同名文件', selectControl(choices, '同名文件处理方式')));
    const confirmed = await prompt(direction === 'up' ? '确认上传' : '确认下载', fields, '开始传输', async () => {
      if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新选择文件。');
      await api.files.enqueue({ ticket, policy: choices.value });
      return true;
    });
    if (confirmed) status('已加入传输队列，可在「传输记录」查看进度。');
  } finally {
    await api.files.discard(ticket);
  }
}

function loadTransferHistory() {
  if (loadingHistory) return loadingHistory;
  const feedback = $('transfer-feedback');
  feedback.textContent = '正在读取传输记录…';
  feedback.hidden = false;
  loadingHistory = api.files.history().then((records) => {
    if (vaultStatus.locked) return;
    for (const record of records) if (!jobs.has(record.id)) updateJob(record, true);
    historyReady = true;
    feedback.hidden = true;
    renderTransferSummary();
  }).catch((error) => {
    feedback.textContent = message(error);
  }).finally(() => { loadingHistory = undefined; });
  return loadingHistory;
}

function forgetJob(id) {
  jobRows.get(id)?.element.remove();
  jobRows.delete(id);
  jobs.delete(id);
}

async function removeDownloadHistory(id = null) {
  if (editingHistory || !historyReady) return;
  editingHistory = true;
  renderTransferSummary();
  try {
    if (!id && !await confirm('清空下载记录', '将移除所有已结束的下载记录。已下载的文件会保留。', '清空记录')) return;
    const ids = await api.files.removeHistory(id);
    for (const removed of ids) {
      removedJobs.add(removed);
      forgetJob(removed);
    }
    if (ids.length) status(id ? '已删除下载记录。' : '已清空下载记录。');
  } finally {
    editingHistory = false;
    renderTransferSummary();
  }
}

function renderTransferSummary() {
  let running = 0;
  let failed = 0;
  let shownActive = 0;
  let shownHistory = 0;
  let canClear = false;
  for (const job of jobs.values()) {
    const visible = !transferDirection || job.direction === transferDirection;
    jobRows.get(job.id).element.hidden = !visible;
    if (job.finishedAt) {
      if (visible) shownHistory += 1;
      if (job.direction === 'down') canClear = true;
      if (!job.archived && ['failed', 'unverified'].includes(job.status)) failed += 1;
    } else {
      running += 1;
      if (visible) shownActive += 1;
    }
  }
  $('queue-button').textContent = `⇄ 传输记录${running ? ` · ${running} 项进行中` : ''}${failed ? ` · ${failed} 项待处理` : ''}`;
  $('transfer-active-empty').hidden = shownActive > 0;
  $('transfer-history-empty').hidden = !historyReady || shownHistory > 0;
  $('clear-downloads').disabled = !historyReady || editingHistory || !canClear;
}

function updateJob(event, archived = false) {
  if (removedJobs.has(event.id)) return;
  const previous = jobs.get(event.id);
  if (previous?.finishedAt && !event.finishedAt) return;
  const job = { ...event, archived };
  const finished = Boolean(job.finishedAt);
  const firstLiveCompletion = finished && !archived && (!previous?.finishedAt || previous.archived);
  jobs.set(job.id, job);
  let row = jobRows.get(job.id);
  if (!row) {
    const name = node('strong');
    const meta = node('small');
    const source = node('code');
    const target = node('code');
    const meter = node('progress');
    meter.setAttribute('aria-label', '传输进度');
    const state = node('span', 'job-state');
    const controls = node('div', 'job-actions');
    const error = node('div', 'job-error');
    const element = node('article', 'job',
      node('div', 'job-header', node('div', 'job-identity', name, meta), state),
      node('div', 'job-paths', node('small', '', '来源'), source, node('small', '', '目标'), target),
      meter, error, controls);
    element.dataset.id = job.id;
    row = { element, name, meta, source, target, meter, state, controls, error };
    jobRows.set(job.id, row);
  }
  const upload = job.direction === 'up';
  row.name.textContent = job.remote.split('/').pop() || job.remote;
  row.meta.textContent = [upload ? '上传' : '下载', job.host,
    finished ? new Date(job.finishedAt).toLocaleString() : ''].filter(Boolean).join(' · ');
  row.source.textContent = upload ? job.local : job.remote;
  row.target.textContent = upload ? job.remote : job.local;
  row.meter.max = Math.max(1, job.size);
  row.meter.value = job.status === 'done' ? row.meter.max : job.bytes;
  row.meter.hidden = finished;
  row.state.textContent = `${jobLabels[job.status]} · ${bytes(job.bytes)} / ${bytes(job.size)}`;
  row.state.dataset.status = job.status;
  row.error.textContent = job.message;
  row.error.hidden = !job.message;
  renderJobActions(job, row);
  const list = $(finished ? 'transfer-history' : 'transfer-active');
  if (row.element.parentNode !== list) {
    if (finished) {
      row.element.dataset.finishedAt = job.finishedAt;
      const older = [...list.children].find((entry) => Number(entry.dataset.finishedAt) <= job.finishedAt);
      list.insertBefore(row.element, older || null);
      if (list.children.length > transferHistoryLimit) forgetJob(list.lastElementChild.dataset.id);
    } else list.prepend(row.element);
  }
  const tab = tabs.get(job.sessionId);
  if (firstLiveCompletion && job.status === 'done' && upload && tab?.files.directory &&
    pathOf(tab, job.remote.split('/').pop()) === job.remote) void loadFiles(tab, tab.files.directory);
  if (!archived) renderTransferSummary();
}

function refreshTransferActions(sessionId) {
  if (workspace.dataset.view !== 'transfers') return;
  for (const job of jobs.values()) {
    if (!sessionId || job.sessionId === sessionId) renderJobActions(job, jobRows.get(job.id));
  }
}

function renderJobActions(job, row) {
  const tab = tabs.get(job.sessionId);
  const retry = !job.archived && readySession(tab) && ['failed', 'canceled'].includes(job.status);
  const state = `${job.status}:${Boolean(tab)}:${retry}`;
  if (row.actionState === state) return;
  row.actionState = state;
  const controls = [];
  if (['queued', 'running'].includes(job.status)) controls.push(button('取消', () => api.files.cancel(job.id)));
  if (retry) controls.push(button('重试', () => api.files.retry(job.id)));
  if (tab) controls.push(button('转到会话', () => { if (tabs.has(tab.id)) selectTab(tab); }));
  if (job.finishedAt && job.direction === 'down') {
    controls.push(button('删除记录', () => removeDownloadHistory(job.id), '', `删除下载记录 ${job.remote}`));
  }
  row.controls.hidden = !controls.length;
  row.controls.replaceChildren(...controls);
}

api.onEvent((event) => {
  if (event.type === 'vault') { applyVaultState(event.state); return; }
  if (event.type === 'file-drag') { handleFileDrag(event); return; }
  const tab = tabs.get(event.id);
  if (event.type === 'output') {
    if (!tab) { api.ssh.ack(event.ack); return; }
    const pending = tab.pendingAcks ||= new Map();
    const acknowledge = () => { if (pending.delete(event.ack)) api.ssh.ack(event.ack); };
    pending.set(event.ack, acknowledge);
    tab.paths.invalidate();
    if (tab.terminal.buffer.active.viewportY < tab.terminal.buffer.active.baseY) tab.newOutput = true;
    tab.terminal.write(event.bytes, acknowledge);
  } else if (event.type === 'transfer') updateJob(event);
  else if (tab && event.type === 'trust') {
    tab.fingerprint = event.fingerprint;
    updateSession(tab, 'trust');
  } else if (tab && event.type === 'password') {
    tab.passwordSaveError = event.failed ? event.message : '';
    if (!event.failed) tab.promptForPassword = false;
    status(`${tab.host.name} · ${event.message}`);
    if (tab === active) renderContext();
  } else if (tab) {
    if (event.retryWithPassword) tab.promptForPassword = true;
    updateSession(tab, event.status, event.message);
  }
});

new ResizeObserver(() => active?.fit?.fit()).observe($('terminal-stage'));
const tabStrip = $('tabs');
new ResizeObserver(() => revealActiveTab()).observe(tabStrip);
tabStrip.addEventListener('scroll', updateTabEdges, { passive: true });
tabStrip.addEventListener('wheel', (event) => {
  if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
    tabStrip.scrollWidth <= tabStrip.clientWidth) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabStrip.clientWidth : 1;
  tabStrip.scrollLeft += event.deltaY * unit;
}, { passive: false });
$('host-search').addEventListener('input', renderHosts);
$('tag-filter').addEventListener('change', renderHosts);
$('all-hosts').addEventListener('click', () => openGroup(''));
$('import-hosts').addEventListener('click', () => importHosts().catch((error) => status(message(error))));
$('remove-group').addEventListener('click', async () => {
  const group = currentGroup;
  if (!group) return;
  try {
    if (!await confirm('移除分组', `「${group}」内的主机会归入未分组。`, '移除分组')) return;
    hosts = await api.hosts.removeGroup(group);
    renderHosts();
  } catch (error) { status(message(error)); }
});
for (const control of pageButtons) {
  control.addEventListener('click', () => {
    const page = control.dataset.page;
    if (page !== workspace.dataset.view) selectTab(undefined, page);
  });
}
if (api.chrome) {
  const titlebar = document.querySelector('.titlebar');
  const isChromeClick = (event) => event.button === 0 && !event.target.closest('button, a, input');
  const reportWindowError = (error) => status(message(error));
  let dragOrigin;
  titlebar.addEventListener('mousedown', (event) => {
    if (!isChromeClick(event)) return;
    event.preventDefault();
    dragOrigin = [event.screenX, event.screenY];
  });
  // Starting a native drag on mouse-down can consume the first click in WebKit.
  window.addEventListener('mousemove', (event) => {
    if (!dragOrigin) return;
    if (!(event.buttons & 1)) { dragOrigin = undefined; return; }
    if (Math.hypot(event.screenX - dragOrigin[0], event.screenY - dragOrigin[1]) < 4) return;
    dragOrigin = undefined;
    api.chrome.startDragging().catch(reportWindowError);
  });
  for (const type of ['mouseup', 'blur']) window.addEventListener(type, () => { dragOrigin = undefined; });
  titlebar.addEventListener('dblclick', (event) => {
    if (isChromeClick(event)) api.chrome.toggleMaximize().catch(reportWindowError);
  });
}
$('unlock-form').querySelector('.settings-icon').replaceWith(settingsIcon('lock'));
$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('unlock-error').textContent = '';
  const secret = $('unlock-secret');
  try {
    applyVaultState(await api.vault.unlock({ secret: secret.value, useRecovery: $('unlock-mode').value === 'recovery' }));
    await refreshHosts();
    selectTab(active, workspace.dataset.view);
  } catch (error) { $('unlock-error').textContent = message(error); }
  finally { submit.disabled = false; secret.value = ''; }
});
let lastActivity = 0;
for (const type of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(type, () => {
    if (vaultStatus.locked || Date.now() - lastActivity < 1000) return;
    lastActivity = Date.now();
    api.vault.activity();
  }, { passive: true });
}
$('add-host').addEventListener('click', () => editHost().catch((error) => status(message(error))));
const hostLayout = $('host-layout');
try { if (localStorage.getItem('host-layout') === 'rows') hostLayout.value = 'rows'; } catch { /* Card view is the default. */ }
workspace.dataset.hostLayout = hostLayout.value;
const hostLayoutPicker = selectControl(hostLayout);
hostLayoutPicker.classList.add('host-layout');
selectControl($('tag-filter'));
selectControl($('unlock-mode'));
hostLayout.addEventListener('change', () => {
  workspace.dataset.hostLayout = hostLayout.value;
  try { localStorage.setItem('host-layout', hostLayout.value); } catch { /* Use the in-memory choice. */ }
});
const toggleNav = $('toggle-nav');
function setNavigationCollapsed(collapsed) {
  workspace.dataset.navCollapsed = String(collapsed);
  toggleNav.setAttribute('aria-expanded', String(!collapsed));
  toggleNav.title = collapsed ? '展开导航' : '收起导航';
  toggleNav.setAttribute('aria-label', toggleNav.title);
}
try { setNavigationCollapsed(localStorage.getItem('nav-collapsed') === 'true'); } catch { /* The sidebar starts expanded. */ }
toggleNav.addEventListener('click', () => {
  const collapsed = workspace.dataset.navCollapsed !== 'true';
  setNavigationCollapsed(collapsed);
  try { localStorage.setItem('nav-collapsed', String(collapsed)); } catch { /* Use the in-memory choice. */ }
});
function openGlobalSearch() {
  if (active?.kind === 'new') $('quick-connect-search').focus();
  else void openPalette().catch((error) => status(message(error)));
}

function wireTabSearch(formId, resultsId) {
  const form = $(formId);
  const search = form.querySelector('input');
  const results = $(resultsId);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    results.querySelector('.tab-choice')?.click();
  });
  form.parentElement.addEventListener('keydown', (event) => {
    if (event.isComposing || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const choices = [search, ...results.querySelectorAll('.tab-choice')];
    const index = choices.indexOf(event.target);
    if (index === -1 || choices.length < 2) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    choices[(index + step + choices.length) % choices.length].focus();
  });
}

wireTabSearch('quick-connect-form', 'quick-connect-results');
wireTabSearch('session-switcher-form', 'session-switcher-results');
$('quick-connect-search').addEventListener('input', (event) => {
  if (active?.kind !== 'new') return;
  active.query = event.target.value;
  renderQuickConnect(active);
});
$('quick-add-host').addEventListener('click', () => editHost(undefined, active).catch((error) => status(message(error))));
$('add-tab').addEventListener('click', addNewTab);
$('switch-tabs').addEventListener('click', chooseSession);
$('session-switcher-search').addEventListener('input', renderSessionSwitcher);
const sessionSwitcher = $('session-switcher');
$('close-switcher').addEventListener('click', () => sessionSwitcher.close());
sessionSwitcher.addEventListener('click', (event) => {
  if (event.target !== sessionSwitcher) return;
  const { left, right, top, bottom } = sessionSwitcher.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) sessionSwitcher.close();
});
sessionSwitcher.addEventListener('close', () => {
  $('switch-tabs').setAttribute('aria-expanded', 'false');
  if (active?.kind === 'new' && !vaultStatus.locked) $('quick-connect-search').focus({ preventScroll: true });
  else focusTerminal(active);
});
$('palette-button').addEventListener('click', openGlobalSearch);
$('queue-button').addEventListener('click', () => {
  selectTab(undefined, 'transfers');
  $('transfers-title').focus();
});
$('clear-downloads').addEventListener('click', () => removeDownloadHistory().catch((error) => status(message(error))));
for (const control of transferFilters) {
  control.addEventListener('click', () => {
    transferDirection = control.dataset.direction;
    for (const filter of transferFilters) filter.setAttribute('aria-pressed', String(filter === control));
    renderTransferSummary();
  });
}
$('terminal-path').addEventListener('click', () => chooseTerminalPath().catch((error) => status(message(error))));
$('terminal-bottom').addEventListener('click', () => { active?.terminal?.scrollToBottom(); focusTerminal(active); });
$('terminal-find').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = event.currentTarget.querySelector('input').value;
  if (query) active?.search?.findNext(query, searchOptions);
  else active?.search?.clearDecorations();
});
$('close-find').addEventListener('click', () => {
  $('terminal-find').hidden = true;
  active?.search?.clearDecorations();
  focusTerminal(active);
});
window.addEventListener('keydown', (event) => {
  if (!event.metaKey || event.isComposing || dialog.open || $('key-dialog').open || sessionSwitcher.open || vaultStatus.locked) return;
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); openGlobalSearch(); }
  if (event.key.toLowerCase() === 'j' && tabs.size > 1) { event.preventDefault(); chooseSession(); }
  if (event.key.toLowerCase() === 'f' && active?.terminal) { event.preventDefault(); $('terminal-find').hidden = false; $('terminal-find').querySelector('input').focus(); }
  if (active?.terminal && ['+', '=', '-', '0'].includes(event.key)) {
    event.preventDefault();
    active.terminal.options.fontSize = event.key === '0' ? terminalFontSize : Math.min(28, Math.max(9, active.terminal.options.fontSize + (event.key === '-' ? -1 : 1)));
    active.fit.fit();
  }
});
api.vault.state().then((state) => { applyVaultState(state); if (!state.locked) return refreshHosts(); }).catch((error) => status(message(error)));
selectTab();
