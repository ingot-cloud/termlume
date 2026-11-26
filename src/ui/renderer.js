'use strict';

const api = window.termlume;
const terminalPaths = window.terminalPaths;
const keyboard = window.keyboardShortcuts;
document.documentElement.dataset.platform = keyboard.isMac ? 'macos' : 'other';
// Pointer focus should not resemble a selected resource. Show a focus ring only
// when the user navigates with the keyboard, including newly opened dialogs.
document.documentElement.dataset.focusMode = 'pointer';
document.addEventListener('pointerdown', () => { document.documentElement.dataset.focusMode = 'pointer'; }, true);
document.addEventListener('keydown', event => {
  const editing = event.target.closest?.('input, textarea, [contenteditable]');
  if (event.key === 'Tab' || (!editing && ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))) {
    document.documentElement.dataset.focusMode = 'keyboard';
  }
}, true);
keyboard.hints(document);
const { selectControl, editableControl, close: closeDropdown } = window.dropdowns;
const $ = (id) => document.getElementById(id);
const workspace = $('workspace');
const dialog = $('dialog');
const fileEditor = $('file-editor');
const pageButtons = $('workspace-nav').querySelectorAll('[data-page]');
const tabs = new Map();
const jobs = new Map();
const jobRows = new Map();
const removedJobs = new Set();
const transferFilters = $('transfer-filters').querySelectorAll('button');
const transferHistoryLimit = 200;
const recent = new Map();
const actionLabels = { custom:'自定义命令', tail: '查看日志末尾', follow: '跟踪日志', journal: '查看服务日志', disk: '查看磁盘' };
const authLabels = { password: '密码', key: '私钥', agent: 'Agent' };
const jobLabels = { queued: '等待', paused: '已暂停', verifying: '校验断点', running: '传输中', committing: '提交中', done: '完成', canceled: '已取消', skipped: '已跳过', failed: '失败', unverified: '待确认' };
const searchOptions = { decorations: {
  matchBackground: '#544622', matchBorder: '#b49352', matchOverviewRuler: '#b49352',
  activeMatchBackground: '#795120', activeMatchBorder: '#ffd68d', activeMatchColorOverviewRuler: '#ffd68d'
} };
let hosts = [];
let groupAssets = [];
let hostsLoaded = false;
let currentGroup = '';
let selectedGroup = '';
let selectedHostId = '';
let hostMenu;
let hostSortBusy = false;
let orderDrag, orderDragFrame;
let suppressOrderClickUntil = 0;
let active;
let closingAllTabs = false;
let splitLayout;
const splitGroups = new Map();
let tabHoverTimer;
let tabHoverKey;
let splitGrip;
let splitRowGrip;
let resizeSplitLayout = () => {};
let tabDrag;
let tabDragFrame;
let suppressTabClickUntil = 0;
let cancelledTabPointer;
let quickConnectFilters;
let sessionFilters;
const defaultTerminalFont = 'SFMono-Regular, Menlo, monospace';
let uiPreferences={theme:"dark",terminalTheme:"dark",fontFamily:defaultTerminalFont,fontSize:14,recordCommands:false};
let viewPreferencesMigration;
let viewPreferencesSave = Promise.resolve();
const recordingSessions=new Set();
const {retryDelay,automaticCredential,filterCommands,pathBreadcrumbs}=window.workspaceState;
const layoutState = window.workspaceState;
const forwardRuns = new Map();
const forwardVersions = new Map();
let forwardVersion = 0;
let renderForwardPanel;
let forwardPanelOpen = false;
let filesOpen = false;
let serverInfoOpen = false;
let serverInfoRefresh;
let vaultStatus = {};
let touchIdAvailable = false;
let draggedFileCount = 0;
let transferDirection = '';
let transferPage = 'active';
let loadingHistory;
let historyReady = false;
let editingHistory = false;
let hostSearchAction;
let hostSearchMatch;
let libraryView = 'hosts';
let settingsRun;
let settingsSection = 'preferences';
let appUpdateState;
let appUpdateError = '';
const announcedUpdateVersions = new Set();
const sessionLabels = { idle: '等待连接', connecting: '连接中', trust: '等待核对指纹', ready: '已连接', closed: '已断开', running: '运行中', done: '已完成', stopped: '已停止', failed: '失败' };

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
function matchesQuery(query, ...parts) {
  const text = parts.flat().filter(Boolean).join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}
function hostChoiceOption(host, value = host.id, label = host.name, state) {
  const option = new Option(label, value);
  option.dataset.group = host.group || '';
  option.dataset.description = [endpoint(host), host.group || '未分组', state].filter(Boolean).join(' · ');
  option.dataset.search = [host.name, ...(host.tags || []), host.note || ''].join(' ');
  return option;
}
function hostSelectControl(select, label, candidates, settings = {}) {
  return selectControl(select, label, { searchable: true, showDescription: true,
    groups: [...new Set(candidates.map(host => host.group || ''))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    ...settings });
}
function identityChoiceOption(identity) {
  const option = new Option(`${identity.name} · ${identity.username}`, identity.id);
  option.dataset.source = identity.auth;
  option.dataset.description = [identityAuthLabels[identity.auth], `${identity.hosts?.length || 0} 台主机复用`].join(' · ');
  option.dataset.search = [...(identity.groups || []), ...(identity.hosts || []).map(host => host.name)].join(' ');
  return option;
}
function identitySelectControl(select, label) {
  return selectControl(select, label, { searchable: true, placeholder: '搜索配置名称、SSH 用户名或关联主机',
    sourceLabel: '认证方式', sources: [['', '全部'], ...Object.entries(identityAuthLabels)] });
}
function matchesHostFilters(host, filters) {
  return (!filters.group || (host?.group || '') === filters.group.slice(6)) &&
    (!filters.tag || host?.tags?.includes(filters.tag.slice(4)));
}
function selectionFilters(label, onChange, { types, statuses, tags = false } = {}) {
  const view = node('div', 'selection-filters');
  view.setAttribute('aria-label', `${label}筛选`);
  const controls = new Map();
  const add = (key, title, empty, choices = [], searchable = false) => {
    const select = node('select');
    select.append(new Option(empty, ''), ...choices.map(([value, text]) => new Option(text, value)));
    const picker = selectControl(select, `${label}${title}`, { searchable, placeholder: `搜索${title}` });
    view.append(field(title, picker));
    controls.set(key, select);
    select.addEventListener('change', () => { refreshReset(); onChange(); });
  };
  if (types) add('type', '类型', '全部类型', types);
  add('group', '主机分组', '全部分组', [], true);
  if (tags) add('tag', '标签', '全部标签', [], true);
  if (statuses) add('status', '状态', '全部状态', statuses);
  const reset = button('重置筛选', () => { set({}); onChange(); }, 'outlined');
  view.append(reset);
  const values = () => Object.fromEntries([...controls].map(([key, select]) => [key, select.value]));
  function refreshReset() { reset.disabled = !Object.values(values()).some(Boolean); }
  function set(next) {
    for (const [key, select] of controls) {
      select.value = [...select.options].some(option => option.value === next[key]) ? next[key] : '';
      select.dispatchEvent(new Event('input'));
    }
    refreshReset();
  }
  const replace = (key, empty, choices) => {
    const select = controls.get(key);
    if (!select) return;
    const options = [['', empty], ...choices];
    if (select.options.length === options.length && options.every(([value, text], index) =>
      select.options[index].value === value && select.options[index].textContent === text)) return;
    const selected = select.value;
    select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
    select.value = options.some(([value]) => value === selected) ? selected : '';
    select.dispatchEvent(new Event('input'));
  };
  return { view, get values() { return values(); }, set,
    refresh(candidates) {
      const groups = [...new Set(candidates.filter(Boolean).map(host => host.group || ''))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
      replace('group', '全部分组', groups.map(group => [`group:${group}`, group || '未分组']));
      replace('tag', '全部标签', [...new Set(candidates.flatMap(host => host?.tags || []))].sort().map(tag => [`tag:${tag}`, tag]));
      refreshReset();
    }
  };
}
function chromeIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chrome-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', {
    key: 'M15.5 13.5a5 5 0 1 0-5-5 5 5 0 0 0 .5 2.2L4 17.7V21h3.3l1.5-1.5V17h2.5l2.5-2.5m3.6-7.2h.01',
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
    user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21v-2a8 8 0 0 1 16 0v2',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    'eye-off': 'M3 3l18 18M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a22 22 0 0 1-3.3 4.3M6.2 6.2A23 23 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.8M10 10a3 3 0 0 0 4 4',
    save: 'M5 3h12l4 4v14H3V3h2m2 0v7h10V3M7 21v-7h10v7',
    file: 'M6 3h8l4 4v14H6zM14 3v5h4m-9 5h6m-6 4h6',
    import: 'M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6',
    export: 'M12 16V4m-4 4 4-4 4 4M4 15v6h16v-6',
    folder: 'M3 6h7l2 2h9v11H3z',
    group: 'M3 5h8v8H3zm10 6h8v8h-8zM15 5h6v3m-12 11H3v-3',
    tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
    sort: 'M7 4v16m-4-4 4 4 4-4M13 5h8m-8 6h6m-6 6h4',
    cards: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
    rows: 'M3 5h3m4 0h11M3 12h3m4 0h11M3 19h3m4 0h11',
    tree: 'M4 3v14h6M4 7h6M11 3h9v7h-9zm0 11h9v7h-9z',
    server: 'M3 4h18v7H3zm0 9h18v7H3zM7 7.5h.01M7 16.5h.01m4-9h6m-6 9h6',
    'new-tab': 'M4 4h16v16H4zM12 8v8m-4-4h8',
    terminal: 'M3 5h18v14H3zM7 9l3 3-3 3m6 0h4',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
    edit: 'M4 16l-1 5 5-1L21 7l-4-4zM14.5 5.5l4 4',
    undo: 'M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12',
    redo: 'm15 4 6 6-6 6m6-6H10a6 6 0 0 0 0 12',
    check: 'M4 12l5 5L21 5',
    close: 'M6 6l12 12M18 6L6 18',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0zm-1.5 4.5L21 21',
    format: 'M3 5h18M7 10h10M7 15h14M3 20h12',
    jump: 'M9 3L6 20M15 3l-3 17M3 8h13M2 15h12M16 13h6m-3-3 3 3-3 3',
    wrap: 'M3 6h14a4 4 0 0 1 0 8H8m4-4-4 4 4 4M3 20h4',
    sync: 'M20 10a8 8 0 0 0-14-4L4 8m0-4v4h4m-4 6a8 8 0 0 0 14 4l2-2m0 4v-4h-4'
  }[kind]);
  svg.append(path);
  return svg;
}
function sidebarAction(label,icon,action){const control=button('',action,'',label);control.append(chromeIcon(icon),node('span','sidebar-label',label));return control;}
function settingsIcon(kind) { return node('span', 'settings-icon', chromeIcon(kind)); }
function endpoint(host) {
  const address = host.address.includes(':') && !host.address.startsWith('[') ? `[${host.address}]` : host.address;
  return `${host.username}@${address}${host.port === 22 ? '' : `:${host.port}`}`;
}
function hostTarget(text) {
  const match = /^(?:ssh\s+)?(?:-p\s+(\d+)\s+)?([^@:\s]+)@(\[[\da-f:.%\w-]+\]|[^@\s:]+)(?::(\d+))?(?:\s+-p\s+(\d+))?$/i.exec(text.trim());
  if (!match || [match[1], match[4], match[5]].filter(Boolean).length > 1) return undefined;
  return { username: match[2], address: match[3], port: match[1] || match[4] || match[5] };
}
function matchesTarget(host, target) {
  return host.username === target.username && host.port === Number(target.port || 22) &&
    host.address.toLowerCase() === target.address.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}
function origin(tab = active) {
  return tab?.kind === 'command' ? tabs.get(tab.sessionId) : tab?.kind === 'shell' ? tab : undefined;
}
function address(path) { return path === '/' ? '' : path.replace(/\/$/, ''); }
function pathOf(tab, name) { return `${address(tab.files.directory)}/${name}`; }

function finishSettingsPrompt(page) { page.finish?.(); }

function settingsAsk(page) {
  return (title, fields, submit, onSubmit, extra = [], options = {}) =>
    prompt(title, fields, submit, onSubmit, extra, { ...options, settingsPage: page });
}

function leaveSettings() {
  if (!settingsRun) return;
  settingsRun.active = false;
  finishSettingsPrompt(settingsRun);
  settingsRun = undefined;
  $('settings-page').replaceChildren();
}

function beginSettings(section, session) {
  leaveSettings();
  settingsSection = section;
  const page = { active: true, section, session };
  settingsRun = page;
  selectTab(undefined, 'settings');
  for (const control of $('workspace-tools').children) {
    if (control.dataset.section === section) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  return page;
}

function openSettings(section = settingsSection, session = origin()) {
  if (vaultStatus.locked) return;
  const page = beginSettings(section, session);
  const render = { preferences: () => editPreferences(page), groups: () => manageGroups(page),
    identities: () => manageIdentities(page), snippets: () => manageSnippets(session, page),
    layouts: () => manageLayouts(page), logs: () => manageLogs(page), trust: () => manageTrust(page),
    security: async () => renderSecurityPage(), updates: () => showAppUpdates(page) }[section];
  $('settings-page').setAttribute('aria-label', '设置');
  $('settings-page').replaceChildren(settingsStatus('正在读取设置…'));
  void render?.().catch(error => {
    if (page.active) $('settings-page').replaceChildren(settingsStatus(message(error),
      button('重新加载', () => openSettings(section, session), 'outlined')));
  });
}

function promptSettings(page, title, fields, submit, onSubmit, extra, options) {
  if (!page.active) return Promise.resolve(undefined);
  finishSettingsPrompt(page);
  return new Promise(resolve => {
    let busy = false;
    const overview = submit === '关闭';
    for (const field of fields) if (field.matches?.('.forward-list') && !field.firstChild) field.append(node('p', 'muted', '暂无记录。'));
    const error = node('p', 'dialog-error'); error.setAttribute('role', 'alert');
    const notice = node('p', 'muted'); notice.setAttribute('role', 'status');
    const content = node('div', 'settings-fields', ...fields, error, notice);
    const form = node('form', 'settings-form', content);
    form.setAttribute('aria-label', title);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
      if (page.finish === finish) page.finish = undefined;
      resolve(result);
    };
    page.finish = finish;
    const actions = node('div', 'settings-actions', ...extra);
    if (!overview) {
      const save = node('button', 'primary', submit); save.type = 'submit';
      const back = button(options.backLabel || '返回', () => { if (!busy) finish(); }, 'outlined');
      if (options.back !== false) actions.append(back);
      actions.append(save);
      form.append(node('footer', 'settings-form-actions', actions));
    } else if (actions.childElementCount) {
      // Pair list actions with their search field, including detail/back views.
      const search = fields.find(field => field.matches?.('input[type="search"]'));
      if (search) actions.prepend(search);
      actions.classList.add('settings-list-toolbar');
      content.prepend(actions);
    }
    $('settings-page').setAttribute('aria-label', title);
    $('settings-page').replaceChildren(form);
    if (!overview) (options.focus || form.querySelector('input, textarea, .dropdown-trigger'))?.focus({ preventScroll: true });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (overview || busy || settled || !page.active) return;
      busy = true; error.textContent = ''; notice.textContent = '';
      form.setAttribute('aria-busy', 'true');
      const controls = [...form.querySelectorAll('button:not(:disabled)')];
      controls.forEach(control => { control.disabled = true; });
      try {
        const result = await onSubmit(event.submitter?.value);
        if (options.closeOnSubmit === false) notice.textContent = '已保存。';
        else finish(result);
      } catch (failure) { error.textContent = message(failure); }
      finally {
        busy = false; form.removeAttribute('aria-busy');
        controls.forEach(control => { control.disabled = false; });
      }
    });
  });
}

let drawerCloseAnimation;
function closePrompt(value = '') {
  if (!dialog.open || drawerCloseAnimation) return;
  if (!dialog.classList.contains('host-drawer') || !dialog.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.close(value);
    return;
  }
  const current = getComputedStyle(dialog);
  const animation = dialog.animate([{ transform: current.transform, opacity: current.opacity }, { transform: 'translateX(100%)', opacity: 0 }],
    { duration: 180, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  drawerCloseAnimation = animation;
  dialog.inert = true;
  dialog.dataset.closing = 'true';
  animation.finished.then(() => {
    if (drawerCloseAnimation === animation && dialog.open) dialog.close(value);
  }).catch(() => {});
}

function prompt(title, fields, submit, onSubmit, extra = [], options = {}) {
  cancelTabDrag();
  cancelOrderDrag();
  closeHostMenu();
  if (vaultStatus.locked) return Promise.reject(new Error('请先解锁 Termlume。'));
  if (options.settingsPage) return promptSettings(options.settingsPage, title, fields, submit, onSubmit, extra, options);
  if (dialog.open) return Promise.reject(new Error('请先完成当前弹窗。'));
  return new Promise((resolve) => {
    let result;
    let busy = false;
    let checkingClose = false;
    dialog.returnValue = '';
    const heading = node('h2', '', title);
    heading.id = 'dialog-title';
    if (options.focusHeading) {
      heading.tabIndex = -1;
      heading.setAttribute('autofocus', '');
    }
    const error = node('p', 'dialog-error');
    error.setAttribute('role', 'alert');
    const requestClose = async () => {
      if (busy || drawerCloseAnimation || checkingClose) return;
      checkingClose = true;
      try {
        const check = options.canClose ? options.canClose() : true;
        const allowed = typeof check?.then === 'function' ? await check : check;
        if (allowed && dialog.open && !busy && !drawerCloseAnimation) closePrompt();
      } catch (failure) { error.textContent = message(failure); }
      finally { checkingClose = false; }
    };
    const cancel = button(options.cancelLabel || '取消', requestClose);
    const confirm = node('button', 'primary', submit);
    confirm.type = 'submit';
    confirm.value = options.submitValue || '';
    const controls = node('div', 'actions', ...extra, ...(options.cancelLast ? [confirm, cancel] : [cancel, confirm]));
    const form = options.drawer
      ? node('form', '', node('div', 'drawer-fields', ...fields, error), controls)
      : node('form', '', node('div','dialog-fields',...fields,error), controls);
    const header = options.drawer ? node('header', 'drawer-header', heading,
      button('×', requestClose, '', options.closeLabel || '关闭主机表单')) : heading;
    dialog.replaceChildren(header, form);
    dialog.classList.toggle('host-drawer', Boolean(options.drawer));
    dialog.classList.toggle('split-dialog', Boolean(options.split));
    const collection = 'input[type="search"], .palette-list, .key-list, .forward-list, .target-list';
    dialog.classList.toggle('collection-dialog', !options.drawer && fields.some(field =>
      field.matches?.(collection) || field.querySelector?.(collection)));
    const cancelEvent = (event) => {
      event.preventDefault();
      void requestClose();
    };
    dialog.addEventListener('cancel', cancelEvent);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('cancel', cancelEvent);
      const animation = drawerCloseAnimation;
      drawerCloseAnimation = undefined;
      animation?.cancel();
      dialog.inert = false;
      delete dialog.dataset.closing;
      dialog.replaceChildren();
      resolve(result);
    }, { once: true });
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
        if (options.closeOnSubmit === false) {
          form.removeAttribute('aria-busy');
          enabled.forEach((control) => { control.disabled = false; });
          busy = false;
        } else closePrompt();
      } catch (failure) {
        error.textContent = message(failure);
        error.scrollIntoView({ block: 'nearest' });
        form.removeAttribute('aria-busy');
        enabled.forEach((control) => { control.disabled = false; });
        busy = false;
      }
    });
    window.overlays.show(dialog);
    const focus = options.focusHeading ? heading : options.focus || form.querySelector('input:not([hidden]), .dropdown-trigger');
    focus?.focus({ preventScroll: true });
  });
}

async function confirm(title, text, submit) {
  return prompt(title, [node('p', '', text)], submit, () => true);
}

function confirmDiscardHostChanges(subject = '主机') {
  closeDropdown();
  const pane = node('dialog');
  pane.id = 'host-discard-dialog';
  pane.setAttribute('role', 'alertdialog');
  pane.setAttribute('aria-labelledby', 'host-discard-title');
  pane.setAttribute('aria-describedby', 'host-discard-description');
  const title = node('h2', '', '放弃尚未保存的修改？'); title.id = 'host-discard-title';
  const description = node('p', '', `关闭后，本次${subject}修改将不会保存。`); description.id = 'host-discard-description';
  return new Promise(resolve => {
    let discard = false;
    const keep = button('继续编辑', () => pane.close(), 'primary');
    const drop = button('放弃修改', () => { discard = true; pane.close(); }, 'outlined danger');
    const closeWithParent = () => { if (pane.open) pane.close(); };
    dialog.addEventListener('close', closeWithParent, { once: true });
    pane.addEventListener('close', () => {
      dialog.removeEventListener('close', closeWithParent);
      pane.remove();
      resolve(discard);
    }, { once: true });
    pane.append(title, description, node('div', 'actions', keep, drop));
    document.body.append(pane);
    window.overlays.show(pane);
    keep.focus({ preventScroll: true });
  });
}

async function refreshHosts() {
  if(api.groups) groupAssets=await api.groups.list();
  const [result, timestamps, preferences] = await Promise.all([api.hosts.list(), api.hosts.recent(), api.preferences?.get()]);
  if (vaultStatus.locked) return;
  hosts = result;
  if (preferences) {
    const next = await migrateViewPreferences(preferences);
    if (vaultStatus.locked) return;
    const fonts = next.fontFamily !== uiPreferences.fontFamily || next.fontSize !== uiPreferences.fontSize;
    uiPreferences = next;
    applyPreferences(fonts);
  }
  hostsLoaded = true;
  for (const [id, time] of Object.entries(timestamps)) recent.set(id, time);
  renderHosts();
  if (active?.kind === 'new') renderQuickConnect(active);
}

function updateTouchIdUnlock() {
  $('unlock-touch-id').hidden = !vaultStatus.touchIdEnabled || !touchIdAvailable;
}

async function refreshTouchIdAvailability() {
  if (!vaultStatus.enabled || !api.vault.touchIdAvailable) return;
  const available = await api.vault.touchIdAvailable().catch(() => false);
  if (available === touchIdAvailable) return;
  touchIdAvailable = available;
  updateTouchIdUnlock();
  if (settingsRun?.section === 'security') updateTouchIdSetting();
}

function applyVaultState(state) {
  const wasLocked = vaultStatus.locked;
  const refreshTouchId = state.enabled !== vaultStatus.enabled || state.locked !== vaultStatus.locked;
  if (!state.locked && state.remote && state.remote === vaultStatus.remote &&
      state.branch === vaultStatus.branch && state.syncAttention === undefined) {
    state = { ...state, syncAttention: vaultStatus.syncAttention };
  }
  vaultStatus = state;
  if (!state.enabled) touchIdAvailable = false;
  if(!state.locked&&api.preferences) void api.preferences.get().then(migrateViewPreferences).then(p=>{if(!vaultStatus.locked&&JSON.stringify(p)!==JSON.stringify(uiPreferences)){const fonts=p.fontFamily!==uiPreferences.fontFamily||p.fontSize!==uiPreferences.fontSize;uiPreferences=p;applyPreferences(fonts);renderHosts();}}).catch(()=>{});
  updateTouchIdUnlock();
  const transfersSupported = state.fileTransfers !== false;
  document.querySelector('[data-page="transfers"]').hidden = $('queue-button').hidden = !transfersSupported;
  document.body.classList.toggle('vault-locked', state.locked);
  $('vault-lock').hidden = !state.locked;
  $('library-button').disabled = Boolean(state.locked);
  if (state.locked) {
    serverInfoOpen = false;
    stopServerInfoRefresh();
    $('server-info').replaceChildren();
    $('server-info').hidden = $('server-info').inert = true;
    workspace.dataset.serverInfo = 'closed';
    for (const tab of tabs.values()) {
      tab.cancelCredential?.();
      tab.pendingTransfer = undefined;
      tab.serverInfo = tab.networkHistory = tab.resourceHistory = tab.diskHistory = undefined;
      tab.serverHistoryPaused = true;
    }
    cancelTabDrag();
    cancelOrderDrag();
    for(const tab of tabs.values()){clearTimeout(tab.reconnectTimer);clearTimeout(tab.stableTimer);tab.reconnectCancelled=true;}
    forwardRuns.clear(); forwardVersions.clear();recordingSessions.clear();
    historyReady = false;
    $('terminal-drop').hidden = true;
    closeDropdown();
    closeHostMenu();
    for (const pane of [$('key-dialog'), $('session-switcher'), dialog, fileEditor]) if (pane.open) pane.close();
    $('keys-page').replaceChildren();
    leaveSettings();
    hosts = [];
    hostsLoaded = false;
    renderHosts();
    $('quick-connect-results').replaceChildren();
    $('unlock-error').textContent = state.startupUnlockError || '';
    if (!wasLocked) {
      $('unlock-mode').value = 'password';
      $('unlock-mode').dispatchEvent(new Event('input'));
      $('unlock-secret').value = '';
    }
    $('unlock-secret').focus();
  } else {
    if (wasLocked) for (const tab of tabs.values()) if (tab.status === 'ready') syncTerminalSize(tab);
    if (transfersSupported && !historyReady) void loadTransferHistory();
  }
  if (settingsRun?.section === 'security') renderSecurityPage();
  if (refreshTouchId) void refreshTouchIdAvailability();
  if (!state.locked) showAppUpdateNotice();
}

async function enableVault() {
  const password = input('', 'password');
  const repeated = input('', 'password');
  password.required = repeated.required = true;
  password.minLength = 8;
  password.maxLength = repeated.maxLength = 1024;
  password.autocomplete = repeated.autocomplete = 'new-password';
  let chosenPassword;
  try {
    while ((chosenPassword = await prompt('设置主密码', [
      node('p', 'step-label', '第 1 步，共 2 步'),
      node('p', 'muted', '主密码保护本机工作区、加密备份和 Git 同步快照。启用应用锁后，也可用它解锁 Termlume。请设置至少 8 个字符的独立密码。'),
      field('主密码', password), field('确认主密码', repeated)
    ], '继续', () => {
      if (password.value.length < 8) throw new Error('主密码至少需要 8 个字符。');
      if (password.value !== repeated.value) throw new Error('两次输入的主密码不同。');
      return password.value;
    }))) {
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
      ], '开启主密码保护', () => api.vault.enable({ password: chosenPassword, recovery }), [
        button('上一步', () => { back = true; dialog.close(); }, 'step-back')
      ], { focus: saved });
      if (state) { applyVaultState(state); status('主密码保护已开启。'); }
      if (!back) return;
    }
  } finally { chosenPassword = undefined; password.value = repeated.value = ''; }
}

function unlockMethod() {
  const select = node('select');
  for (const [value, text] of [['password', '主密码'], ['recovery', '恢复密钥']]) {
    const option = node('option', '', text); option.value = value; select.append(option);
  }
  return select;
}

async function changeMasterPassword() {
  const mode = unlockMethod();
  const secret = input('', 'password');
  secret.required = true; secret.autocomplete = 'current-password';
  const password = input('', 'password');
  const repeated = input('', 'password');
  password.required = repeated.required = true;
  password.minLength = 8; password.maxLength = repeated.maxLength = 1024;
  password.autocomplete = repeated.autocomplete = 'new-password';
  const credential = field('当前主密码', secret);
  mode.addEventListener('change', () => {
    credential.firstChild.textContent = mode.value === 'recovery' ? '恢复密钥' : '当前主密码';
    secret.value = ''; secret.focus();
  });
  try {
    const state = await prompt('修改主密码', [
      node('p', 'muted', '先验证当前主密码或恢复密钥，再设置至少 8 个字符的新主密码。'),
      field('验证方式', selectControl(mode, '验证方式')), credential,
      field('新主密码', password), field('确认新主密码', repeated),
      node('p', 'muted', '恢复密钥保持有效。新密码用于本机和之后导出的备份及同步快照；旧备份、旧快照及其他设备仍使用各自原来的主密码。')
    ], '保存主密码', () => {
      if (password.value.length < 8) throw new Error('主密码至少需要 8 个字符。');
      if (password.value !== repeated.value) throw new Error('两次输入的主密码不同。');
      return api.vault.changePassword({secret: secret.value, useRecovery: mode.value === 'recovery', password: password.value});
    });
    if (state) { applyVaultState(state); status('主密码已修改，恢复密钥仍有效。'); }
  } finally { secret.value = password.value = repeated.value = ''; }
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
    node('small', '', 'Token 用来读写仓库。应用会将它加密保存在本机。'));
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
    if (state) { applyVaultState(state); await refreshHosts(); status('加密数据已恢复。'); }
  } finally {
    secret.value = legacy.secret.value = '';
    if (connection) connection.token.value = '';
  }
}

function conflictDescription(host) {
  if (host.deleted) return '已删除';
  if(host.recordType) {
    const {id,name,recordType,passwordSaved,...details}=host;
    return `${name} · ${recordType}${passwordSaved?' · 含已保存密码':''}\n${JSON.stringify(details,null,2)}`;
  }
  return `${host.name} · ${endpoint(host)} · ${host.auth}${host.group ? ` · ${host.group}` : ''}${host.passwordSaved ? ' · 含已保存密码' : ''}${host.sortOrder != null ? ` · 手动位置 ${host.sortOrder + 1}` : ''}`;
}

async function syncVault(mode) {
  const { remote, branch: currentBranch } = vaultStatus;
  const changeBranch = mode === 'branch';
  const changeConnection = mode === 'connection';
  const connection = !remote || changeConnection ? gitConnection(remote, { allowSaved: Boolean(remote) }) : null;
  const legacy = legacyGitKey();
  let request = mode === 'pull' ? { pullOnly: true } : {};
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
      status(mode === 'pull' ? '正在拉取 Git 更新…' : '正在同步加密资料…');
      try { result = await legacy.submit(api.vault.sync, request); }
      catch (error) {
        if (legacy.fieldView.hidden) throw error;
        result = await prompt('兼容旧 Git 快照', [
          node('p', 'muted', '这份快照使用了旧版独立密钥。输入后可继续。下一次双向同步时，应用会改用主密码保护后续快照。'),
          legacy.fieldView
        ], '解开并同步', () => legacy.submit(api.vault.sync, request));
      }
    }
    await finishGitOperation(result, request, (value) => legacy.submit(api.vault.sync, value),
      mode === 'pull' ? '应用选择并拉取' : '应用选择并同步',
      mode === 'pull' ? '已拉取更新，未推送本机修改。' : 'Git 同步已完成。');
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
    node('p', 'muted', '请使用新的空私有仓库。应用会在新仓库写入一份由主密码保护的快照。其他设备请先同步，再暂停写入旧仓库。'),
    ...connection.fields, field('新同步分支', branch), legacy.fieldView
  ];
  let request = {};
  try {
    const result = await prompt(pending ? '继续迁移 Git 仓库' : '迁移到新仓库', fields, pending ? '继续迁移' : '开始迁移', () => {
      request = { ...connection.request(), branch: branch.value };
      return legacy.submit(api.vault.migrateGit, request);
    });
    await finishGitOperation(result, request, (value) => legacy.submit(api.vault.migrateGit, value), '应用选择并迁移', '已迁移到新仓库。');
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
    if (!result && !vaultStatus.locked) {
      const notice = '有同步冲突。再次拉取或同步时可选择要保留的版本。';
      vaultStatus = { ...vaultStatus, syncAttention: notice };
      updateGitSummary();
      status(notice);
    }
  }
  if (result?.state) {
    applyVaultState(result.state);
    await refreshHosts();
    status(result.pending ? `${success}还有较新的本机修改待同步。` : success);
  }
}

function settingsStatus(text, ...actions) {
  const notice = node('p', 'muted', text);
  notice.setAttribute('role', 'status');
  return node('div', 'page-body settings-status', notice, ...actions);
}

async function showAppUpdates(page) {
  acceptAppUpdateState(await api.updates.status());
  if (page.active) renderAppUpdates();
}

function acceptAppUpdateState(next) {
  if (appUpdateState && (next.revision ?? 0) < (appUpdateState.revision ?? 0)) return;
  appUpdateState = next;
  if (next.phase === 'available' && next.canDownload && next.version) {
    status(`发现 Termlume v${next.version}，可在设置中下载更新。`);
    showAppUpdateNotice();
  }
}

function showAppUpdateNotice() {
  const update = appUpdateState;
  if (update?.phase !== 'available' || !update.canDownload || !update.version || announcedUpdateVersions.has(update.version)) return;
  if (vaultStatus.locked !== false || document.hidden || document.querySelector('dialog[open]')) return;

  announcedUpdateVersions.add(update.version);
  if (settingsRun?.section === 'updates') return;
  void confirm('发现新版本', `Termlume v${update.version} 已发布。前往「关于与更新」查看版本说明并下载。`, '去更新')
    .then(accepted => { if (accepted) openSettings('updates'); })
    .catch(error => status(message(error)));
}

function renderAppUpdates() {
  if (settingsRun?.section !== 'updates' || !appUpdateState || vaultStatus.locked) return;
  const page = $('settings-page');
  const state = appUpdateState;
  const busy = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const renderKey = JSON.stringify([state.currentVersion,state.phase,state.version,state.notes,state.message,state.checkedAt,state.canDownload,appUpdateError]);
  const updateProgress = () => {
    const progress = page.querySelector('.update-progress');
    const detail = page.querySelector('.update-progress-detail');
    if (!progress || !detail) return;
    if (state.total) { progress.max = state.total; progress.value = state.downloaded; }
    const mb = value => `${(value / 1024 / 1024).toFixed(1)} MB`;
    detail.textContent = state.total ? `${mb(state.downloaded)} / ${mb(state.total)} · ${Math.min(100, Math.floor(state.downloaded / state.total * 100))}%` : `已下载 ${mb(state.downloaded)}`;
  };
  if (page.querySelector('.update-card') && page.dataset.updateKey === renderKey) { updateProgress(); return; }
  page.dataset.updateKey = renderKey;
  page.setAttribute('aria-label', '关于与更新');
  const title = node('div', 'security-heading', settingsIcon('settings'), node('h2', '', 'Termlume'));
  const current = node('p', 'muted', `当前版本 v${state.currentVersion}`);
  const info = node('p', 'update-status', state.message);
  info.setAttribute('role', state.phase === 'error' ? 'alert' : 'status');
  const card = node('section', 'security-card update-card', title, current, info);
  if (state.version && ['available','pending','downloading','verifying','ready','installing'].includes(state.phase)) {
    card.append(node('p', '', `新版本 v${state.version}`));
  }
  if (state.notes) {
    const notes = node('pre', 'update-notes', state.notes);
    notes.setAttribute('aria-label', '新版本说明');
    card.append(notes);
  }
  if (['downloading','verifying'].includes(state.phase)) {
    const progress = node('progress', 'update-progress');
    progress.setAttribute('aria-label', '更新下载进度');
    card.append(progress, node('p', 'muted update-progress-detail'));
  }
  const automatic = input('', 'checkbox');
  automatic.checked = localStorage.getItem('updates-on-start') !== 'false';
  automatic.addEventListener('change', () => localStorage.setItem('updates-on-start', String(automatic.checked)));
  card.append(node('label', 'checkbox-row', automatic, '启动时检查新版本'));
  if (state.checkedAt) card.append(node('p', 'muted', `最近检查：${new Date(state.checkedAt).toLocaleString()}`));
  const errorView = node('p', 'dialog-error', appUpdateError);
  errorView.setAttribute('role', 'alert');
  card.append(errorView);
  const controls = node('div', 'settings-actions');
  const act = action => async () => {
    appUpdateError = '';
    try {
      if (action === 'install' && fileEditor.open) throw new Error('请先保存并关闭文件编辑器，再安装更新。');
      acceptAppUpdateState(await api.updates[action]());
    } catch (failure) { appUpdateError = message(failure); }
    renderAppUpdates();
  };
  const check = button(state.phase === 'checking' ? '正在检查…' : '检查更新', act('check'), 'outlined');
  check.disabled = busy || state.phase === 'ready';
  controls.append(check);
  if (state.phase === 'downloading') controls.append(button('取消下载', act('cancel'), 'outlined'));
  if (state.canDownload && !busy && state.phase !== 'ready') controls.append(button('下载更新', act('download'), 'primary'));
  if (state.phase === 'ready') controls.append(button('重启并安装', act('install'), 'primary'));
  if (state.phase === 'installing') controls.append(node('span', 'muted', '正在安装…'));
  const form = node('div', 'settings-form', node('div', 'settings-fields', card), node('div', 'settings-form-actions', controls));
  const previous = page.querySelector('.settings-fields');
  const scroll = previous?.scrollTop || 0;
  const focused = previous?.contains(document.activeElement) && document.activeElement.type === 'checkbox';
  page.replaceChildren(form);
  form.querySelector('.settings-fields').scrollTop = scroll;
  updateProgress();
  if (focused) automatic.focus({ preventScroll: true });
}

const defaultGitSettings = { paused: false, onUnlock: false, afterChanges: false, intervalMinutes: 0 };

function securitySwitch(id, label, description, checked, onChange) {
  const toggle = input('', 'checkbox');
  toggle.id = id;
  toggle.checked = checked;
  toggle.setAttribute('role', 'switch');
  const error = node('p', 'dialog-error');
  error.setAttribute('role', 'alert');
  const descriptionView = node('p', 'muted', description);
  descriptionView.id = `${id}-hint`;
  toggle.setAttribute('aria-describedby', descriptionView.id);
  const row = node('div', 'security-setting',
    node('label', 'security-switch-row', node('span', '', label),
      node('span', 'security-switch', toggle, node('span', 'security-switch-track'))),
    descriptionView, error);
  toggle.addEventListener('change', async () => {
    const hadFocus = document.activeElement === toggle;
    toggle.disabled = true;
    error.textContent = '';
    try {
      await onChange(toggle.checked);
    } catch (failure) { error.textContent = message(failure); }
    finally {
      if (toggle.isConnected) toggle.checked = checked;
      toggle.disabled = false;
      if (hadFocus && document.activeElement === document.body) $(id)?.focus({ preventScroll: true });
    }
  });
  return row;
}

async function disableVault() {
  const secret = input('', 'password');
  secret.required = true;
  secret.autocomplete = 'current-password';
  const mode = unlockMethod();
  try {
    const state = await prompt('关闭主密码保护', [
      node('p', '', '主密码保护、应用锁和 Git 同步将关闭，工作区仍由应用在本机加密保存。仅在保险库中的 SSH 密码会移除，已在本机保存的密码会保留。'),
      node('p', 'muted', '已导出的备份和 Git 历史仍保留，仍需原主密码或恢复密钥才能打开。'),
      field('验证方式', selectControl(mode, '验证方式')), field('主密码或恢复密钥', secret)
    ], '确认关闭', () => api.vault.disable({ secret: secret.value, useRecovery: mode.value === 'recovery' }));
    if (state) { applyVaultState(state); await refreshHosts(); status('已关闭主密码保护。'); }
  } finally { secret.value = ''; }
}

function updateTouchIdSetting() {
  const container = $('security-touch-id');
  if (!container) return;
  const { touchIdEnabled } = vaultStatus;
  container.replaceChildren();
  container.hidden = !touchIdAvailable && !touchIdEnabled;
  if (container.hidden) return;
  container.append(securitySwitch('vault-touch-id', '使用触控 ID 解锁',
    touchIdAvailable ? '使用本机已录入的指纹解锁 Termlume。主密码和恢复密钥仍可使用。'
      : '本机当前无法使用已配置的触控 ID。可关闭此选项，或在系统设置中检查指纹录入。',
    Boolean(touchIdEnabled), async checked => {
      applyVaultState(await api.vault.setTouchId(checked));
      status(checked ? '已开启触控 ID 解锁。' : '已关闭触控 ID 解锁。');
    }));
}

function idleLockSettings() {
  const minutesSaved = vaultStatus.autoLockMinutes === undefined ? 15 : vaultStatus.autoLockMinutes;
  const autoLock = input('', 'checkbox');
  autoLock.id = 'vault-auto-lock';
  autoLock.checked = minutesSaved !== null;
  const minutes = input(String(minutesSaved ?? 15), 'number');
  minutes.id = 'vault-auto-lock-minutes';
  minutes.min = '1';
  minutes.max = '1440';
  minutes.required = true;
  const save = node('button', 'outlined', '保存闲置设置');
  save.id = 'vault-save-idle';
  save.type = 'submit';
  const error = node('p', 'dialog-error');
  error.setAttribute('role', 'alert');
  const controls = node('div', 'settings-actions', field('闲置时间（分钟）', minutes), save);
  const form = node('form', 'security-setting vault-idle-form',
    node('label', 'checkbox-row', autoLock, '闲置时自动锁定'), controls, error);
  const read = () => autoLock.checked ? Number(minutes.value) : null;
  const edit = () => {
    minutes.disabled = !autoLock.checked;
    minutes.parentElement.hidden = !autoLock.checked;
    save.disabled = read() === minutesSaved;
    save.hidden = !autoLock.checked && save.disabled;
    error.textContent = '';
  };
  autoLock.addEventListener('change', edit);
  minutes.addEventListener('input', edit);
  edit();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = read();
    autoLock.disabled = minutes.disabled = save.disabled = true;
    try {
      applyVaultState(await api.vault.setAutoLockMinutes(value));
      status(value === null ? '已关闭闲置自动锁定。' : `闲置 ${value} 分钟后将自动锁定。`);
    } catch (failure) { error.textContent = message(failure); }
    finally {
      autoLock.disabled = false;
      minutes.disabled = !autoLock.checked;
      save.disabled = read() === minutesSaved;
    }
  });
  return form;
}

function updateGitSummary() {
  const summary = $('security-git-summary');
  if (!summary) return;
  const { lastSynced, lastFetched, gitMigration, syncAttention } = vaultStatus;
  summary.textContent = gitMigration ? '仓库迁移尚未完成。' : [
    lastSynced ? `最近同步：${new Date(lastSynced).toLocaleString()}` : '尚未完成首次同步。',
    lastFetched ? `最近拉取：${new Date(lastFetched).toLocaleString()}` : ''
  ].filter(Boolean).join(' · ');
  const notice = $('security-git-attention');
  if (notice) notice.textContent = syncAttention || '';
}

function gitPolicySettings(policy) {
  const onUnlock = input('', 'checkbox');
  onUnlock.checked = policy.onUnlock;
  const afterChanges = input('', 'checkbox');
  afterChanges.checked = policy.afterChanges;
  const interval = node('select');
  for (const [value, label] of [[0, '关闭'], [5, '每 5 分钟'], [15, '每 15 分钟'], [30, '每 30 分钟'], [60, '每 60 分钟']]) {
    const option = node('option', '', label);
    option.value = value;
    interval.append(option);
  }
  interval.value = policy.intervalMinutes;
  const save = node('button', 'outlined vault-sync', '保存同步策略');
  save.type = 'submit';
  save.id = 'vault-save-policy';
  save.disabled = true;
  const error = node('p', 'dialog-error');
  error.setAttribute('role', 'alert');
  const form = node('form', 'security-setting vault-policy',
    node('h3', '', '自动同步'),
    node('p', 'muted', '自动同步会拉取仓库更新、合并并推送本机修改。仅在应用运行且未锁定时执行；遇到冲突或失败时暂停，处理后再继续。'),
    node('label', 'checkbox-row', onUnlock, '启动或解锁后同步'),
    node('label', 'checkbox-row', afterChanges, '本机资料变更后同步（约 10 秒）'),
    node('div', 'settings-actions', field('定时同步', selectControl(interval, '定时同步')), save), error);
  const read = () => ({ ...policy, onUnlock: onUnlock.checked, afterChanges: afterChanges.checked, intervalMinutes: Number(interval.value) });
  form.addEventListener('change', () => {
    const draft = read();
    save.disabled = draft.onUnlock === policy.onUnlock && draft.afterChanges === policy.afterChanges &&
      draft.intervalMinutes === policy.intervalMinutes;
    error.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    try { applyVaultState(await api.vault.setGitSettings(read())); status('已保存本机的自动同步策略。'); }
    catch (failure) { save.disabled = false; error.textContent = message(failure); }
  });
  return form;
}

function renderSecurityPage() {
  if (settingsRun?.section !== 'security' || vaultStatus.locked) return;
  const page = $('settings-page');
  const { enabled, remote, branch, fileTransfers, gitMigration, lastSynced, startupUnlockRequired } = vaultStatus;
  page.setAttribute('aria-label', '安全与同步');
  if (typeof enabled !== 'boolean') { page.replaceChildren(settingsStatus('正在读取设置…')); return; }
  const previous = page.querySelector('.security-body');
  const scrollTop = previous?.scrollTop || 0;
  const focusId = previous?.contains(document.activeElement) ? document.activeElement.id : '';
  const protection = node('section', 'security-card',
    node('div', 'security-heading', settingsIcon('lock'), node('h2', '', '数据保护')));
  const protectionHint = '可选。主密码保护本机工作区、加密备份和 Git 同步快照，也可用于解锁 Termlume。';
  if (enabled && !api.vault.disable) {
    protection.append(node('h3', '', '主密码保护已开启'), node('p', 'muted', protectionHint));
  } else {
    protection.append(securitySwitch('vault-protection', '主密码保护', protectionHint, enabled,
      checked => checked ? enableVault() : disableVault()));
  }
  const body = node('div', 'page-body security-body', protection);
  if (enabled && api.vault.changePassword) {
    protection.append(node('div', 'security-setting security-action-row',
      node('p', 'muted', '修改主密码，或使用恢复密钥重新设置。'),
      button('修改主密码', changeMasterPassword, 'outlined')));
  }
  if (!enabled) {
    const restore = node('section', 'security-card', node('h2', '', '恢复已有数据'),
      node('p', 'muted', '在空工作区使用原主密码或恢复密钥，从加密备份或 Git 仓库恢复。'),
      node('div', 'settings-actions',
        ...(fileTransfers === false ? [] : [button('从加密备份恢复', () => restoreVault(false), 'outlined')]),
        button('从 Git 恢复', () => restoreVault(true), 'outlined')));
    body.append(restore);
  } else {
    const appLock = node('section', 'security-card', node('h2', '', '应用锁'));
    const lockEnabled = startupUnlockRequired !== false;
    if (vaultStatus.startupUnlockSupported && api.vault.setStartupUnlockRequired) {
      appLock.append(securitySwitch('vault-startup-unlock', '使用应用锁',
        '开启后，启动时需要解锁 Termlume。关闭后，应用使用仅保存在本机的加密凭据自动解锁，工作区、备份和同步快照仍加密保存。',
        lockEnabled, async required => {
          applyVaultState(await api.vault.setStartupUnlockRequired(required));
          status(required ? '已开启应用锁。' : '已关闭应用锁，本机启动时将自动解锁。');
        }));
    } else {
      appLock.append(node('p', 'muted', '本机需要验证主密码或恢复密钥才能打开已加密的工作区。'));
    }
    if (lockEnabled) {
      if (api.vault.setAutoLockMinutes) appLock.append(idleLockSettings());
      if (api.vault.setTouchId) {
        const biometric = node('div', 'security-divider');
        biometric.id = 'security-touch-id';
        appLock.append(biometric);
      }
      appLock.append(node('div', 'security-action-row', node('p', 'muted', '暂时离开时，锁定当前工作区。'), button('立即锁定', async () => applyVaultState(await api.vault.lock()), 'outlined')));
    }

    const policy = { ...defaultGitSettings, ...vaultStatus.gitSettings };
    const git = node('section', 'security-card', node('h2', '', 'Git 同步'));
    git.append(node('p', 'muted', '同步主机与连接设置、分组、登录配置、快捷命令、保存的会话布局，以及主题、字体字号、主机视图和排序偏好。传输记录、会话日志和命令历史不参与同步；私钥、私钥口令、仓库授权和应用锁等设备配置保留在本机。共享偏好需要同一保险库的设备使用支持此格式的新版本。'));
    const runGitAction = action => async () => {
      const controls = [...git.querySelectorAll('.vault-sync:not(:disabled)')];
      controls.forEach(control => { control.disabled = true; });
      try { await action(); } finally { controls.forEach(control => { control.disabled = false; }); }
    };
    if (api.vault.setGitSettings && !gitMigration) {
      git.append(securitySwitch('vault-git-enabled', '通过 Git 同步',
        policy.paused ? '已暂停。仓库连接和同步策略会保留，重新开启后可继续。' : '将加密快照同步到你自己的专用私有 Git 仓库。',
        Boolean(remote) && !policy.paused, async checked => {
          if (!remote) { await runGitAction(syncVault)(); return; }
          applyVaultState(await api.vault.setGitSettings({ ...policy, paused: !checked }));
          status(checked ? '已恢复 Git 同步。' : '已暂停 Git 同步。');
        }));
    } else if (!remote) {
      git.append(node('p', 'muted', '使用专用私有 Git 仓库同步加密资料。'),
        button('绑定 Git 仓库', runGitAction(syncVault), 'outlined vault-sync'));
    }
    if (remote) {
      const summary = node('p', 'muted'); summary.id = 'security-git-summary';
      const attention = node('p', 'security-attention'); attention.id = 'security-git-attention'; attention.setAttribute('role', 'status');
      const details = node('div', 'vault-remote', summaryText('code', remote),
        summaryText('code', `分支 · ${branch || defaultSyncBranch}`));
      git.append(details, summary);
      if (!policy.paused) {
        git.append(attention);
        if (gitMigration) {
          git.append(node('div', 'settings-actions',
            button('继续迁移', runGitAction(migrateVault), 'primary vault-sync'),
            button('放弃迁移', runGitAction(abandonGitMigration), 'outlined vault-sync')));
        } else {
          git.append(node('div', 'settings-actions',
            button('立即同步', runGitAction(syncVault), 'primary vault-sync'),
            ...(lastSynced && api.vault.setGitSettings ? [button('拉取更新', runGitAction(() => syncVault('pull')), 'outlined vault-sync')] : [])));
          if (lastSynced && api.vault.setGitSettings) {
            git.append(node('p', 'muted', '立即同步会拉取并推送；拉取更新只合并仓库内容，保留尚未推送的本机修改。'),
              gitPolicySettings(policy));
          }
          const repository = node('details', 'security-setting', node('summary', '', '仓库连接与分支'),
            node('div', 'settings-actions', button('更改仓库连接', runGitAction(() => syncVault('connection')), 'outlined vault-sync'),
              ...(lastSynced ? [
                button('更改同步分支', runGitAction(() => syncVault('branch')), 'outlined vault-sync'),
                button('迁移到新仓库', runGitAction(migrateVault), 'outlined vault-sync')
              ] : [])));
          repository.open = Boolean(previous?.querySelector('details')?.open);
          git.append(repository);
        }
      }
    }
    body.append(appLock, git);
    if (fileTransfers !== false) {
      body.append(node('section', 'security-card', node('h2', '', '加密备份'),
        node('div', 'security-action-row', node('p', 'muted', '导出本地备份文件。恢复时需要原主密码或恢复密钥。'), button('导出加密备份', async () => {
          if (await api.vault.export()) status('加密备份已导出。');
        }, 'outlined'))));
    }
  }
  page.replaceChildren(body);
  updateTouchIdSetting();
  updateGitSummary();
  body.scrollTop = scrollTop;
  if (focusId) $(focusId)?.focus({ preventScroll: true });
}

let keyDirectory;
const keyDirectories = new Set();
function keyName(path) { return path?.split(/[\\/]/).filter(Boolean).at(-1) || ''; }
function keyBrowser() {
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
  const generate = button('＋ 生成密钥', generateKey, 'primary');
  const create = button('＋ 创建密钥', createKey, 'outlined');
  create.hidden = !api.keys.create;
  const localTab = button('本机密钥', () => setSource(false));
  const agentTab = button('SSH Agent', () => setSource(true));
  const addAgent = button('加入 SSH Agent', () => loadAgentKey(), 'outlined');
  const agentGuide = node('section', 'host-form-section key-agent-guide', node('h3', '', 'SSH Agent'),
    node('p', 'muted', 'Agent 暂存已解锁的私钥并代为签名，减少连接时重复输入口令。先生成或选择本机私钥，再将它加入正在运行的 Agent；主机认证方式选择「SSH Agent」即可使用。'),
    button('刷新 Agent', loadAgent, 'outlined'));
  const directories = node('div', 'key-directories', node('div', '', node('span', 'muted', '扫描目录'), location),
    node('div', 'settings-actions', button('扫描 ~/.ssh', () => scan(), 'outlined'),
      button('选择目录', async () => { const directory = await api.keys.directory(); if (directory && browser.isConnected) await scan(directory); }, 'outlined')));
  let rows = [];
  let agentRows = [];
  let localNote = '正在扫描本机密钥…';
  let agentNote = '';
  let fromAgent = false;
  let selected;
  let revision = 0;
  let agentRevision = 0;
  let directoryReady = false;

  async function createKey() {
    if (!directoryReady) return;
    let directory = location.textContent;
    const destination = node('code', '', directory);
    const name = input(); name.required = true; name.maxLength = 80; name.placeholder = '如 production_key'; name.dataset.keyCreate = 'name';
    const privateKey = node('textarea'); privateKey.rows = 7; privateKey.required = true; privateKey.spellcheck = false;
    privateKey.placeholder = '粘贴 OpenSSH / PEM 格式的私钥内容'; privateKey.dataset.keyCreate = 'private';
    const publicKey = node('textarea'); publicKey.rows = 3; publicKey.spellcheck = false;
    publicKey.placeholder = '可留空，自动从私钥提取'; publicKey.dataset.keyCreate = 'public';
    const mode = node('select'); mode.append(new Option('密码', 'password'));
    const secret = passwordEditor(undefined, mode, false, () => false, () => false, { label: '私钥口令',
      placeholder: '加密私钥需要填写，未加密可留空', hint: '仅用于本次校验，不会另存此口令。' });
    secret.update(); secret.password.dataset.keyCreate = 'passphrase';
    const addAfterCreation = input('', 'checkbox'); addAfterCreation.dataset.keyCreate = 'add-agent';
    const agentOption = node('div', '', node('label', 'checkbox-row', addAfterCreation, '创建后加入 SSH Agent'),
      node('p', 'muted', '加入本机正在运行的 Agent，使用本次口令解锁，无需再次输入。'));
    agentOption.hidden = !api.keys.addAgent;
    const setup = node('div', 'key-create-fields',
      node('section', 'host-form-section', field('名称（保存文件名）', name),
        field('私钥内容', privateKey),
        ...(api.keys.importFile ? [button('从私钥文件导入', async () => {
          const imported = await api.keys.importFile();
          if (!imported || !dialog.contains(privateKey)) return;
          privateKey.value = imported.privateKey;
          if (!name.value.trim()) name.value = imported.name;
          publicKey.value = '';
        }, 'outlined')] : []), secret.pane, agentOption),
      node('section', 'host-form-section', field('公钥内容（可选）', publicKey), node('small', 'muted', '留空自动提取；填写时会核对与私钥是否匹配。')),
      node('section', 'host-form-section', node('h3', '', '保存位置'), destination,
        button('选择目录', async () => { const chosen = await api.keys.directory(); if (chosen) { directory = chosen; destination.textContent = chosen; } }, 'outlined'),
        node('small', 'muted', '保留原私钥的加密状态，不覆盖同名文件。创建后可在主机中选择使用。')));
    const savedName = node('strong'), savedPath = node('code');
    const savedSummary = node('section', 'host-form-section key-created-summary', node('h3', '', '密钥已创建'), savedName, savedPath,
      node('p', 'muted', '私钥与公钥已保存到本机。重试仅加载 Agent，不会重新创建密钥。'));
    savedSummary.hidden = true;
    const progress = node('p', 'muted'); progress.setAttribute('role', 'status');
    const content = node('div', '', setup, savedSummary, progress);
    const snapshot = () => JSON.stringify([directory, name.value, privateKey.value, publicKey.value, secret.password.value, addAfterCreation.checked]);
    const original = snapshot();
    let saved, savedDirectory, savedPassphrase = '', shouldAdd = false, agentAdded = false;
    window.addEventListener('blur', secret.hide);
    try {
      await prompt('创建 SSH 密钥', [content], '创建密钥', async () => {
        try {
          if (!saved) {
            progress.textContent = '正在创建密钥，请稍候…';
            savedDirectory = directory; savedPassphrase = secret.password.value;
            shouldAdd = addAfterCreation.checked;
            saved = await api.keys.create({ directory: savedDirectory, name: name.value.trim(), privateKey: privateKey.value,
              publicKey: publicKey.value, passphrase: savedPassphrase });
          }
          if (shouldAdd && !agentAdded) {
            setup.hidden = true; savedSummary.hidden = false;
            savedName.textContent = saved.name; savedPath.textContent = saved.path;
            dialog.querySelector('.actions button[type="submit"]').textContent = '重试加入 SSH Agent';
            dialog.querySelector('.actions button[type="button"]').textContent = '完成';
            progress.textContent = '密钥已创建，正在加入 SSH Agent…';
            try {
              await api.keys.addAgent({ path: saved.path, passphrase: savedPassphrase });
              agentAdded = true;
            } catch (failure) {
              throw new Error(`密钥已创建并保存，但加入 SSH Agent 失败：${message(failure)} 可重试，或点击「完成」保留密钥。`);
            }
          }
          return saved;
        } finally { progress.textContent = ''; }
      }, [], { drawer: true, closeLabel: '关闭密钥创建表单',
        canClose: () => Boolean(saved) || snapshot() === original || confirmDiscardHostChanges('密钥配置') });
      if (saved && browser.isConnected) {
        setSource(false); await scan(savedDirectory, saved);
        if (directoryReady) note.textContent = localNote = agentAdded ? `已创建 ${saved.name}，并已加入 SSH Agent。`
          : shouldAdd ? `已创建 ${saved.name}；尚未加入 SSH Agent，可从密钥详情重试。` : `已创建 ${saved.name}，可在主机中选择使用。`;
      }
    } finally {
      window.removeEventListener('blur', secret.hide); secret.hide();
      secret.password.value = ''; savedPassphrase = ''; privateKey.value = ''; publicKey.value = '';
    }
  }

  async function loadAgentKey(key) {
    const path = input(key?.path || ''); path.readOnly = true; path.placeholder = '请选择已有私钥';
    path.setAttribute('aria-label', '要加入 Agent 的私钥');
    const passphrase = input('', 'password'); passphrase.autocomplete = 'off';
    const initialPath = path.value;
    const fields = node('section', 'host-form-section',
      field('本机私钥', path), button('选择私钥', () => manageKeys(value => { path.value = value; }, path.value), 'outlined'),
      field('私钥口令（加密私钥需要）', passphrase),
      node('p', 'muted', '口令仅用于本次解锁；Agent 退出或移除密钥后，需要重新加载。'));
    try {
      const result = await prompt('加入 SSH Agent', [fields], '加入 Agent', () => {
        if (!path.value) throw new Error('请选择已有私钥。');
        return api.keys.addAgent({ path: path.value, passphrase: passphrase.value });
      }, [], { drawer: true, closeLabel: '关闭 Agent 加载表单',
        canClose: () => (path.value === initialPath && !passphrase.value) || confirmDiscardHostChanges('Agent 加载配置') });
      if (result && browser.isConnected) {
        setSource(true, false);
        await loadAgent();
        note.textContent = `已加入 SSH Agent。${agentNote}`;
      }
    } finally { passphrase.value = ''; }
  }

  async function generateKey() {
    if (!directoryReady) return;
    let directory = location.textContent;
    const destination = node('code', '', directory);
    const name = input('id_ed25519_termlume'); name.required = true; name.dataset.keyField = 'name';
    const passphrase = input('', 'password'); passphrase.autocomplete = 'new-password'; passphrase.dataset.keyField = 'passphrase';
    const addAfterGeneration = input('', 'checkbox'); addAfterGeneration.dataset.keyField = 'add-agent';
    const agentOption = node('div', '', node('label', 'checkbox-row', addAfterGeneration, '生成后加入 SSH Agent'),
      node('p', 'muted', '加入本机正在运行的 Agent，使用本次口令解锁，无需再次输入。'));
    agentOption.hidden = !api.keys.addAgent;
    const type = node('select'); type.dataset.keyField = 'type';
    type.append(new Option('Ed25519（推荐）', 'ed25519'), new Option('RSA', 'rsa'), new Option('ECDSA', 'ecdsa'));
    const rsaBits = node('select'); rsaBits.dataset.keyField = 'rsa-bits';
    for (const bits of [2048, 3072, 4096]) rsaBits.append(new Option(`${bits} 位`, bits));
    rsaBits.value = '3072';
    const ecBits = node('select'); ecBits.dataset.keyField = 'ecdsa-bits';
    for (const bits of [256, 384, 521]) ecBits.append(new Option(`${bits} 位 · NIST P-${bits}`, bits));
    const rsaField = field('密钥位数', selectControl(rsaBits, 'RSA 密钥位数'));
    const ecField = field('曲线 / 位数', selectControl(ecBits, 'ECDSA 曲线 / 位数'));
    const hint = node('p', 'muted');
    const updateType = () => {
      rsaField.hidden = type.value !== 'rsa'; ecField.hidden = type.value !== 'ecdsa';
      hint.textContent = ({ ed25519: 'Ed25519 使用固定长度，无需配置位数。', rsa: 'RSA 默认 3072 位；位数越大，生成所需时间越长。', ecdsa: '位数对应所选的 NIST 椭圆曲线。' })[type.value];
      if (/^id_(ed25519|rsa|ecdsa)_termlume$/.test(name.value)) name.value = `id_${type.value}_termlume`;
    };
    type.addEventListener('change', updateType); updateType();
    const snapshot = () => JSON.stringify([directory, name.value, passphrase.value, type.value, rsaBits.value, ecBits.value, addAfterGeneration.checked]);
    const initial = snapshot();
    const progress = node('p', 'muted'); progress.setAttribute('role', 'status');
    const setup = node('div', 'key-generation-fields',
      node('section', 'host-form-section', node('h3', '', '保存位置'), destination,
        button('选择目录', async () => {
          const selected = await api.keys.directory();
          if (selected) { directory = selected; destination.textContent = selected; }
        }, 'outlined')),
      node('section', 'host-form-section', field('密钥文件名', name), field('密钥类型', selectControl(type, '密钥类型')),
        rsaField, ecField, hint, field('私钥口令（可选）', passphrase),
        node('p', 'muted', '同时创建私钥与 .pub 公钥，不覆盖同名文件。'), agentOption));
    const generatedName = node('strong');
    const generatedPath = node('code');
    const generatedSummary = node('section', 'host-form-section key-generated-summary', node('h3', '', '密钥已生成'), generatedName, generatedPath,
      node('p', 'muted', '私钥与公钥已保存到本机。重试仅加载 Agent，不会重新生成密钥。'));
    generatedSummary.hidden = true;
    const fields = node('div', '', setup, generatedSummary, progress);
    let generated, generatedDirectory, generatedPassphrase = '', shouldAdd = false, agentAdded = false;
    try {
      await prompt('生成 SSH 密钥', [fields], '生成密钥', async () => {
        try {
          if (!generated) {
            progress.textContent = '正在生成密钥，请稍候…';
            generatedDirectory = directory;
            generatedPassphrase = passphrase.value;
            shouldAdd = addAfterGeneration.checked;
            generated = await api.keys.generate({ directory: generatedDirectory, name: name.value, passphrase: generatedPassphrase, type: type.value,
              ...(type.value === 'ed25519' ? {} : { bits: Number(type.value === 'rsa' ? rsaBits.value : ecBits.value) }) });
          }
          if (shouldAdd && !agentAdded) {
            setup.hidden = true; generatedSummary.hidden = false;
            generatedName.textContent = generated.name; generatedPath.textContent = generated.path;
            dialog.querySelector('.actions button[type="submit"]').textContent = '重试加入 SSH Agent';
            dialog.querySelector('.actions button[type="button"]').textContent = '完成';
            progress.textContent = '密钥已生成，正在加入 SSH Agent…';
            try {
              await api.keys.addAgent({ path: generated.path, passphrase: generatedPassphrase });
              agentAdded = true;
            } catch (failure) {
              throw new Error(`密钥已生成并保存，但加入 SSH Agent 失败：${message(failure)} 可重试，或点击「完成」保留密钥。`);
            }
          }
          return generated;
        } finally { progress.textContent = ''; }
      }, [], { drawer: true, closeLabel: '关闭密钥创建表单',
        canClose: () => Boolean(generated) || snapshot() === initial || confirmDiscardHostChanges('密钥配置') });
      if (generated && browser.isConnected) {
        setSource(false); await scan(generatedDirectory, generated);
        if (directoryReady && shouldAdd) {
          localNote = agentAdded ? `已生成 ${generated.name}，并已加入 SSH Agent。` : `已生成 ${generated.name}；尚未加入 SSH Agent，可从密钥详情重试。`;
          note.textContent = localNote;
        }
      }
    } finally { passphrase.value = ''; generatedPassphrase = ''; }
  }
  function describe(key) {
    return fromAgent ? key.type : `${key.type} · ${key.private ? (key.encrypted ? '加密私钥' : '私钥') : '仅公钥'}`;
  }
  function showDetail(key) {
    selected = key;
    detail.hidden = !key;
    for (const card of list.children) if (card.key) card.setAttribute('aria-pressed', String(card.key === key));
    if (!key) { detail.replaceChildren(); return; }
    const controls = node('div', 'settings-actions');
    if (!fromAgent && key.private && api.keys.addAgent) controls.append(button('加入 SSH Agent', () => loadAgentKey(key), 'outlined'));
    if (key.publicKey) controls.append(button('复制公钥', async () => {
      await api.keys.copy(key.publicKey);
      note.textContent = '已复制公钥。';
    }, 'outlined'));
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
    const visible = (fromAgent ? agentRows : rows).filter((key) =>
      `${key.name} ${key.type} ${key.fingerprint || ''}`.toLowerCase().includes(query));
    list.replaceChildren();
    for (const key of visible) {
      const card = button('', () => {
        showDetail(selected === key ? undefined : key);
        if (!detail.hidden) detail.scrollIntoView({ block: 'nearest' });
      }, 'key-card');
      card.key = key;
      card.append(settingsIcon('key'), node('span', 'key-card-label', summaryText('strong', key.name), summaryText('small', describe(key))));
      list.append(card);
    }
    if (!visible.length) list.append(node('div', 'empty-state', settingsIcon('key'), node('p', 'muted', query ? '没有匹配的密钥。' :
      (fromAgent ? '暂无可显示的 Agent 身份。' : '此目录中没有找到 SSH 密钥。'))));
    showDetail(visible.includes(selected) ? selected : undefined);
  }
  function setSource(agent, reload = true) {
    if (fromAgent !== agent) { selected = undefined; search.value = ''; }
    fromAgent = agent;
    localTab.setAttribute('aria-pressed', String(!agent));
    agentTab.setAttribute('aria-pressed', String(agent));
    directories.hidden = agent;
    agentGuide.hidden = !agent;
    addAgent.hidden = !agent || !api.keys.addAgent;
    note.textContent = agent ? agentNote : localNote;
    render();
    if (agent && reload) void loadAgent();
  }
  async function loadAgent() {
    const current = ++agentRevision;
    note.textContent = '正在读取 SSH Agent…';
    try {
      const agent = await api.keys.agent();
      if (current !== agentRevision || !browser.isConnected) return;
      agentRows = agent.keys.map(key => ({ ...key, name: rows.find(local => local.fingerprint === key.fingerprint)?.name || key.name }));
      agentNote = agent.available ? `已加载 ${agent.keys.length} 个身份。` : 'SSH Agent 暂不可用，请先启动或解锁本机 Agent。';
    } catch (error) { agentNote = message(error); }
    if (current === agentRevision && browser.isConnected && fromAgent) { note.textContent = agentNote; render(); }
  }
  async function scan(directory, reveal) {
    const current = ++revision;
    directoryReady = false;
    generate.disabled = true;
    create.disabled = true;
    localNote = '正在扫描本机密钥…';
    if (!fromAgent) note.textContent = localNote;
    try {
      const result = await api.keys.scan(directory);
      if (current !== revision || !browser.isConnected) return;
      keyDirectory = result.directory;
      keyDirectories.add(result.directory);
      rows = result.keys;
      location.textContent = keyDirectory;
      directoryReady = true;
      localNote = reveal ? `已生成 ${reveal.name}。` : `找到 ${rows.length} 项密钥。`;
      if (reveal && !fromAgent) { search.value = ''; selected = rows.find((key) => key.path === reveal.path); }
    } catch (error) { if (current === revision) localNote = message(error); }
    if (current !== revision || !browser.isConnected) return;
    generate.disabled = !directoryReady;
    create.disabled = !directoryReady;
    if (!fromAgent) { note.textContent = localNote; render(); }
  }
  search.addEventListener('input', render);
  const controls = node('div', 'key-toolbar', node('div', 'settings-switcher', localTab, agentTab), search, addAgent, create, generate);
  const body = node('div', 'page-body', directories, agentGuide, note, node('div', 'key-body', list, detail));
  controls.classList.add('page-toolbar');
  browser.append(controls, body);
  setSource(false);
  // Scan after the page or dialog has attached the browser.
  queueMicrotask(() => { if (browser.isConnected) void scan(keyDirectory); });
  return browser;
}

function manageKeys(onSelect, currentPath) {
  const pane = $('key-dialog');
  if (pane.open || vaultStatus.locked) return;
  const title = node('h2', '', '选择私钥');
  title.id = 'key-dialog-title';
  const list = node('div', 'key-picker-list');
  list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', '已有私钥');
  const note = node('p', 'muted', '正在读取私钥'); note.setAttribute('role', 'status');
  let selected;
  const confirm = button('确定', () => { if (selected) { onSelect(selected.path); pane.close(); } }, 'primary key-picker-confirm');
  confirm.disabled = true;
  pane.classList.add('key-picker');
  pane.replaceChildren(title, list, note, node('div', 'actions', confirm, button('关闭', () => pane.close(), 'outlined')));
  pane.addEventListener('close', () => pane.replaceChildren(), { once: true });
  window.overlays.show(pane);
  const current = () => pane.open && pane.contains(list) && !vaultStatus.locked;
  const choose = key => {
    selected = key; confirm.disabled = !key;
    for (const card of list.children) {
      const checked = card.dataset.path === key?.path;
      card.setAttribute('aria-checked', String(checked));
      card.tabIndex = checked || (!key && card === list.firstElementChild) ? 0 : -1;
    }
  };
  const directories = keyDirectories.size ? [...keyDirectories] : [keyDirectory];
  void Promise.allSettled(directories.map(directory => api.keys.scan(directory))).then(results => {
    if (!current()) return;
    const keys = new Map();
    for (const result of results) if (result.status === 'fulfilled') {
      keyDirectories.add(result.value.directory);
      for (const key of result.value.keys) if (key.private) keys.set(key.path, key);
    }
    const available = [...keys.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const key of available) {
      const card = button('', () => choose(key), 'key-card');
      card.dataset.path = key.path;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-label', `${key.name} · ${key.type}`);
      card.append(settingsIcon('key'), node('span', 'key-card-label', summaryText('strong', key.name), node('small', 'muted', key.type)), node('span', 'key-picker-check', '✓'));
      list.append(card);
    }
    choose(available.find(key => key.path === currentPath));
    list.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !available.length) return;
      event.preventDefault();
      const at = Math.max(0, available.indexOf(selected));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
        : (at + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + available.length) % available.length;
      choose(available[next]); list.children[next].focus();
    });
    note.textContent = !available.length ? '暂无可选私钥，请先在 SSH 密钥页面添加。'
      : results.some(result => result.status === 'rejected') ? '部分私钥未能读取，请在 SSH 密钥页面检查。' : '';
    (list.querySelector('[aria-checked="true"]') || list.firstElementChild)?.focus();
  });
}

function passwordEditor(host, auth, hasPassword, sameTarget, isLinked = () => false, settings = {}) {
  const label = settings.label || 'SSH 密码';
  const password = input('', 'password');
  password.setAttribute('aria-label', label);
  password.autocomplete = 'new-password';
  password.spellcheck = false;
  password.setAttribute('autocorrect', 'off');
  password.setAttribute('autocapitalize', 'off');
  password.maxLength = 4096;
  const revealed = input();
  revealed.readOnly = true;
  revealed.autocomplete = 'off';
  revealed.spellcheck = false;
  revealed.setAttribute('aria-label', `已保存的${label === 'SSH 密码' ? ' ' : ''}${label}`);
  revealed.hidden = true;
  const hint = node('small');
  hint.setAttribute('role', 'status');
  let generation = 0;
  let timer;
  let loading = false;
  const eligible = () => hasPassword && sameTarget() && !isLinked();
  const visible = () => password.type === 'text' || !revealed.hidden;
  const update = () => {
    pane.hidden = auth.value !== (settings.auth || 'password') || isLinked();
    const saved = eligible();
    password.placeholder = saved ? '••••••••••••' : settings.placeholder || '输入 SSH 密码，或在连接时输入';
    password.classList.toggle('has-saved-password', Boolean(saved));
    password.hidden = !revealed.hidden;
    toggle.replaceChildren(chromeIcon(visible() ? 'eye-off' : 'eye'));
    toggle.setAttribute('aria-label', visible() ? `隐藏${label}` : !password.value && saved ? `查看已保存的${label}` : `显示${label}`);
    toggle.title = toggle.getAttribute('aria-label');
    toggle.setAttribute('aria-pressed', String(visible()));
    toggle.disabled = loading || password.disabled || password.form?.getAttribute('aria-busy') === 'true' || (!password.value && !saved);
    hint.textContent = hasPassword && !saved
      ? settings.changedHint || '连接信息有变更，请为新目标输入密码。'
      : saved ? settings.savedHint || '密码已加密保存在本机；输入新密码可替换。' : settings.hint || '填写后由 Termlume 加密保存在本机。';
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
        const secret = await (settings.reveal ? settings.reveal() : api.hosts.revealPassword(host.id));
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
  }, 'password-visibility');
  const pane = node('div', 'credential-pane host-password-pane', field(label,
    node('div', 'credential-row password-control', chromeIcon('lock'), password, revealed, toggle)), hint);
  password.addEventListener('input', () => {
    if (!revealed.hidden || loading) hide();
    else update();
  });
  return { pane, password, hide, update };
}

async function manageTrust(page) {
  if (!page) return openSettings('trust');
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);

  while(page.active && !vaultStatus.locked){const entries=await api.trust.list();let choice;const search=input('','search');search.placeholder='搜索地址、指纹或主机';const list=node('div','forward-list');const render=()=>{const q=search.value.toLowerCase();list.replaceChildren(...entries.filter(e=>`${e.address} ${e.fingerprint} ${e.hosts.join(' ')}`.toLowerCase().includes(q)).map(e=>node('section','forward-rule',node('strong','',`${e.address}:${e.port}`),node('code','',e.fingerprint),node('small','muted',e.hosts.join('、')||'未关联主机'),button('移除信任',()=>{choice={forget:e};close();},'outlined danger'))));};search.addEventListener('input',render);render();await ask('Known Hosts',[search,list],'关闭',()=>true,[button('导入 known_hosts',()=>{choice={import:true};close();},'outlined')]);if(!choice)break;
    if(choice.forget){const e=choice.forget;if(await confirm('移除主机信任',`${e.address}:${e.port}\n${e.fingerprint}\n后续连接会重新要求确认指纹；登录配置密码仍保留，但不会跳过目标信任检查。`,'移除'))await api.trust.forget(e);}
    else {const preview=await api.trust.importPreview();if(!preview)continue;const checks=preview.rows.map(row=>{const selected=input('','checkbox');selected.checked=true;return {row,selected,view:node('label','checkbox-row',selected,`${row.address}:${row.port} · ${row.fingerprint}`)};});await ask('导入主机信任',[...preview.warnings.map(w=>node('p','muted',w)),node('p','muted','仅导入已独立核验来源的密钥；不同指纹不会覆盖已有记录。'),...checks.map(c=>c.view)],'导入选中指纹',()=>api.trust.import(checks.filter(c=>c.selected.checked).map(c=>c.row)));}
  }
}

function terminalThemeFor(host) {
  const light = (host?.terminalTheme || uiPreferences.terminalTheme) === 'light';
  const styles = getComputedStyle(document.documentElement);
  const prefix = `--terminal-${light ? 'light' : 'dark'}`;
  const color = suffix => styles.getPropertyValue(prefix + suffix).trim();
  const ansi=light?{black:'#2d2230',brightBlack:'#796b78',red:'#b73535',brightRed:'#b73535',green:'#187447',brightGreen:'#187447',yellow:'#8b650b',brightYellow:'#8b650b',blue:'#285eb2',brightBlue:'#285eb2',magenta:'#a13d70',brightMagenta:'#a13d70',cyan:'#0c7180',brightCyan:'#0c7180',white:'#766872',brightWhite:'#2d2230'}:{black:'#756675',brightBlack:'#bbafbe',red:'#f58291',brightRed:'#ffacb7',green:'#84d5a4',brightGreen:'#a2e9bb',yellow:'#e7c47d',brightYellow:'#ffdb97',blue:'#83aff6',brightBlue:'#a6c7ff',magenta:'#f58cb8',brightMagenta:'#ffc2db',cyan:'#7ccedb',brightCyan:'#a0e7f0',white:'#e1d3de',brightWhite:'#fff4fb'};
  return { ...ansi, background: color(''), foreground: color('-text'), cursor: color('-cursor'), selectionBackground: color('-selection') };
}
function applyTerminalPreferences(tab) {
  if (!tab?.terminal) return;
  const theme = terminalThemeFor(tab.host);
  tab.view.style.setProperty('--terminal-background', theme.background);
  tab.terminal.options.theme = theme;
}
function applyPreferences(fonts = false) {
  document.documentElement.dataset.theme=uiPreferences.theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):uiPreferences.theme;
  document.documentElement.dataset.terminalTheme=uiPreferences.terminalTheme;
  for(const tab of tabs.values())if(tab.terminal){if(fonts){tab.terminal.options.fontFamily=uiPreferences.fontFamily;tab.terminal.options.fontSize=uiPreferences.fontSize;}applyTerminalPreferences(tab);tab.rendering.fit();}
  if (['cards','rows','tree'].includes(uiPreferences.hostLayout)) {
    if (hostLayout.value !== uiPreferences.hostLayout) {
      hostLayout.value = uiPreferences.hostLayout;
      hostLayout.dispatchEvent(new Event('input'));
      workspace.dataset.hostLayout = hostLayout.value;
      if (hostLayout.value === 'tree') currentGroup = selectedGroup = '';
    }
    navigationPreference = uiPreferences.navigationCollapsed ?? undefined;
    updateNavigation();
    try {
      localStorage.setItem('host-layout', hostLayout.value);
      if (navigationPreference == null) localStorage.removeItem('nav-collapsed');
      else localStorage.setItem('nav-collapsed', String(navigationPreference));
    } catch { /* In-memory preferences still work. */ }
  }
}

async function migrateViewPreferences(preferences) {
  if (vaultStatus.locked || preferences.hostLayout != null || !api.preferences?.saveView) return preferences;
  if (!viewPreferencesMigration) {
    viewPreferencesMigration = api.preferences.saveView({hostLayout:hostLayout.value,navigationCollapsed:navigationPreference ?? null})
      .finally(() => { viewPreferencesMigration = undefined; });
  }
  return viewPreferencesMigration;
}

function saveViewPreferences() {
  if (!api.preferences?.saveView || vaultStatus.locked) return;
  const value = {hostLayout:hostLayout.value,navigationCollapsed:navigationPreference ?? null};
  // Keep view changes ordered without overwriting a concurrent theme/font edit.
  viewPreferencesSave = viewPreferencesSave.catch(() => {}).then(() => api.preferences.saveView(value)).then(p => {
    if (!vaultStatus.locked && value.hostLayout === hostLayout.value && value.navigationCollapsed === (navigationPreference ?? null)) {
      uiPreferences = {...uiPreferences,hostLayout:p.hostLayout,navigationCollapsed:p.navigationCollapsed};
    }
  }).catch(error => status(message(error)));
}
async function editPreferences(page) {
  if (!page) return openSettings('preferences');
  const ask = settingsAsk(page);
  const [preferences, installedFonts] = await Promise.all([
    api.preferences.get(),
    api.preferences.fonts?.().catch(() => []) ?? []
  ]);
  const theme = node('select');
  theme.append(new Option('深色', 'dark'), new Option('浅色', 'light'), new Option('跟随系统', 'system'));
  theme.value = preferences.theme;
  const terminal = node('select');
  terminal.append(new Option('深色终端', 'dark'), new Option('浅色终端', 'light'));
  terminal.value = preferences.terminalTheme;
  const family = node('select');
  family.append(new Option('系统默认', defaultTerminalFont));
  for (const name of installedFonts.sort((a, b) => a.localeCompare(b))) {
    const fontStack = `${JSON.stringify(name)}, monospace`;
    if (fontStack.length <= 240) family.append(new Option(name, fontStack));
  }
  family.value = preferences.fontFamily;
  if (!family.selectedOptions.length) {
    family.append(new Option(`当前设置（${preferences.fontFamily}）`, preferences.fontFamily, false, true));
  }
  const size = input(preferences.fontSize, 'number');
  size.min = 9;
  size.max = 32;
  const history = input('', 'checkbox');
  history.checked = preferences.recordCommands;
  await ask('界面与终端偏好', [
    field('应用主题', selectControl(theme, '应用主题')),
    field('终端配色', selectControl(terminal, '终端配色')),
    field('终端字体', selectControl(family, '终端字体')),
    field('默认字号（9–32）', size),
    node('label', 'checkbox-row', history, '保存通过独立通道执行的命令历史'),
    node('p', 'muted', '主题、字体字号及主机视图和排序偏好会加入加密备份与 Git 同步。命令历史和记录开关仅留在本机；不采集任意终端键入和密码提示中的输入。')
  ], '保存偏好', async () => {
    uiPreferences = await api.preferences.save({
      theme: theme.value, terminalTheme: terminal.value, fontFamily: family.value,
      fontSize: Number(size.value), recordCommands: history.checked
    });
    applyPreferences(true);
    return uiPreferences;
  }, [], { closeOnSubmit: false, back: false });
}
async function toggleRecording(session){
  if(recordingSessions.has(session.id)){await api.logs.stop(session.id);recordingSessions.delete(session.id);}
  else if(await confirm('记录会话输出',`${session.host.name} · ${endpoint(session.host)}\n只记录后续远端输出（含此会话的命令输出），不记录键入。输出可能含敏感内容，将以明文保存在本机；每条最多 20 MiB，保留最近 50 条。锁定或断线后停止。`,'开始记录')){await api.logs.start(session.id);recordingSessions.add(session.id);}
  renderContext();
}
async function manageLogs(page){
  if (!page) return openSettings('logs');
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);

  while(page.active && !vaultStatus.locked){const logs=await api.logs.list();recordingSessions.clear();for(const log of logs)if(log.active)recordingSessions.add(log.sessionId);let choice;const filter=input('','search');filter.placeholder='搜索主机、地址或时间';const list=node('div','forward-list');
    const render=()=>{const q=filter.value.toLowerCase();list.replaceChildren(...logs.filter(l=>`${l.host} ${l.address} ${new Date(l.started).toLocaleString()}`.toLowerCase().includes(q)).map(l=>node('section','forward-rule',node('strong','',`${l.host} · ${new Date(l.started).toLocaleString()}`),node('small','muted',`${l.address} · ${bytes(l.bytes)}${l.active?' · 录制中':''}`),node('div','forward-actions',button('查看',()=>{choice={read:l};close();},'outlined'),button('导出',()=>api.logs.export(l.id),'outlined'),button(l.active?'停止':'删除',()=>{choice=l.active?{stop:l}:{remove:l};close();},'outlined danger')))));};filter.addEventListener('input',render);render();await ask('本机会话日志',[filter,list],'关闭',()=>true);if(!choice)break;
    if(choice.stop){await api.logs.stop(choice.stop.sessionId);continue;}if(choice.remove){if(await confirm('删除会话日志',`永久删除 ${choice.remove.host} 的这条本机日志？`,'删除'))await api.logs.remove(choice.remove.id);continue;}
    const text=await api.logs.read(choice.read.id);const search=input('','search');search.placeholder='筛选日志行';const output=node('pre','operation-results',text);search.addEventListener('input',()=>{output.textContent=search.value?text.split('\n').filter(line=>line.toLowerCase().includes(search.value.toLowerCase())).join('\n'):text;});await ask('查看会话日志',[search,output],'关闭',()=>true,[button('返回日志列表',close,'outlined')]);
  }renderContext();
}
async function commandHistory(session){const history=await api.history.list();let selected;const list=history.slice().reverse().map(item=>node('section','forward-rule',node('strong','',`${item.host} · ${new Date(item.at).toLocaleString()}`),node('pre','operation-results',item.command),...(session?.status==='ready'?[button('执行到当前会话',()=>{selected=item;dialog.close();},'outlined')]:[])));
  await prompt('本机命令执行历史',list.length?list:[node('p','muted','在偏好中开启后，仅保存应用通过独立通道执行的命令。')],'关闭',()=>true,[button('清空历史',async()=>{if(window.confirm('清空本机命令历史？')){await api.history.clear();dialog.close();}},'outlined danger')]);
  if(selected&&await confirm('再次执行',`原目标 ${selected.endpoint}\n当前目标 ${endpoint(session.host)}\n${selected.command}`,'执行')){const tab={id:sessionId(),kind:'command',sessionId:session.id,host:session.host,action:'custom',status:'connecting'};attachTerminal(tab);tabs.set(tab.id,tab);selectTab(tab);await api.commands.start({id:tab.id,sessionId:session.id,request:{action:'custom',argument:selected.command,lines:100}});}
}

function splitGroupFor(id) {
  return id ? [...splitGroups.values()].find(group => group.panes.includes(id)) : undefined;
}

function workspaceEntries() {
  return layoutState.workspaceTabs([...tabs.keys()], [...splitGroups.values()]).map(entry => ({
    ...entry, group: splitGroups.get(entry.key), tab: tabs.get(entry.representativeId)
  }));
}

function workspaceEntryFor(id) { return workspaceEntries().find(entry => entry.panes.includes(id)); }
function workspaceFocus(entry) { return tabs.get(entry?.group?.focusId) || entry?.tab; }
function workspaceTitle(entry) { return entry?.group ? entry.group.title || '工作区' : tabTitle(entry.tab); }

function reorderWorkspaceSessions(moving, beforeKey, beforeId) {
  const ordered = [...tabs.keys()], remaining = ordered.filter(id => !moving.includes(id));
  const entries = layoutState.workspaceTabs(remaining, [...splitGroups.values()]);
  const before = entries.find(entry => entry.key === beforeKey || entry.panes.includes(beforeId || beforeKey));
  const index = before ? remaining.indexOf(before.representativeId) : remaining.length;
  remaining.splice(index, 0, ...ordered.filter(id => moving.includes(id)));
  const values = remaining.map(id => [id, tabs.get(id)]);
  tabs.clear();
  for (const [id, tab] of values) tabs.set(id, tab);
  $('tabs').append(...[...tabs.values()].map(tab => tab.tabRow));
  renderTabs();
}

function reorderTabs(moving, before) {
  if (moving === before || !tabs.has(moving) || !tabs.has(before)) return;
  const entry = workspaceEntryFor(moving), target = workspaceEntryFor(before);
  if (entry.key !== target.key) reorderWorkspaceSessions(entry.panes, target.key);
}

async function editTab(tab) {
  const entry = workspaceEntryFor(tab.id), group = entry?.group;
  const title = input(group ? group.title || '' : tab.title || '');
  title.maxLength = 80; title.placeholder = group ? '工作区' : tabName(tab);
  const move = delta => {
    const entries = workspaceEntries(), index = entries.findIndex(item => item.key === entry.key);
    const target = entries[index + delta];
    if (target) {
      if (delta < 0) reorderWorkspaceSessions(entry.panes, target.key);
      else reorderWorkspaceSessions(entry.panes, entries[index + 2]?.key);
    }
    dialog.close();
  };
  await prompt(group ? '工作区名称与顺序' : '标签名称与顺序', [field('自定义名称（留空恢复默认）', title)], '保存', () => {
    if (group) group.title = title.value.trim(); else tab.title = title.value.trim();
    renderTabs(); renderSplitLayout(); return true;
  }, [button('左移', () => move(-1), 'outlined'), button('右移', () => move(1), 'outlined')]);
}

function splitFromTree(tree, previous = {}) {
  const panes = layoutState.paneIds(tree);
  return { ...previous, id: previous.id || sessionId(), tree, panes, direction: 'tree', focusId: panes.includes(previous.focusId) ? previous.focusId : panes[0] };
}

function replaceGroupTree(group, tree) {
  const panes = layoutState.paneIds(tree);
  if (panes.length < 2) splitGroups.delete(group.id);
  else splitGroups.set(group.id, splitFromTree(tree, group));
}

function installSplitLayout(value, previous) {
  const tree = layoutState.layoutTree(value), group = splitFromTree(tree, { ...previous, ...value, id: previous?.id || value.id });
  for (const other of [...splitGroups.values()]) if (other.id !== group.id && other.panes.some(id => group.panes.includes(id))) {
    replaceGroupTree(other, group.panes.reduce((result, id) => layoutState.removePane(result, id), other.tree));
  }
  if (group.panes.length >= 2) splitGroups.set(group.id, group);
  return group.panes.length >= 2 ? group : undefined;
}

function syncPendingSplitLayout() {
  if (splitLayout && (!splitLayout.id || splitGroups.get(splitLayout.id) !== splitLayout)) splitLayout = installSplitLayout(splitLayout);
}

function visibleSplitLayout() {
  syncPendingSplitLayout();
  splitLayout = splitGroupFor(active?.id);
  return splitLayout;
}

function removeSplitPane(id) {
  const group = splitGroupFor(id);
  if (!group) return;
  const tree = layoutState.removePane(group.tree, id), panes = layoutState.paneIds(tree);
  replaceGroupTree(group, tree);
  splitLayout = splitGroupFor(active?.id);
  return panes.includes(group.focusId) ? group.focusId : panes[0];
}

function detachSplitPane(tab) {
  removeSplitPane(tab.id);
  selectTab(tab);
}

function renderSplitLayout() {
  const container = $('terminal-views');
  container.querySelectorAll('.split-grip, .split-empty').forEach(item => item.remove());
  splitGrip = splitRowGrip = undefined;
  const layout = visibleSplitLayout();
  container.dataset.split = layout ? 'tree' : '';
  container.style.gridTemplateColumns = container.style.gridTemplateRows = '';
  resizeSplitLayout = () => {};
  for (const tab of tabs.values()) {
    if (!tab.view) continue;
    tab.view.hidden = layout ? !layout.panes.includes(tab.id) : tab !== active;
    tab.view.classList.toggle('split-focused', Boolean(layout && tab === active));
    if (layout?.panes.includes(tab.id)) tab.unread = false;
    for (const property of ['gridColumn', 'gridRow', 'order', 'left', 'top', 'width', 'height', 'right', 'bottom']) tab.view.style[property] = '';
    if (tab.paneHeader) {
      tab.paneHeader.hidden = !layout;
      tab.paneLabel.textContent = tabTitle(tab);
      tab.paneLabel.title = tabTitle(tab);
    }
  }
  if (!layout) return;
  const grips = new Map();
  const geometry = () => layoutState.treeRects(layout.tree, { x: 0, y: 0, width: container.clientWidth, height: container.clientHeight });
  const place = (element, rect) => Object.assign(element.style, {
    left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto'
  });
  const resize = () => {
    if (splitLayout !== layout) return;
    const rectangles = geometry();
    for (const [id, rect] of rectangles.panes) place(tabs.get(id).view, rect);
    for (const { node: item, grip } of rectangles.splits) {
      place(grips.get(item), grip);
      grips.get(item).setAttribute('aria-valuenow', String(Math.round(item.ratio)));
    }
  };
  for (const { node: item } of geometry().splits) {
    const column = item.axis === 'column';
    const grip = node('div', 'split-grip');
    grips.set(item, grip);
    grip.dataset.axis = item.axis;
    grip.tabIndex = 0;
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', column ? '调整分屏宽度' : '调整分屏高度');
    grip.setAttribute('aria-orientation', column ? 'vertical' : 'horizontal');
    grip.setAttribute('aria-valuemin', '20');
    grip.setAttribute('aria-valuemax', '80');
    grip.title = '拖动调整尺寸，双击恢复均分';
    const change = value => {
      if (splitLayout !== layout) return;
      item.ratio = Math.max(20, Math.min(80, value));
      resize();
    };
    grip.addEventListener('keydown', event => {
      if ([column ? 'ArrowLeft' : 'ArrowUp', column ? 'ArrowRight' : 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        change(item.ratio + (event.key === (column ? 'ArrowLeft' : 'ArrowUp') ? -5 : 5));
      }
    });
    grip.addEventListener('dblclick', () => change(50));
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      const { bounds } = geometry().splits.find(entry => entry.node === item);
      const start = column ? event.clientX : event.clientY, initial = item.ratio;
      const length = Math.max(1, (column ? bounds.width : bounds.height) - 9);
      const move = pointer => {
        if (pointer.pointerId !== event.pointerId) return;
        if (!(pointer.buttons & 1)) { end(); return; }
        change(initial + 100 * ((column ? pointer.clientX : pointer.clientY) - start) / length);
      };
      const end = pointer => {
        if (pointer?.pointerId !== undefined && pointer.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        grip.removeEventListener('lostpointercapture', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
      grip.addEventListener('lostpointercapture', end);
    });
    container.append(grip);
    if (column && !splitGrip) splitGrip = grip;
    if (!column && !splitRowGrip) splitRowGrip = grip;
  }
  resizeSplitLayout = resize;
  resize();
}

const tabDropPreview = node('div', 'tab-drop-preview');
const tabDragGhost = node('div', 'tab-drag-ghost', chromeIcon('terminal'), node('span', 'text-ellipsis'));
const tabInsertMarker = node('div', 'tab-insert-marker');
const tabDropPlaceholder = node('div', 'tab-drop-placeholder', chromeIcon('terminal'), node('span', 'text-ellipsis'));
tabDropPlaceholder.setAttribute('role', 'status');
tabDropPlaceholder.setAttribute('aria-live', 'polite');
for (const element of [tabDropPreview, tabDragGhost, tabInsertMarker]) { element.hidden = true; document.body.append(element); }
tabDropPreview.setAttribute('role', 'status');
tabDropPreview.setAttribute('aria-live', 'polite');
tabDragGhost.setAttribute('aria-hidden', 'true');
new ResizeObserver(() => { resizeSplitLayout(); if (tabDrag?.started) updateTabDrag(); }).observe($('terminal-views'));

function dragBlocked() {
  return vaultStatus.locked || dialog.open || fileEditor.open || $('key-dialog').open || $('session-switcher').open || workspace.inert;
}

function clearTabHover() {
  clearTimeout(tabHoverTimer); tabHoverTimer = undefined; tabHoverKey = undefined;
}

function cancelTabDrag() {
  if (tabDrag?.started) {
    suppressTabClickUntil = performance.now() + 250;
    cancelledTabPointer = tabDrag.pointerId;
  }
  const previous = tabDrag;
  tabDrag = undefined;
  cancelAnimationFrame(tabDragFrame); tabDragFrame = undefined;
  clearTabHover();
  document.body.classList.remove('tab-drag-active');
  previous?.source.classList.remove('tab-dragging');
  if (previous?.kind === 'pane') tabs.get(previous.id)?.view.classList.remove('drag-source-pane');
  if (previous && document.body.hasPointerCapture(previous.pointerId)) document.body.releasePointerCapture(previous.pointerId);
  for (const element of [tabDropPreview, tabDragGhost, tabInsertMarker]) element.hidden = true;
  tabDropPlaceholder.remove();
}

function tabDropAt(x, y, drag) {
  const hit = document.elementFromPoint(x, y);
  const bar = document.querySelector('.titlebar').getBoundingClientRect();
  if (x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom) {
    if (hit?.closest('.tab-drop-placeholder') && drag.barDrop) return drag.barDrop;
    const strip = $('tabs');
    const entries = workspaceEntries().filter(entry => drag.kind === 'pane' || entry.key !== drag.workspaceKey);
    const before = entries.find(entry => x < entry.tab.tabRow.getBoundingClientRect().left + entry.tab.tabRow.getBoundingClientRect().width / 2);
    const rect = before?.tab.tabRow.getBoundingClientRect() || entries.at(-1)?.tab.tabRow.getBoundingClientRect() || strip.getBoundingClientRect();
    const hoveredId = hit?.closest('.tab')?.dataset.tabId;
    const hover = workspaceEntryFor(hoveredId);
    return { type: drag.kind === 'pane' && splitGroupFor(drag.id) ? 'detach' : 'reorder',
      before: before?.key, beforeId: before?.panes.find(id => !drag.panes.includes(id)), hover,
      x: before ? rect.left : rect.right, y: rect.top, height: rect.height };
  }
  const source = tabs.get(drag.id), view = hit?.closest('.terminal-view');
  const target = [...tabs.values()].find(tab => tab.view === view);
  if (source?.kind !== 'shell' || !target || target.kind !== 'shell' || drag.panes.includes(target.id) || target.view.hidden ||
      drag.panes.some(id => !tabs.has(id) || tabs.get(id).closing) || target.closing) return;
  const bounds = view.getBoundingClientRect();
  const edge = layoutState.dropEdge({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, x, y);
  if (!edge) return;
  const group = splitGroupFor(target.id), tree = group?.tree || layoutState.pane(target.id);
  const candidate = layoutState.moveTree(tree, drag.tree, target.id, edge);
  const root = $('terminal-views').getBoundingClientRect(), minimum = layoutState.minimumSize(candidate);
  if (candidate === tree) return;
  const reason = minimum.width > root.width || minimum.height > root.height ? '空间不足，请放大窗口或调整分屏' : '';
  // Anchor feedback to the pane currently under the pointer. Removing a source
  // from this same tree may collapse ancestors, but must not move the preview.
  const rect = reason ? bounds : layoutState.dropPreviewRect(bounds, edge);
  return { type: 'split', tree: candidate, group, target: target.id, edge, rect, reason };
}

function updateTabHover(drop) {
  const entry = drop?.hover;
  if (!entry || entry.key === tabDrag?.workspaceKey || entry.panes.includes(active?.id)) { clearTabHover(); return; }
  if (tabHoverKey === entry.key) return;
  clearTabHover(); tabHoverKey = entry.key;
  const gesture = tabDrag;
  tabHoverTimer = setTimeout(() => {
    if (tabDrag !== gesture || !tabDrag?.started || !tabs.has(entry.representativeId)) return;
    selectTab(workspaceFocus(entry), undefined, { keepDrag: true });
    updateTabDrag();
  }, 400);
}

function updateTabDrag() {
  if (!tabDrag?.started) return;
  if (dragBlocked() || tabDrag.panes.some(id => !tabs.has(id))) { cancelTabDrag(); return; }
  const { x, y } = tabDrag, drop = tabDropAt(x, y, tabDrag);
  updateTabHover(drop);
  tabDragGhost.hidden = false;
  tabDropPreview.hidden = drop?.type !== 'split';
  const overBar = ['reorder', 'detach'].includes(drop?.type);
  tabDragGhost.classList.toggle('in-tab-bar', overBar);
  tabInsertMarker.hidden = !overBar || drop.type === 'detach';
  if (drop?.type === 'detach') {
    tabDrag.barDrop = drop;
    tabDropPlaceholder.lastChild.textContent = tabDrag.title;
    tabDropPlaceholder.setAttribute('aria-label', `松手恢复为独立标签：${tabDrag.title}`);
    const before = workspaceEntries().find(entry => entry.key === drop.before)?.tab.tabRow;
    const strip = $('tabs');
    if (tabDropPlaceholder.parentNode !== strip || tabDropPlaceholder.nextElementSibling !== (before || null)) strip.insertBefore(tabDropPlaceholder, before || null);
  } else { tabDropPlaceholder.remove(); tabDrag.barDrop = undefined; }
  const bar = document.querySelector('.titlebar').getBoundingClientRect();
  tabDragGhost.style.left = `${Math.max(0, Math.min(innerWidth - tabDragGhost.offsetWidth, overBar ? x - 32 : x + 12))}px`;
  tabDragGhost.style.top = `${overBar ? bar.top + (bar.height - 30) / 2 : Math.max(0, Math.min(innerHeight - 36, y + 14))}px`;
  if (drop?.type === 'split') {
    const rect = drop.rect;
    Object.assign(tabDropPreview.style, { left: `${rect.x + 5}px`, top: `${rect.y + 5}px`, width: `${Math.max(0, rect.width - 10)}px`, height: `${Math.max(0, rect.height - 10)}px` });
    const label = drop.reason || `松手放到${({ left: '左侧', right: '右侧', top: '上方', bottom: '下方' })[drop.edge]}`;
    tabDropPreview.setAttribute('aria-label', label);
    if (tabDropPreview.textContent !== (drop.reason || '')) tabDropPreview.textContent = drop.reason || '';
    tabDropPreview.dataset.disabled = String(Boolean(drop.reason));
  } else if (['reorder', 'detach'].includes(drop?.type)) {
    Object.assign(tabInsertMarker.style, { left: `${drop.x}px`, top: `${drop.y}px`, height: `${drop.height}px` });
  }
}

function scrollDraggedTabs() {
  tabDragFrame = undefined;
  if (!tabDrag?.started) return;
  const strip = $('tabs'), rect = strip.getBoundingClientRect();
  if (tabDrag.y >= rect.top && tabDrag.y <= rect.bottom && tabDrag.x >= rect.left && tabDrag.x <= rect.right) {
    const step = tabDrag.x < rect.left + 30 ? -8 : tabDrag.x > rect.right - 30 ? 8 : 0;
    if (step) { strip.scrollLeft += step; updateTabEdges(); updateTabDrag(); }
  }
  tabDragFrame = requestAnimationFrame(scrollDraggedTabs);
}

function wireTabDrag(row, tab, options = {}) {
  row.dataset.tabId = tab.id;
  if (options.pane) row.dataset.dragPaneId = tab.id;
  row.draggable = false;
  row.addEventListener('mousedown', event => {
    if (options.pane && event.target.closest('button')) return;
    event.preventDefault(); event.stopPropagation();
  });
  row.addEventListener('dragstart', event => event.preventDefault());
  row.addEventListener('click', event => {
    if (performance.now() < suppressTabClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  row.addEventListener('pointerdown', event => {
    if (event.button !== 0 || dragBlocked()) return;
    cancelTabDrag(); cancelledTabPointer = undefined; suppressTabClickUntil = 0;
    if (event.target.closest(options.pane ? 'button' : '.tab-close')) return;
    const entry = workspaceEntryFor(tab.id), group = entry?.group;
    const tree = !options.pane && group ? group.tree : layoutState.pane(tab.id);
    tabDrag = { id: !options.pane && group ? workspaceFocus(entry).id : tab.id, kind: options.pane ? 'pane' : group ? 'group' : 'tab',
      tree, panes: layoutState.paneIds(tree), workspaceKey: entry?.key, title: options.pane ? tabTitle(tab) : workspaceTitle(entry),
      pointerId: event.pointerId, source: row, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
  });
}

function moveTabDrag(event) {
  if (!tabDrag || (event.pointerId !== undefined && event.pointerId !== tabDrag.pointerId)) return;
  if (dragBlocked()) { cancelTabDrag(); return; }
  tabDrag.x = event.clientX; tabDrag.y = event.clientY;
  if (!tabDrag.started) {
    if (Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY) < 6) return;
    tabDrag.started = true;
    tabDrag.source.classList.add('tab-dragging');
    document.body.classList.add('tab-drag-active');
    window.getSelection()?.removeAllRanges();
    tabDragGhost.lastChild.textContent = tabDrag.title;
    if (tabDrag.kind === 'pane') tabs.get(tabDrag.id).view.classList.add('drag-source-pane');
    tabDragFrame = requestAnimationFrame(scrollDraggedTabs);
  }
  // WKWebView can omit button masks and pointerup; explicit down/up own the gesture.
  try { if (!document.body.hasPointerCapture(tabDrag.pointerId)) document.body.setPointerCapture(tabDrag.pointerId); } catch { /* Optional capture. */ }
  event.preventDefault(); event.stopImmediatePropagation(); updateTabDrag();
}
window.addEventListener('pointermove', moveTabDrag, true);
window.addEventListener('mousemove', moveTabDrag, true);
function finishTabDrag(event) {
  if (event.type === 'mouseup' && event.button !== 0) return;
  const pointerId = event.pointerId ?? tabDrag?.pointerId ?? cancelledTabPointer;
  if (pointerId !== undefined && cancelledTabPointer === pointerId) { suppressTabClickUntil = performance.now() + 250; cancelledTabPointer = undefined; }
  if (!tabDrag || pointerId !== tabDrag.pointerId) return;
  if (tabDrag.started) { event.preventDefault(); event.stopPropagation(); }
  const moving = tabDrag.id, payload = tabDrag;
  const drop = tabDrag.started && !dragBlocked() ? tabDropAt(event.clientX, event.clientY, tabDrag) : undefined;
  cancelTabDrag(); cancelledTabPointer = undefined;
  if (drop?.type === 'detach') {
    removeSplitPane(moving);
    reorderWorkspaceSessions([moving], drop.before, drop.beforeId);
    selectTab(tabs.get(moving));
  } else if (drop?.type === 'reorder') {
    reorderWorkspaceSessions(payload.panes, drop.before, drop.beforeId);
  } else if (drop?.type === 'split' && !drop.reason) {
    splitLayout = installSplitLayout(splitFromTree(drop.tree, drop.group));
    selectTab(tabs.get(moving));
  }
}
window.addEventListener('pointerup', finishTabDrag, true);
window.addEventListener('mouseup', finishTabDrag, true);
window.addEventListener('pointercancel', cancelTabDrag);
window.addEventListener('blur', cancelTabDrag);
window.addEventListener('resize', cancelTabDrag);
window.addEventListener('keydown', event => {
  if (!tabDrag) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelTabDrag(); }
  else if (tabDrag.started) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);

function sessionLayoutSummary(layout) {
  if (layout.split?.version === 2) return `${layout.tabs.length} 个会话 · 自定义分屏`;
  const split = layout.split.length >= 2;
  if (layout.direction === 'grid' && split) {
    return `${layout.tabs.length} 个会话 · 四宫格 · 列宽 ${layout.ratio}% / ${100 - layout.ratio}% · 行高 ${layout.rowRatio ?? 50}% / ${100 - (layout.rowRatio ?? 50)}%`;
  }
  return `${layout.tabs.length} 个会话${split ? ` · ${layout.direction === 'vertical' ? '上下' : '左右'}分屏 · ${layout.ratio}% / ${100 - layout.ratio}%` : ''}`;
}

async function saveSessionLayout() {
  const visible = visibleSplitLayout();
  if (!visible) throw new Error('请先拖拽会话形成分屏工作区，再保存布局。');
  const sessions = visible.panes.map(id => tabs.get(id));
  const layout = {
    tabs: sessions.map(tab => ({ hostId: tab.host.id, title: tab.title || '' })),
    split: { version: 2, root: layoutState.serializeTree(visible.tree, sessions.map(tab => tab.id)) },
    direction: 'tree',
    ratio: 50
  };
  const name = input('');
  name.required = true;
  name.maxLength = 120;
  name.placeholder = '例如：应用与数据库';
  const saved = await prompt('保存会话布局', [
    node('p', 'muted', `保存当前分屏中的会话、排列和尺寸。以后可按 ${keyboard.label('K')} 搜索布局名称直接打开。`),
    field('布局名称', name),
    node('p', 'muted', sessionLayoutSummary(layout)),
    node('ul', 'layout-hosts', ...sessions.map(tab => node('li', '', tab.title || tab.host.name)))
  ], '保存布局', () => api.layouts.save({ layout: { ...layout, name: name.value.trim() } }));
  if (saved) status(`已保存会话布局「${name.value.trim()}」，按 ${keyboard.label('K')} 搜索名称即可打开。`);
}

let openingSessionLayout = false;
async function openSessionLayout(saved) {
  if (openingSessionLayout) return;
  openingSessionLayout = true;
  const created = [];
  const previous = active;
  const previousView = workspace.dataset.view;
  const previousSplit = splitLayout;
  try {
    const layouts = await api.layouts.list();
    const layout = layouts.find(item => item.id === saved.id);
    if (!layout) throw new Error('这个会话布局已删除，请重新查找。');
    await refreshHosts();
    if (vaultStatus.locked) return;
    const targets = layout.tabs.map(tab => hosts.find(host => host.id === tab.hostId));
    const missing = targets.filter(host => !host).length;
    if (missing) throw new Error(`此会话布局中的 ${missing} 个主机已删除，请重新保存布局。`);
    layoutState.layoutTree(layout, layout.tabs.map((_, index) => String(index)));
    for (let index = 0; index < layout.tabs.length; index++) {
      if (vaultStatus.locked) throw new Error('请先解锁 Termlume 后再打开会话布局。');
      const tab = await openHost(targets[index], { force: true, connectNow: false });
      created.push(tab);
      tab.title = layout.tabs[index].title;
    }
    const tree = layoutState.layoutTree(layout, created.map(tab => tab.id));
    splitLayout = (layout.split?.version === 2 || layout.split.length >= 2) ? installSplitLayout(splitFromTree(tree)) : undefined;
    selectTab(tabs.get(splitLayout?.panes[0]) || created[0]);
    status(`已打开会话布局「${layout.name}」，点击各标签的「连接」即可开始。`);
  } catch (error) {
    for (const tab of created) removeTab(tab);
    splitLayout = previousSplit;
    if (previous && tabs.has(previous.id)) selectTab(previous);
    else if (!vaultStatus.locked) selectTab(undefined, previousView);
    throw error;
  } finally {
    openingSessionLayout = false;
  }
}

async function manageLayouts(page) {
  if (!page) return openSettings('layouts');
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);
  while (page.active && !vaultStatus.locked) {
    const layouts = await api.layouts.list();
    let choice;
    const rows = layouts.map(layout => node('section', 'forward-rule',
      node('strong', '', layout.name), node('p', 'muted', sessionLayoutSummary(layout)),
      node('p', 'muted', layout.tabs.map(tab => tab.title || hosts.find(host => host.id === tab.hostId)?.name || '已删除的主机').join('、')),
      node('div', 'forward-actions',
        button('重命名', () => { choice = { rename: layout }; close(); }, 'outlined'),
        button('删除', () => { choice = { remove: layout }; close(); }, 'outlined danger'))));
    await ask('会话布局', [
      node('p', 'muted', `管理已保存的会话和分屏排列。在分屏工作区的标签上点「保存布局」图标创建，按 ${keyboard.label('K')} 搜索布局名称打开。`),
      ...(rows.length ? rows : [node('p', 'muted', '还没有会话布局。先拖拽会话形成分屏，再点工作区标签上的「保存布局」图标。')])
    ], '关闭', () => true);
    if (!choice) break;
    if (choice.remove) {
      const layout = choice.remove;
      if (await confirm('删除会话布局', `删除「${layout.name}」？`, '删除')) {
        await api.layouts.remove({ layout, expected: layout });
      }
    } else {
      const layout = choice.rename;
      const name = input(layout.name);
      name.required = true;
      name.maxLength = 120;
      await ask('重命名会话布局', [field('布局名称', name)], '保存名称',
        () => api.layouts.save({ layout: { ...layout, name: name.value.trim() }, expected: layout }));
    }
  }
}

async function manageSnippets(session, page) {
  if (!page) return openSettings('snippets', session);
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);

  const attempt = session?.attempts;
  let query = '';
  while (page.active && !vaultStatus.locked) {
    let snippets = commandLibrary.sorted(await api.snippets.list());
    if (!page.active) return;
    let choice;
    const pick = value => { choice = value; close(); };
    const search = input(query, 'search');
    search.placeholder = '搜索名称、标签和命令';
    search.setAttribute('aria-label', '搜索命令库');
    const create = button('新建命令', () => pick({ create: true }), 'primary');
    const list = node('div', 'command-library-grid');
    const help = node('p', 'muted command-library-help');
    let savingOrder = false;
    const saveOrder = async (ids, movedId) => {
      if (savingOrder || !page.active || vaultStatus.locked || search.value.trim()) return;
      if (ids.every((id, index) => id === snippets[index].id)) return;
      savingOrder = create.disabled = list.inert = true;
      list.setAttribute('aria-busy', 'true');
      try {
        snippets = commandLibrary.sorted(await api.snippets.reorder({ ids, expected: snippets }));
        if (page.active) status('已保存命令顺序。');
      } catch (error) {
        await api.snippets.list().then(current => { snippets = commandLibrary.sorted(current); }).catch(() => {});
        if (page.active) status(message(error));
      } finally {
        savingOrder = create.disabled = list.inert = false;
        list.removeAttribute('aria-busy');
        if (page.active) {
          const restoreFocus = document.activeElement === document.body || list.contains(document.activeElement);
          render();
          if (restoreFocus) [...list.children].find(card => card.dataset.orderId === movedId)
            ?.querySelector('.order-handle')?.focus({ preventScroll: true });
        }
      }
    };
    const render = () => {
      if (orderDrag && list.contains(orderDrag.source)) cancelOrderDrag();
      if (hostMenu && list.contains(hostMenu.anchor)) closeHostMenu();
      query = search.value;
      const filtered = Boolean(query.trim());
      help.textContent = filtered ? '清除搜索后可拖动排序。' : '拖动卡片手柄可调整顺序。';
      const visible = snippets.filter(s => matchesQuery(query, s.name, s.command, s.tags));
      const ids = snippets.map(s => s.id);
      list.replaceChildren(...visible.map(s => {
        const pin = button(s.pinned ? '★ 快捷' : '☆ 设为快捷', () => pick({ pin: s }), 'outlined command-pin', `${s.pinned ? '取消快捷' : '设为快捷'} ${s.name}`);
        pin.setAttribute('aria-pressed', String(Boolean(s.pinned)));
        const heading = node('div', 'command-library-heading', node('strong', '', s.name),
          ...(s.builtin ? [node('span', 'command-badge', '内置')] : []));
        const actions = node('div', 'command-library-actions', pin,
          button('编辑', () => pick({ snippet: s }), 'outlined', `编辑 ${s.name}`),
          button(s.builtin ? '恢复默认' : '删除', () => pick({ remove: s }), 'outlined', `${s.builtin ? '恢复默认' : '删除'} ${s.name}`));
        if (readySession(session, attempt)) {
          if (!/[\r\n]/.test(s.command)) actions.append(button('填入终端', () => pick({ use: s }), 'outlined', `填入终端 ${s.name}`));
          actions.append(button('独立执行', () => pick({ run: s }), 'outlined', `独立执行 ${s.name}`));
        }
        const card = node('section', 'command-library-card', heading, node('code', 'command-library-code', s.command), actions);
        card.dataset.orderId = s.id;
        if (api.snippets.reorder) {
          const index = ids.indexOf(s.id);
          const move = delta => {
            const target = index + delta;
            if (target < 0 || target >= ids.length) return;
            const ordered = ids.slice();
            [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
            return saveOrder(ordered, s.id);
          };
          const handle = button('⠿', () => {
            const up = button('上移', () => move(-1)); up.disabled = index === 0;
            const down = button('下移', () => move(1)); down.disabled = index === ids.length - 1;
            showActionMenu(`调整${s.name}的顺序`, handle, [up, down]);
          }, 'order-handle', `调整命令顺序 ${s.name}`);
          handle.title = filtered ? help.textContent : '拖动调整顺序；Alt + ↑ / ↓ 移动';
          handle.disabled = filtered || savingOrder || ids.length < 2;
          handle.setAttribute('aria-haspopup', 'menu');
          handle.setAttribute('aria-expanded', 'false');
          handle.addEventListener('keydown', event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            void move(event.key === 'ArrowUp' ? -1 : 1);
          });
          wireOrderDrag(handle, () => ({
            source: card, ids, name: s.name, scrollArea: list.closest('.settings-fields'),
            horizontal: getComputedStyle(list).gridTemplateColumns.split(' ').length > 1,
            isTarget: hit => hit.parentElement === list,
            save: ordered => saveOrder(ordered, s.id)
          }));
          heading.prepend(handle);
        }
        return card;
      }));
      if (!visible.length) list.append(node('p', 'muted command-library-empty', '没有匹配的命令。'));
    };
    search.addEventListener('input', render); render();
    const toolbar = node('div', 'settings-list-toolbar', search, create);
    await ask('命令库', [toolbar, help, list], '关闭', () => true);
    if (!choice) break;
    if (choice.use) { await useLibraryCommand(session, choice.use, undefined, attempt); return; }
    if (choice.run) { await useLibraryCommand(session, choice.run, false, attempt); return; }
    if (choice.pin) {
      await api.snippets.save({ snippet: { ...choice.pin, pinned: !choice.pin.pinned }, expected: choice.pin });
      continue;
    }
    if (choice.remove) {
      const s = choice.remove;
      if (await confirm(s.builtin ? '恢复内置命令' : '删除命令', s.builtin ? `将「${s.name}」的内容、快捷状态和顺序恢复为默认值？` : `删除「${s.name}」？`, s.builtin ? '恢复默认' : '删除')) {
        await api.snippets.remove({ snippet: s, expected: s });
      }
      continue;
    }
    const s = choice.snippet, name = input(s?.name), tags = input(s?.tags.join(', ') || '');
    name.required = true; name.maxLength = 120;
    const command = node('textarea'); command.rows = 7; command.value = s?.command || ''; command.required = true;
    const pinned = node('input'); pinned.type = 'checkbox'; pinned.checked = s ? Boolean(s.pinned) : true;
    await ask(s ? '编辑命令' : '新建命令', [field('名称', name), field('命令文本', command),
      node('p', 'muted', '可使用 {{path}}、{{service}}、{{lines}}，使用时填写日志路径、服务名和行数。路径与服务名会自动转义。'),
      field('标签（逗号分隔）', tags), node('label', 'checkbox-row', pinned, '设为顶部快捷按钮')], '保存命令', () =>
      api.snippets.save({ snippet: { ...s, name: name.value, command: command.value,
        tags: tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean), pinned: pinned.checked,
        order: s?.order ?? Math.max(0, ...snippets.map(item => item.order || 0)) + 10 }, expected: s }));
  }
}

async function useSnippet(session, snippet, paste = false, attempt = session?.attempts, parameters) {
  if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择目标。');
  const command = parameters ? commandLibrary.render(snippet.command, parameters) : snippet.command;
  if (paste) {
    if (/[\r\n]/.test(command)) throw new Error('多行命令请使用执行预览。');
    fillTerminalCommand(session, command, attempt);
    return;
  }
  if (!await confirm('执行保存的命令', `${session.host.name} · ${endpoint(session.host)}\n以当前 SSH 用户在独立命令通道执行：\n${command}`, '执行')) return;
  if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择目标。');
  const tab = {id: sessionId(), kind: 'command', sessionId: session.id, host: session.host, action: 'custom', status: 'connecting'};
  attachTerminal(tab); tabs.set(tab.id, tab); selectTab(tab);
  try { await api.snippets.run({id: tab.id, sessionId: session.id, snippetId: snippet.id, expected: snippet, parameters}); }
  catch (error) { updateSession(tab, 'failed', message(error)); }
}

async function manageGroups(page) {
  if (!page) return openSettings('groups');
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);

  if(!api.groups) return;
  let query = '';
  while(page.active && !vaultStatus.locked) {
    groupAssets=await api.groups.list();let choice;
    const search = input(query, 'search');
    search.placeholder = '搜索分组名称或路径';
    search.setAttribute('aria-label', '搜索分组');
    const list = node('div', 'settings-collection');
    const render = () => {
      query = search.value;
      const source = window.hostTree.build(groupAssets, []);
      const filtered = query.trim() ? window.hostTree.filter(source, () => false, group => matchesQuery(query, group.path)) : source;
      const tree = groupTree(filtered, new Set(groupAssets.filter(g => query.trim() || !collapsedSettingsGroups.has(g.id)).map(g => g.id)), {
        label: '分组管理',
        detail: branch => `${branch.group.hosts?.length ?? branch.count} 台主机 · 端口 ${branch.group.port || '继承 / 22'} · ${branch.group.identityId ? '已设登录配置' : '继承上级登录配置'}`,
        onToggle: (branch, expanded) => expanded ? collapsedSettingsGroups.delete(branch.group.id) : collapsedSettingsGroups.add(branch.group.id),
        actions: g => node('div', 'group-tree-actions',
          button('添加子组', () => { choice = { parent: g }; close(); }, 'outlined', `给 ${g.path} 添加子组`),
          button('编辑', () => { choice = { group: g }; close(); }, 'outlined', `编辑分组 ${g.path}`),
          button('删除', () => { choice = { remove: g }; close(); }, 'outlined danger', `删除分组 ${g.path}`))
      });
      list.replaceChildren(filtered.groups.length ? tree : node('p', 'muted', query.trim() ? '没有匹配的分组。' : '可创建空分组、嵌套分组与默认 SSH 设置。'));
    };
    search.addEventListener('input', render); render();
    await ask('分组管理',[search,list],'关闭',()=>true,[button('新建分组',()=>{choice={create:true};close();},'primary')]);
    if(!choice) break;
    if (choice.remove) { await deleteHostGroup(choice.remove); continue; }
    await editGroup(choice.group, choice.parent, page);
  }
  await refreshHosts();
}

async function editGroup(group, parentGroup, page, options = {}) {
  const name = input(group?.name || options.name);
  name.required = true; name.maxLength = 120;
  const parent = node('select');
  const excluded = group ? window.hostTree.descendants(groupAssets, group.id) : new Set();
  parent.append(new Option('无上级分组', ''), ...groupAssets.filter(item => !excluded.has(item.id)).map(item => new Option(item.path, item.id)));
  parent.value = group?.parentId || parentGroup?.id || '';
  const port = input(group?.port || '', 'number'); port.min = 1; port.max = 65535;
  const identities = api.identities ? await api.identities.list() : [];
  const identity = node('select');
  identity.append(new Option('继承上级 / 未设置', ''), ...identities.map(identityChoiceOption));
  identity.value = group?.identityId || '';
  const theme = node('select');
  for (const [value, label] of [['', '继承 / 终端偏好'], ['dark', '深色'], ['light', '浅色']]) theme.append(new Option(label, value));
  theme.value = group?.terminalTheme || '';
  const snapshot = () => JSON.stringify([name.value, parent.value, port.value, identity.value, theme.value]);
  const original = snapshot();
  const ask = page ? settingsAsk(page) : prompt;
  return ask(group ? '编辑分组' : parentGroup ? '添加子组' : '新建分组', [
    node('section', 'host-form-section',
      node('p', 'muted', group ? `影响 ${group.hosts?.length || 0} 台主机（含子分组），仅启用继承的主机使用默认值。` : '设置分组名称，可选择上级分组及默认连接配置。'),
      field('分组名称', name), field('上级分组', selectControl(parent, '上级分组', { searchable: true, placeholder: '搜索分组名称或路径' }))),
    node('section', 'host-form-section', node('h3', '', '默认连接配置'),
      field('默认 SSH 端口（留空继承）', port), field('默认登录配置', identitySelectControl(identity, '分组登录配置')),
      node('p', 'muted', '组内主机勾选「使用分组的登录配置」后，会复用此处选择的 SSH 用户名和认证方式。'),
      field('默认终端配色', selectControl(theme, '分组终端配色')))
  ], options.submitLabel || '保存分组', async () => {
    const result = await api.groups.save({ group: { id: group?.id, name: name.value, parentId: parent.value || undefined,
      port: port.value ? Number(port.value) : undefined, identityId: identity.value || undefined, terminalTheme: theme.value || undefined }, expected: group });
    groupAssets = result.groups; hosts = result.hosts;
    if (parent.value) collapsedSettingsGroups.delete(parent.value);
    renderHosts();
    return groupAssets.find(item => group ? item.id === group.id : item.name === name.value.trim() && (item.parentId || '') === parent.value);
  }, [], { ...(!page ? { drawer: true, closeLabel: '关闭分组表单',
    canClose: () => snapshot() === original || confirmDiscardHostChanges('分组配置') } : {}), ...options });
}

const identityPurpose = '登录配置保存 SSH 用户名和认证方式，可给多台主机复用。在主机的「更多设置 → 登录配置」中选择，也可在「分组管理」中设为默认登录配置。';
const identityAuthLabels = { agent: 'SSH Agent', key: '本机私钥', password: 'SSH 密码' };

async function editIdentity(identity, sourceHost, page, identities = []) {
  const ask = page ? settingsAsk(page) : prompt;
  const name = input(identity?.name);
  name.maxLength = 120;
  const user = input(identity?.username || sourceHost?.username);
  user.required = true;
  user.maxLength = 120;
  user.spellcheck = false;
  user.autocapitalize = 'none';
  const usernames = [...new Set([...hosts, ...identities].map(item => item.username).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  user.placeholder = usernames.length ? '选择已有用户名，或输入新用户名' : '输入 SSH 用户名';
  const userPicker = usernames.length ? editableControl(user, 'SSH 用户名', (query = '') =>
    usernames.filter(username => username.toLowerCase().includes(query.toLowerCase()))
      .map(username => ({ label: username, value: username }))) : user;

  const auth = node('select');
  for (const [value, label] of Object.entries(identityAuthLabels)) auth.append(new Option(label, value));
  auth.value = identity?.auth || sourceHost?.auth || 'agent';
  const authPicker = selectControl(auth, '认证方式');
  let keyPath = identity?.keyPath || sourceHost?.keyPath || '';
  const keyNameView = node('span', 'selected-key-name');
  keyNameView.setAttribute('aria-live', 'polite');
  const selectKey = button('选择私钥', () => manageKeys(setKey, keyPath), 'outlined');
  const keyPane = node('div', 'credential-pane', node('strong', '', '私钥'),
    node('div', 'identity-key-selection', keyNameView, node('div', 'settings-actions', selectKey,
      ...(api.hosts.pickKey ? [button('浏览文件', async () => {
        const path = await api.hosts.pickKey();
        if (path) setKey(path);
      }, 'outlined')] : []))),
    node('small', 'muted', '选择已有私钥。私钥文件保存在本机。'));
  function setKey(path) {
    keyPath = path;
    update();
  }

  const password = input('', 'password');
  password.autocomplete = 'new-password';
  const share = input('', 'checkbox');
  const clear = input('', 'checkbox');
  const copy = input('', 'checkbox');
  const canCopy = sourceHost?.auth === 'password' && await api.hosts.hasPassword(sourceHost.id);
  const copyField = node('label', 'checkbox-row', copy, '沿用这台主机已保存的密码');
  const clearField = node('label', 'checkbox-row', clear, '清除此登录配置已保存的密码');
  const shareField = node('label', 'checkbox-row', share, '加入加密备份和 Git 同步');
  const passwordHint = node('small', 'muted');
  const passwordPane = node('div', 'credential-pane', copyField, field('SSH 密码（可选）', password),
    passwordHint, clearField, shareField);
  const agentHint = node('p', 'muted', '连接时使用本机 SSH Agent 已加载的密钥。');
  const suggestedName = () => {
    const username = user.value.trim();
    if (!username) return '';
    const suffix = auth.value === 'key' ? keyName(keyPath) || identityAuthLabels.key : identityAuthLabels[auth.value];
    const suggestion = sourceHost ? `${sourceHost.name} 登录配置` : `${username} · ${suffix}`;
    return suggestion.length <= 120 ? suggestion : username;
  };
  function update() {
    const username = user.value.trim();
    const isPassword = auth.value === 'password';
    const hasSaved = isPassword && identity?.passwordSaved && username === identity.username;
    const canCopyHere = isPassword && canCopy && username === sourceHost.username;
    name.placeholder = suggestedName() || '留空则按登录配置生成';
    agentHint.hidden = auth.value !== 'agent';
    keyPane.hidden = auth.value !== 'key';
    keyNameView.textContent = keyName(keyPath) || '尚未选择私钥';
    keyNameView.title = keyPath;
    passwordPane.hidden = !isPassword;
    copyField.hidden = !canCopyHere;
    clearField.hidden = !hasSaved;
    if (!canCopyHere) copy.checked = false;
    if (!hasSaved) clear.checked = false;
    password.disabled = copy.checked || clear.checked;
    if (!isPassword || password.disabled) password.value = '';
    shareField.hidden = !vaultStatus.enabled;
    share.disabled = !isPassword || !(copy.checked || password.value);
    if (share.disabled || shareField.hidden) share.checked = false;
    passwordHint.textContent = hasSaved ? '留空保留已保存的密码。新密码默认只保存在本机。'
      : '默认只保存在本机。留空可在连接时输入密码。';
  }
  for (const element of [auth, user, copy, clear, password]) {
    element.addEventListener('change', update);
    element.addEventListener('input', update);
  }

  const fields = [];
  if (!identity && !sourceHost && hosts.length) {
    const candidates = [...hosts];
    const source = node('select');
    source.append(new Option('新配置', ''));
    for (const host of candidates) source.append(hostChoiceOption(host, host.id, `${host.name} · ${host.username}`));
    source.addEventListener('change', () => {
      const host = candidates.find(item => item.id === source.value);
      user.value = host?.username || '';
      auth.value = host?.auth || 'agent';
      auth.dispatchEvent(new Event('change'));
      password.value = '';
      share.checked = false;
      setKey(host?.keyPath || '');
    });
    fields.push(field('从已有主机带入（可选）', hostSelectControl(source, '从已有主机带入', candidates)),
      node('small', 'muted', '带入用户名和认证方式。主机原有配置和密码保持独立。'));
  }
  fields.push(field('SSH 用户名', userPicker), field('配置名称（可选）', name));
  const form = node('div', 'identity-form',
    node('p', 'muted', sourceHost
      ? `保存后，「${sourceHost.name}」将使用此登录配置。` : identityPurpose),
    ...(identity ? [node('p', 'muted',
      `当前关联 ${identity.hosts.length} 台主机、${identity.groups?.length || 0} 个分组。更改会应用于后续新连接。`)] : []),
    node('section', 'identity-section', node('h3', '', '基本信息'), ...fields),
    node('section', 'identity-section', node('h3', '', '认证设置'), field('认证方式', authPicker),
      agentHint, keyPane, passwordPane));
  update();
  return ask(identity ? '编辑登录配置' : '新建登录配置', [form],
    sourceHost ? '保存并关联此主机' : '保存登录配置', async () => {
      const usingKey = auth.value === 'key';
      const usingPassword = auth.value === 'password';
      if (usingKey && !keyPath && !(identity?.auth === 'key' && !identity.keyPath)) {
        requestAnimationFrame(() => selectKey.focus());
        throw new Error('请选择要用于此登录配置的私钥。');
      }
      const result = await api.identities.save({
        identity: { id: identity?.id, name: name.value.trim() || suggestedName(), username: user.value.trim(),
          auth: auth.value, keyPath: usingKey ? keyPath || undefined : undefined },
        expected: identity,
        localPassword: usingPassword && password.value ? password.value : undefined,
        sharePassword: usingPassword && share.checked,
        clearPassword: usingPassword && clear.checked,
        copySavedPassword: usingPassword && copy.checked,
        sourceHostId: sourceHost?.id
      });
      if (sourceHost) hosts = await api.hosts.save({ ...sourceHost, identityId: result.identityId });
      else hosts = result.hosts;
      renderHosts();
      return result.identityId;
    }, [], { focus: user });
}

async function manageIdentities(page) {
  if (!page) return openSettings('identities');
  const ask = settingsAsk(page);
  const close = () => finishSettingsPrompt(page);
  if (!api.identities) return;
  let query = '';
  while (page.active && !vaultStatus.locked) {
    const identities = await api.identities.list();
    let choice;
    const search = input(query, 'search');
    search.placeholder = '搜索名称、用户名或认证方式';
    search.setAttribute('aria-label', '搜索登录配置');
    const list = node('div', 'forward-list');
    const render = () => {
      query = search.value;
      const rows = identities.filter(identity => matchesQuery(query, identity.name, identity.username, identityAuthLabels[identity.auth], ...(identity.groups || [])))
        .map(identity => node('section', 'forward-rule',
      node('strong', '', identity.name),
      node('p', 'muted', `${identity.username} · ${identityAuthLabels[identity.auth]} · ${identity.hosts.length} 台主机 · ${identity.groups?.length || 0} 个分组${identity.passwordSaved ? ' · 已保存密码' : ''}`),
      node('div', 'forward-actions',
        button('编辑', () => { choice = { identity }; close(); }, 'outlined'),
        button('删除', () => { choice = { remove: identity }; close(); }, 'outlined danger'))));
      list.replaceChildren(...(rows.length ? rows : [node('p', 'muted', query.trim() ? '没有匹配的登录配置。' : '还没有登录配置。')]));
    };
    search.addEventListener('input', render); render();
    await ask('登录配置', [search, node('p', 'muted identity-intro', identityPurpose), list], '关闭', () => true,
    [button('新建登录配置', () => { choice = {}; close(); }, 'primary')]);
    if (!choice) break;
    if (choice.remove) {
      const item = choice.remove;
      if (item.hosts.length || item.groups?.length) {
        const references = [
          ...(item.hosts.length ? [`主机：${item.hosts.map(host => host.name).join('、')}`] : []),
          ...(item.groups?.length ? [`分组：${item.groups.join('、')}`] : [])
        ];
        await confirm('登录配置仍被引用', `请先解除以下关联。\n${references.join('\n')}`, '知道了');
        continue;
      }
      if (await confirm('删除登录配置', `删除「${item.name}」及其保存的凭据？`, '删除')) {
        await api.identities.remove({ id: item.id, expected: item });
      }
    } else {
      await editIdentity(choice.identity, undefined, page, identities);
    }
  }
  await refreshHosts();
}

async function editHost(host, draftTab, target) {
  if(api.groups) groupAssets=await api.groups.list();
  const identities=api.identities ? await api.identities.list() : [];
  const identity=node('select');
  const own=node('option','','单独配置此主机');own.value='';identity.append(own);
  identity.append(...identities.map(identityChoiceOption));
  if(host?.identityId&&!identities.some(i=>i.id===host.identityId)) {const o=node('option','','登录配置不可用，请重新选择');o.value=host.identityId;identity.append(o);}
  identity.value=host?.identityId||'';const identityPicker=identitySelectControl(identity,'登录配置');
  const identityHint = node('p', 'muted');
  const identityField = field('登录配置', identityPicker);
  const identityHelp = node('p', 'muted', '选择登录配置可复用用户名和认证方式。');
  const hasPassword = !host?.identityId && host?.auth === 'password' && await api.hosts.hasPassword(host.id);
  const hasKeyPassphrase = host?.auth === 'key' && api.hosts.hasKeyPassphrase && await api.hosts.hasKeyPassphrase(host.id);
  const name = input(host?.name);
  const addressField = input(host?.address ?? target?.address);
  const port = input(host?.port || target?.port || '22', 'number');
  port.min = 1; port.max = 65535;
  const username = input(host?.username ?? target?.username);
  const group = node('select');
  const tags = input(host?.tags?.join(', ') || '');
  tags.placeholder = '以逗号分隔';
  const inheritPort=input('','checkbox');inheritPort.checked=Boolean(host?.inheritPort);
  const inheritTheme=input('','checkbox');inheritTheme.checked=Boolean(host?.inheritTheme);
  const terminalTheme=node('select');for(const[value,label]of [['','使用终端偏好'],['dark','深色'],['light','浅色']]){const o=node('option','',label);o.value=value;terminalTheme.append(o);}terminalTheme.value=host?.terminalTheme||'';const terminalThemePicker=selectControl(terminalTheme,'主机终端配色');
  const keepalive=input(host?.keepaliveInterval??15,'number');keepalive.min=0;keepalive.max=300;const timeout=input(host?.connectTimeout??65,'number');timeout.min=5;timeout.max=180;
  const inheritIdentity=input('','checkbox');inheritIdentity.checked=Boolean(host?.inheritIdentity);
  const note = input(host?.note);
  const logPath = input(host?.logPath);
  const service = input(host?.service);
  const startup=node('textarea');startup.value=host?.startupCommand||'';startup.rows=3;
  const reconnect=input('','checkbox');reconnect.checked=Boolean(host?.autoReconnect);
  const autoStartup=input('','checkbox');autoStartup.checked=Boolean(host?.startupEnabled);
  const refreshGroupChoices = (selected = group.value) => {
    const groups = [...new Set([...groupAssets.map(item => item.path), ...hosts.map(item => item.group).filter(Boolean)])]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    group.replaceChildren(new Option('无分组', ''), ...groups.map(path => new Option(path, path)));
    group.value = groups.includes(selected) ? selected : '';
    group.dispatchEvent(new Event('input'));
  };
  refreshGroupChoices(host?.group ?? currentGroup);
  let createGroupRequested = false, newGroupName = '';
  const groupPicker = selectControl(group, '分组', {
    searchable: true, placeholder: '搜索分组名称或路径',
    ...(api.groups ? { action: { label: '新建分组', run: query => {
      createGroupRequested = true; newGroupName = query;
      closePrompt('create-group');
    } } } : {})
  });
  const jump = node('select');
  const routeOptions = [{ id: '', name: '直连' }, ...hosts.filter((item) => item.id !== host?.id && !item.jumpHostId && (api.ssh.jumpHosts || item.id === host?.jumpHostId))];
  if (host?.jumpHostId && !routeOptions.some((item) => item.id === host.jumpHostId)) routeOptions.push({ id: host.jumpHostId, name: '跳板机不可用，请重新选择' });
  for (const item of routeOptions) {
    const option = item.address ? hostChoiceOption(item, item.id, `经 ${item.name}`) : new Option(item.name, item.id);
    option.disabled = Boolean(item.id && !item.address);
    jump.append(option);
  }
  jump.value = host?.jumpHostId || '';
  const jumpPicker = hostSelectControl(jump, '连接路径', routeOptions.filter(item => item.address), { hint: '仅列出可用的直连主机' });
  const routeHint = node('p', 'muted', api.ssh.jumpHosts ? '单跳连接：SSH、文件和日志共用此路径。跳板机须为已保存的直连主机。' : '跳板连接需使用 Termlume 桌面应用。');
  const auth = node('select');
  for (const [value, label] of [['', '请选择认证方式'], ['agent', 'SSH Agent'], ['key', '本机私钥'], ['password', 'SSH 密码']]) {
    const option = node('option', '', label);
    option.value = value;
    auth.append(option);
  }
  auth.required = true;
  auth.value = host?.auth || 'password';
  const authPicker = selectControl(auth, '认证方式', { valueLabel: option => option?.value === 'password'
    ? '＋ 使用私钥或 SSH Agent' : `切换认证方式 · ${option?.textContent || '请选择'}` });
  authPicker.classList.add('host-auth-switch');
  const agentHint = node('p', 'muted host-agent-hint', '使用本机 SSH Agent 中已加载的密钥进行认证。');
  const key = input(host?.keyPath, 'hidden');
  const selectedKeyName = node('span', 'selected-key-name');
  const select = button('', () => manageKeys(file => { key.value = file; updateAuth(); }, key.value), 'key-picker-trigger', '选择私钥');
  const keyCaret = node('span', 'dropdown-caret'); keyCaret.setAttribute('aria-hidden', 'true');
  select.append(chromeIcon('key'), selectedKeyName, keyCaret);
  select.setAttribute('aria-haspopup', 'dialog'); select.setAttribute('aria-controls', 'key-dialog');
  const keyRow = node('div', 'credential-pane host-private-key', node('label', '', '私钥'), node('div', 'host-key-selection', key, select));
  const clearKeySecret = input('', 'checkbox');
  const clearKeyRow = node('label', 'checkbox-row', clearKeySecret, '清除此主机已保存的私钥口令');
  const keyEditor = passwordEditor(host, auth, hasKeyPassphrase,
    () => auth.value === 'key' && key.value === host?.keyPath && !clearKeySecret.checked,
    () => Boolean(identity.value) || inheritIdentity.checked, { auth: 'key', label: '私钥口令', placeholder: '未加密私钥可留空',
      hint: '口令加密保存在本机，连接时自动使用。', savedHint: '口令已保存在本机；输入新口令可替换。', changedHint: '私钥已更换，请填写所选私钥的口令。',
      reveal: () => api.hosts.revealKeyPassphrase({ id: host.id, keyPath: key.value }) });
  const keySecret = keyEditor.password, keySecretPane = keyEditor.pane;
  keySecretPane.classList.add('host-key-passphrase');
  const keySecretHint = keySecretPane.querySelector('small');
  clearKeySecret.addEventListener('change', () => {
    keySecret.disabled = clearKeySecret.checked; if (clearKeySecret.checked) keySecret.value = '';
    keyEditor.hide(); if (clearKeySecret.checked) keySecretHint.textContent = '保存后将清除已保存的私钥口令。';
  });
  const normalizedAddress = () => addressField.value.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const matches = (item) => item.address.toLowerCase() === normalizedAddress() && item.port === Number(port.value) && item.username === username.value.trim();
  const sameTarget = () => Boolean(host?.auth === 'password' && auth.value === 'password' && matches(host));
  const editor = api.hosts.revealPassword ? passwordEditor(host, auth, hasPassword, sameTarget,
    () => Boolean(identity.value) || inheritIdentity.checked) : null;
  const inheritanceRow = (id, label, toggle) => {
    const value = node('span', 'inheritance-value'); value.id = `host-inherit-${id}-value`;
    const source = node('small', 'inheritance-source'); source.id = `host-inherit-${id}-source`;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${label}跟随分组`);
    toggle.setAttribute('aria-describedby', `${value.id} ${source.id}`);
    const row = node('label', 'inheritance-row', node('span', 'inheritance-name', label),
      node('span', 'inheritance-detail', value, source),
      node('span', 'security-switch', toggle, node('span', 'security-switch-track')));
    return { row, value, source };
  };
  const inheritanceRows = {
    port: inheritanceRow('port', '端口', inheritPort),
    identity: inheritanceRow('identity', '登录', inheritIdentity),
    theme: inheritanceRow('theme', '配色', inheritTheme)
  };
  inheritIdentity.setAttribute('aria-label', '登录配置跟随分组');
  inheritTheme.setAttribute('aria-label', '终端配色跟随分组');
  const inheritanceOptions = node('div', 'group-inheritance-options', node('h4', '', '分组默认设置'),
    node('div', 'inheritance-columns', node('span', '', '设置'), node('span', '', '使用值'), node('span', '', '跟随分组')),
    ...Object.values(inheritanceRows).map(item => item.row));
  inheritanceOptions.setAttribute('role', 'group');
  inheritanceOptions.setAttribute('aria-label', '分组默认设置');
  const inheritedSource=property=>{let g=groupAssets.find(g=>g.path===group.value);const seen=new Set();while(g&&!seen.has(g.id)){seen.add(g.id);if(g[property]!==undefined&&g[property]!==null&&g[property]!=='')return g;g=groupAssets.find(p=>p.id===g.parentId);}return undefined;};
  const updateInheritance = () => {
    const display = (key, value, source, unavailable = false) => {
      const item = inheritanceRows[key];
      item.value.textContent = value; item.source.textContent = source;
      item.row.classList.toggle('inheritance-unavailable', unavailable);
    };
    const portSource = inheritedSource('port'), identitySource = inheritedSource('identityId'), themeSource = inheritedSource('terminalTheme');
    const inheritedIdentity = identities.find(item => item.id === identitySource?.identityId);
    const selectedIdentity = identities.find(item => item.id === identity.value);
    display('port', port.value || '未设置', inheritPort.checked ? portSource ? `来自 ${portSource.path}` : '系统默认' : '单独设置');
    const missingIdentity = inheritIdentity.checked && !inheritedIdentity;
    display('identity', missingIdentity ? '未设置登录配置' : username.value.trim() ? `${username.value.trim()} · ${identityAuthLabels[auth.value] || '请选择认证方式'}` : '尚未设置',
      missingIdentity ? '分组及上级均未设置，请设置分组登录配置或关闭跟随' : inheritIdentity.checked ? `来自 ${identitySource.path}`
        : selectedIdentity ? `登录配置「${selectedIdentity.name}」` : '单独设置', missingIdentity);
    const themeValue = terminalTheme.value || uiPreferences.terminalTheme;
    display('theme', themeValue === 'light' ? '浅色' : '深色', inheritTheme.checked
      ? themeSource ? `来自 ${themeSource.path}` : '分组未设置，使用终端偏好' : terminalTheme.value ? '单独设置' : '终端偏好');
  };
  let wasInheritingIdentity = inheritIdentity.checked;
  const updateAuth = () => {
    const grouped = Boolean(group.value.trim());
    inheritanceOptions.hidden = !grouped;
    if (!grouped) inheritPort.checked = inheritIdentity.checked = inheritTheme.checked = false;
    if (wasInheritingIdentity && !inheritIdentity.checked) {
      // The displayed group identity is an effective value, not a direct host association.
      identity.value = '';
      identity.dispatchEvent(new Event('input'));
    }
    wasInheritingIdentity = inheritIdentity.checked;
    const portSource=inheritedSource('port'),identitySource=inheritedSource('identityId'),themeSource=inheritedSource('terminalTheme');
    const inheritedIdentity=identities.find(i=>i.id===identitySource?.identityId);
    if(inheritPort.checked) port.value=portSource?.port||22;
    if(inheritIdentity.checked){identity.value=inheritedIdentity?.id||'';identity.dispatchEvent(new Event('input'));if(inheritedIdentity){username.value=inheritedIdentity.username;auth.value=inheritedIdentity.auth;key.value=inheritedIdentity.keyPath||'';auth.dispatchEvent(new Event('input'));}}
    if(inheritTheme.checked){terminalTheme.value=themeSource?.terminalTheme||'';terminalTheme.dispatchEvent(new Event('input'));}
    const linked=Boolean(identity.value)||inheritIdentity.checked;
    const selectedIdentity = identities.find(item => item.id === identity.value);
    identityHint.hidden = !selectedIdentity && !inheritIdentity.checked;
    identityHint.textContent = selectedIdentity
      ? `使用登录配置「${selectedIdentity.name}」中的用户名和认证方式。可到「设置 → 登录配置」统一修改。`
      : '选择登录配置，可让多台主机复用相同的 SSH 用户名和认证方式。也可以选择「单独配置此主机」。';
    connectionSection.hidden = identityField.hidden = identityHelp.hidden = inheritIdentity.checked;
    auth.disabled=username.disabled=key.disabled=select.disabled=linked;port.disabled=inheritPort.checked;identity.disabled=inheritIdentity.checked;terminalTheme.disabled=inheritTheme.checked;
    if(editor) {editor.pane.hidden=linked;if(linked) editor.password.value='';}
    keyRow.hidden = linked || auth.value !== 'key';
    agentHint.hidden = linked || auth.value !== 'agent';
    selectedKeyName.textContent = keyName(key.value) || '选择私钥';
    select.title = key.value || '选择私钥';
    if (inheritIdentity.checked) { keySecret.value = ''; clearKeySecret.checked = false; }
    const savedKey = hasKeyPassphrase && key.value === host?.keyPath;
    clearKeyRow.hidden = !savedKey || linked || auth.value !== 'key';
    if (!savedKey) { clearKeySecret.checked = false; keySecret.disabled = false; }
    if (auth.value !== 'key') keySecret.value = '';
    keyEditor.hide();
    keySecretPane.hidden = linked || auth.value !== 'key' || !api.hosts.hasKeyPassphrase;
    key.required = auth.value === 'key' && !(host?.auth === 'key' && !host.keyPath);
    if (editor) {
      if (auth.value !== 'password') editor.password.value = '';
      editor.hide();
      editor.pane.hidden = linked || auth.value !== 'password';
    }
    updateInheritance();
  };
  inheritPort.addEventListener('change',updateAuth);inheritIdentity.addEventListener('change',updateAuth);inheritTheme.addEventListener('change',updateAuth);
  group.addEventListener('input',updateAuth);group.addEventListener('change',updateAuth);
  identity.addEventListener('change',()=>{const i=identities.find(i=>i.id===identity.value);if(i){username.value=i.username;auth.value=i.auth;key.value=i.keyPath||'';auth.dispatchEvent(new Event('change'));}updateAuth();});
  auth.addEventListener('change', updateAuth);
  key.addEventListener('input', updateAuth);
  for (const control of [username, port, terminalTheme]) control.addEventListener('input', updateInheritance);
  terminalTheme.addEventListener('change', updateInheritance);
  for (const required of [addressField, username, port]) required.required = true;
  const draft = () => ({ id: host?.id, name: name.value, address: addressField.value, port: Number(port.value), username: username.value, group: group.value, groupId:groupAssets.find(g=>g.path===group.value)?.id, inheritPort:inheritPort.checked, inheritIdentity:inheritIdentity.checked, inheritTheme:inheritTheme.checked,terminalTheme:terminalTheme.value||undefined,keepaliveInterval:Number(keepalive.value),connectTimeout:Number(timeout.value),
    identityId: inheritIdentity.checked ? undefined : identity.value || undefined, auth: auth.value, keyPath: key.value || undefined, jumpHostId: jump.value || undefined, tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), note: note.value, logPath: logPath.value, service: service.value, startupCommand:startup.value, startupEnabled:autoStartup.checked, autoReconnect:reconnect.checked });
  const duplicate = input('', 'checkbox');
  const duplicateRow = node('label', 'checkbox-row', duplicate, '已有相同地址、端口和用户名，仍保存为另一条配置');
  const connectionSection = node('section', 'host-form-section host-ssh-settings', node('h3', '', 'SSH 连接'),
    field('SSH 用户名', node('div', 'host-username-control', chromeIcon('user'), username)), identityHint,
    ...(editor ? [editor.pane] : []), keyRow, keySecretPane, agentHint, authPicker);
  updateAuth();
  const original = JSON.stringify(draft());
  const duplicateHost = () => !host?.id && hosts.some(matches);
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
    const target = hostTarget(pasted);
    if (!target) {
      addressField.value = pasted;
      pasteHint.textContent = '无法解析这条命令，请手动填写连接字段。';
      updateDuplicate();
      return;
    }
    username.value = target.username;
    addressField.value = target.address;
    port.value = target.port || port.value;
    pasteHint.textContent = '已填入连接信息，请核对后保存。';
    updateDuplicate();
    updateInheritance();
  });
  const details = node('details', 'host-form-section', node('summary', '', '更多设置'),
    field('连接路径', jumpPicker), routeHint,
    ...(api.identities ? [identityField, identityHelp] : []),
    field('标签', tags), field('备注', note), field('常用日志路径', logPath), field('常用 systemd 服务', service),...(api.snippets?[field('终端配色（未继承时）',terminalThemePicker),field('SSH 保活间隔（秒，0 关闭）',keepalive),field('连接超时（秒）',timeout),field('启动命令',startup),node('label','checkbox-row',autoStartup,'每次新建连接后在终端自动执行上述命令'),node('label','checkbox-row',reconnect,'异常断线后自动重连（最多 3 次；仅 Agent 或已保存密码）'),node('p','muted','自动重连会创建新会话，也会重新执行已启用的启动命令；转发规则须手动恢复。')]:[]));
  const management = host && node('details', 'host-form-section', node('summary', '', '管理主机'), clearKeyRow, node('div', 'management-actions',
    ...(hasPassword ? [button('清除已保存密码', () => { closePrompt('clear-password'); }, 'outlined')] : []),
    button('忘记指纹', () => { closePrompt('forget'); }, 'outlined'),
    button('删除主机', () => { closePrompt('delete'); }, 'outlined danger')));
  management?.addEventListener('toggle', () => {
    if (management.open) management.scrollIntoView({ block: 'nearest' });
  });
  const save = node('button', '', '保存');
  save.type = 'submit';
  save.value = 'save';
  const conceal = () => { editor?.hide(); keyEditor.hide(); };
  const groupCreationError = node('p', 'dialog-error');
  groupCreationError.setAttribute('role', 'alert');
  groupCreationError.hidden = true;
  let result;
  window.addEventListener('blur', conceal);
  document.addEventListener('visibilitychange', conceal);
  try {
    while (!vaultStatus.locked) {
      result = await prompt(host ? '编辑主机' : '新建主机', [
        node('section', 'host-form-section', node('h3', '', '地址'),
          node('div', 'dialog-row', field('主机地址', addressField), field('端口', port)), pasteHint),
        node('section', 'host-form-section', node('h3', '', '常规'), field('显示名称', name), field('分组', groupPicker), groupCreationError, ...(api.groups ? [inheritanceOptions] : [])),
        connectionSection, duplicateRow, details, ...(management ? [management] : [])
      ], '保存并连接', async (action) => {
        if (duplicateHost() && !duplicate.checked) throw new Error('请确认是否保存重复的连接配置。');
        if (auth.value === 'key' && !key.value && !identity.value && !inheritIdentity.checked) throw new Error('请选择本机私钥。');
        conceal();
        const localPassword = auth.value === 'password' ? editor?.password.value || undefined : undefined;
        const previousIds = new Set(hosts.map(item => item.id));
        const savedHosts = await api.hosts.save({ ...draft(), localPassword,
          localKeyPassphrase: auth.value === 'key' ? keySecret.value || undefined : undefined,
          clearKeyPassphrase: clearKeySecret.checked });
        return { hosts: savedHosts, savedHostId: host?.id || savedHosts.find(item => !previousIds.has(item.id))?.id, connect: action === 'connect' };
      }, [save], {
        drawer: true, focus: addressField, submitValue: 'connect',
        canClose: () => (JSON.stringify(draft()) === original && !editor?.password.value && !keySecret.value && !clearKeySecret.checked) || confirmDiscardHostChanges()
      });
      if (!createGroupRequested || result || vaultStatus.locked) break;
      createGroupRequested = false;
      groupCreationError.hidden = true;
      try {
        const created = await editGroup(undefined, groupAssets.find(item => item.path === group.value), undefined, {
          name: newGroupName, submitLabel: '创建并返回主机', cancelLabel: '返回主机'
        });
        if (vaultStatus.locked) break;
        refreshGroupChoices(created?.path || group.value);
        updateAuth();
      } catch (failure) {
        groupCreationError.textContent = message(failure);
        groupCreationError.hidden = false;
      }
    }
  } finally {
    conceal();
    if (editor) editor.password.value = '';
    keySecret.value = '';
    window.removeEventListener('blur', conceal);
    document.removeEventListener('visibilitychange', conceal);
  }
  if (result) {
    hosts = result.hosts;
    renderHosts();
    if (active?.kind === 'new') renderQuickConnect(active);
    if (result.connect) await openHost(hosts.find(item => item.id === result.savedHostId), { draftTab });
    return;
  }
  const choice = dialog.returnValue;
  dialog.returnValue = '';
  if (host && choice === 'clear-password' && await confirm('清除已保存密码', `清除「${host.name}」的 SSH 密码？如果它已加入加密备份和 Git 同步，下次同步时会从仓库的当前快照移除。`, '清除密码')) {
    await api.hosts.clearPassword(host.id);
    status('已清除本机保存的 SSH 密码。');
  } else if (host && choice === 'forget' && await confirm('忘记主机指纹', `仅在你已核对 ${endpoint(host)} 的密钥变更后继续。这也会清除该地址的本机密码记录。`, '忘记指纹')) {
    await api.hosts.forget(host.id);
    status('已清除该地址的信任记录。');
  } else if (host && choice === 'delete') await deleteHost(host);
}

async function deleteHost(host) {
  const sessions = [...tabs.values()].filter(tab => tab.host?.id === host.id);
  const result = await prompt('删除主机', [
    node('p', '', `删除「${host.name}」？${endpoint(host)}`),
    node('p', 'muted', '这会移除主机配置及其单独保存的密码、私钥口令。私钥文件、共用登录配置和其他主机保留。'),
    ...(sessions.length ? [node('p', 'muted', '已有会话保持打开，断线后不再自动重连。')] : [])
  ], '删除主机', () => api.hosts.remove(host.id));
  if (!result) return;
  for (const tab of sessions) tab.reconnectCancelled = true;
  hosts = result;
  if (selectedHostId === host.id) selectedHostId = '';
  await refreshHosts();
  status(`已删除主机「${host.name}」。`);
}

async function deleteHostGroup(group) {
  const path = typeof group === 'string' ? group : group.path;
  const all = api.groups ? await api.groups.list() : [];
  const current = all.find(g => typeof group === 'string' ? g.path === group : g.id === group.id);
  if (api.groups && !current) throw new Error('分组已删除，请刷新。');
  const ids = current ? window.hostTree.descendants(all, current.id) : new Set();
  const expectedGroups = all.filter(g => ids.has(g.id));
  const hostCount = current?.hosts?.length ?? hosts.filter(h => h.group === path).length;
  const result = await prompt('删除分组', [
    node('p', '', `删除分组「${current?.path || path}」${ids.size > 1 ? `及其 ${ids.size - 1} 个子分组` : ''}？`),
    node('p', 'muted', `${hostCount} 台主机会移到未分组。主机及凭据保留，原来继承的连接设置会继续保留。`)
  ], '删除分组', () => current
    ? api.groups.remove({ group: current, expected: current, expectedGroups })
    : api.hosts.removeGroup(path));
  if (!result) return;
  for (const id of ids) { expandedHostGroups.delete(id); collapsedSettingsGroups.delete(id); }
  if (currentGroup === path || currentGroup.startsWith(`${path} / `)) currentGroup = '';
  selectedGroup = '';
  await refreshHosts();
  status(`已删除分组「${current?.path || path}」，${hostCount} 台主机已移到未分组。`);
}

function groupActions(group) {
  const more = button('⋯', () => showActionMenu(`${group.path} 的操作`, more,
    [...hostOrderActions('group', group), button('删除分组', () => deleteHostGroup(group), 'danger')]), 'host-edit', `分组操作 ${group.path}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  return more;
}

function openGroup(group) {
  closeDropdown();
  currentGroup = group;
  selectedHostId = selectedGroup = '';
  $('host-search').value = '';
  $('tag-filter').value = '';
  $('tag-filter').dispatchEvent(new Event('input'));
  renderHosts();
  $('host-library').scrollTop = 0;
}

function renderHostBreadcrumb(current, groupById) {
  const breadcrumb = $('host-breadcrumb');
  const ancestors = [];
  const seen = new Set([current.id]);
  for (let group = groupById.get(current.parentId); group && !seen.has(group.id); group = groupById.get(group.parentId)) {
    seen.add(group.id);
    ancestors.unshift(group);
  }
  const home = button('全部主机', () => openGroup(''));
  home.id = 'all-hosts';
  const location = summaryText('span', current.name);
  location.title = current.path;
  location.setAttribute('aria-current', 'location');
  location.tabIndex = -1;
  const list = node('ol', '', node('li', '', home));
  for (const group of ancestors) {
    const link = button(group.name, () => {
      openGroup(group.path);
      breadcrumb.querySelector('[aria-current="location"]')?.focus({ preventScroll: true });
    }, 'text-ellipsis');
    link.title = group.path;
    list.append(node('li', '', breadcrumbSeparator(), link));
  }
  list.append(node('li', '', breadcrumbSeparator(), location));
  breadcrumb.replaceChildren(list);

  function breadcrumbSeparator() {
    const separator = node('span', '', '›');
    separator.setAttribute('aria-hidden', 'true');
    return separator;
  }
}

const expandedHostGroups = new Set();
const collapsedSettingsGroups = new Set();
let treeSearchKey = '', expandedSearchGroups;
try {
  const ids = JSON.parse(localStorage.getItem('host-tree-expanded') || '[]');
  if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') expandedHostGroups.add(id);
} catch { /* Start with collapsed groups when a saved preference is unavailable. */ }

// Native disclosure buttons keep Tab/Enter behavior; arrow keys navigate the visible hierarchy.
function groupTree(tree, expanded, options) {
  let sequence = 0;
  const namespace = `group-tree-${options.hostRow ? 'hosts' : 'settings'}`;
  function children(branch, depth = 0) {
    const list = node('ul', 'group-tree');
    for (const child of branch.groups) {
      const g = child.group;
      const toggle = button('', () => {
        const open = !expanded.has(g.id);
        if (open) expanded.add(g.id); else expanded.delete(g.id);
        toggle.setAttribute('aria-expanded', String(open));
        content.hidden = !open;
        options.onToggle?.(child, open, content);
      }, 'group-open tree-primary tree-group-toggle', `分组 ${g.path}`);
      toggle.title = g.path;
      toggle.append(node('span', 'tree-chevron', '›'), settingsIcon('group'),
        node('span', 'host-identity', summaryText('strong', g.name),
          summaryText('small', options.detail?.(child) || `${child.count} 台主机`)));
      const content = children(child, depth + 1);
      content.classList.add('tree-children');
      content.id = `${namespace}-${++sequence}`;
      content.hidden = !expanded.has(g.id);
      toggle.setAttribute('aria-controls', content.id);
      toggle.setAttribute('aria-expanded', String(!content.hidden));
      if (!content.children.length) {
        const empty = node('li', 'tree-empty muted', options.hostRow ? '此分组暂无主机或子分组' : '暂无子分组');
        empty.style.marginInlineStart = `${Math.min(depth + 1, 8) * 16}px`;
        content.append(empty);
      }
      const row = node('div', 'host-row group-row tree-group-row', toggle);
      row.style.marginInlineStart = `${Math.min(depth, 8) * 16}px`;
      if (options.hostRow) decorateHostOrder(row, 'group', g);
      if (options.actions) row.append(options.actions(g));
      const item = node('li', 'tree-item', row, content);
      item.dataset.treeGroup = g.id;
      list.append(item);
    }
    if (options.hostRow) for (const host of branch.hosts) {
      const row = options.hostRow(host);
      row.style.marginInlineStart = `${Math.min(depth, 8) * 16}px`;
      row.querySelector('.host-open').classList.add('tree-primary');
      list.append(node('li', 'tree-item tree-host', row));
    }
    return list;
  }
  const list = children(tree);
  list.setAttribute('aria-label', options.label);
  list.addEventListener('keydown', event => {
    const control = event.target.closest('.tree-primary');
    if (!control || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const controls = [...list.querySelectorAll('.tree-primary')].filter(item => item.getClientRects().length);
    const index = controls.indexOf(control);
    const item = control.closest('.tree-item');
    if (event.key === 'ArrowRight') {
      if (control.getAttribute('aria-expanded') === 'false') control.click();
      else item.querySelector(':scope > .tree-children .tree-primary')?.focus();
    } else if (event.key === 'ArrowLeft') {
      if (control.getAttribute('aria-expanded') === 'true') control.click();
      else item.parentElement.closest('.tree-item')?.querySelector('.tree-primary')?.focus();
    } else {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      controls[next]?.focus();
    }
  });
  return list;
}

function renderHostTree(matching, query, tag, draft) {
  let tree = orderedHostTree();
  const key = JSON.stringify([query, tag]);
  const searching = Boolean(query || tag);
  if (searching) {
    const ids = new Set(matching.map(host => host.id));
    tree = window.hostTree.filter(tree, host => ids.has(host.id), group => !tag && matchesQuery(query, group.path));
    if (treeSearchKey !== key) {
      expandedSearchGroups = new Set();
      const expand = branch => { for (const child of branch.groups) { expandedSearchGroups.add(child.group.id); expand(child); } };
      expand(tree);
    }
  }
  treeSearchKey = searching ? key : '';
  const view = groupTree(tree, searching ? expandedSearchGroups : expandedHostGroups, {
    label: '主机树', hostRow: hostCard,
    ...(api.groups ? { actions: groupActions } : {}),
    onToggle: (_branch, _open, content) => {
      if (!searching) try { localStorage.setItem('host-tree-expanded', JSON.stringify([...expandedHostGroups])); } catch { /* Keep in memory. */ }
      if (content.hidden && [...content.querySelectorAll('.host-open')].some(item => item.dataset.hostId === selectedHostId)) {
        selectedHostId = '';
        for (const item of content.querySelectorAll('.host-open')) item.setAttribute('aria-pressed', 'false');
        updateHostActions();
      }
    }
  });
  $('host-list').replaceChildren(tree.groups.length || tree.hosts.length ? view
    : node('p', 'muted', draft ? '按回车或点「填写主机」，核对连接信息后保存。' : searching ? '没有匹配的主机或分组' : '暂无主机或分组'));
  const selected = [...view.querySelectorAll('.host-open')].find(item => item.dataset.hostId === selectedHostId);
  if (selected?.closest('[hidden]')) { selectedHostId = ''; selected.setAttribute('aria-pressed', 'false'); updateHostActions(); }
}

function groupCard(group, count, asset) {
  const name = asset?.name ?? group;
  const card = node('button', 'group-open', settingsIcon('group'), node('span', 'host-identity',
    summaryText('strong', name), node('small', '', `${count} 台主机`)), node('span', 'group-arrow', '›'));
  card.type = 'button';
  card.dataset.group = group;
  card.setAttribute('aria-label', `打开分组 ${name}，${count} 台主机`);
  card.setAttribute('aria-pressed', String(selectedGroup === group));
  card.title = `${group} · 双击打开分组`;
  card.addEventListener('click', (event) => {
    if (event.detail === 0) { openGroup(group); return; }
    selectedGroup = group;
    selectedHostId = '';
    updateHostActions();
    for (const item of $('host-list').querySelectorAll('.host-open')) item.setAttribute('aria-pressed', 'false');
    for (const item of $('host-list').querySelectorAll('.group-open')) {
      item.setAttribute('aria-pressed', String(item === card));
    }
  });
  card.addEventListener('dblclick', () => openGroup(group));
  const row = node('div', 'host-row group-row', card, ...(api.groups && asset ? [groupActions(asset)] : []));
  if (asset) decorateHostOrder(row, 'group', asset);
  return row;
}

function hostCard(host) {
  const open = node('button', 'host-open');
  open.type = 'button';
  open.dataset.hostId = host.id;
  open.setAttribute('aria-label', `主机 ${host.name}，${endpoint(host)}`);
  open.setAttribute('aria-pressed', String(selectedHostId === host.id));
  const detail = endpoint(host);
  open.replaceChildren(settingsIcon('server'), node('span', 'host-identity', summaryText('strong', host.name), summaryText('small', detail)));
  open.title = [host.name, detail, host.group, authLabels[host.auth], host.tags?.join(', '), host.note, '单击选中，双击或按回车连接'].filter(Boolean).join('\n');
  open.addEventListener('click', (event) => {
    selectHost(host);
    if (event.detail === 0) void openHost(host).catch((error) => status(message(error)));
  });
  open.addEventListener('dblclick', () => { void openHost(host).catch((error) => status(message(error))); });
  const edit = button('', () => { selectHost(host); return editHost(host); }, 'host-edit host-quick-edit', `编辑主机 ${host.name}`);
  edit.innerHTML = '<svg class="chrome-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z"/></svg>';
  const more = button('⋯', () => openHostMenu(host, more), 'host-edit', `主机操作 ${host.name}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  const row = node('div', 'host-row', open, edit, more);
  decorateHostOrder(row, 'host', host);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openHostMenu(host, more, event.clientX || undefined, event.clientY || undefined);
  });
  return row;
}

function selectHost(host) {
  selectedHostId = host.id;
  selectedGroup = '';
  for (const item of $('host-list').querySelectorAll('.host-open')) item.setAttribute('aria-pressed', String(item.dataset.hostId === host.id));
  for (const item of $('host-list').querySelectorAll('.group-open')) item.setAttribute('aria-pressed', 'false');
  updateHostActions();
}

function updateHostActions() {
  const host = hosts.find((item) => item.id === selectedHostId);
  hostSearchAction = host ? () => openHost(host) : hostSearchMatch?.run;
  $('host-connect').disabled = !hostSearchAction;
  $('host-connect').textContent = !host && hostSearchMatch?.draft ? '填写主机' : '连接';
}

function closeHostMenu(restoreFocus = false) {
  if (!hostMenu) return;
  const { panel, anchor } = hostMenu;
  hostMenu = undefined;
  panel.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function openHostMenu(host, anchor, x, y) {
  if (vaultStatus.locked || dialog.open) return;
  selectHost(host);
  const actions = [
    ['连接 / 切换已有会话', () => openHost(host)],
    ['在新标签连接', () => openHost(host, { force: true })],
    ['编辑主机', () => editHost(host)],
    ...(api.identities ? [['管理登录配置',()=>manageIdentities()],...(!host.identityId?[['保存为登录配置',()=>editIdentity(undefined,host)]]:[])] : []),
    ...(api.forwards ? [['端口转发', () => manageForwards(host)]] : []),
    ...(api.hosts.csvExport ? [['导出主机 CSV', () => exportHosts({ hostId: host.id })]] : []),
    ['删除主机', () => deleteHost(host), 'danger']
  ];
  showActionMenu(`${host.name} 的操作`, anchor, [...actions.map(([label, run, style]) => button(label, run, style)), ...hostOrderActions('host', host)], x, y);
}

function menuButton(label, actions) {
  const anchor = button(label, () => showActionMenu(label, anchor, actions), 'outlined');
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  return anchor;
}

function showActionMenu(label, anchor, actions, x, y) {
  if (vaultStatus.locked || dialog.open) return;
  if (hostMenu?.anchor === anchor) { closeHostMenu(true); return; }
  closeHostMenu();
  closeDropdown();
  const panel = node('div', 'host-menu');
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', label);
  for (const action of actions) {
    if (action.tagName === 'BUTTON') {
      if (!action.hasAttribute('role')) action.setAttribute('role', 'menuitem');
      action.addEventListener('click', () => closeHostMenu(true), { capture: true, once: true });
    }
    panel.append(action);
  }
  document.body.append(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x ?? rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(y ?? rect.bottom + 5, innerHeight - panel.offsetHeight - 8))}px`;
  hostMenu = { panel, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  panel.tabIndex = -1;
  (panel.querySelector('button:not(:disabled)') || panel).focus();
  panel.addEventListener('keydown', (event) => {
    const choices = [...panel.querySelectorAll('button:not(:disabled)')];
    const index = choices.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!choices.length) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeHostMenu(true);
    }
  });
}

function hostSection(title, entries) {
  return node('section', 'host-section', node('h2', 'host-group', title), node('div', 'host-entries', ...entries));
}

function hostMatches(host, query, target) {
  return (target && matchesTarget(host, target)) ||
    matchesQuery(query, host.name, endpoint(host), host.group, host.tags, host.note);
}

function orderedHostTree(overrides = {}) {
  return window.hostTree.build(groupAssets, hosts, { groupSort: uiPreferences.groupSort || 'name-asc', hostSort: uiPreferences.hostSort || 'recent', recent, ...overrides });
}

function hostOrderState(kind) {
  return (kind === 'group' ? groupAssets : hosts).map(item => ({ id: item.id,
    parentId: kind === 'group' ? item.parentId || null : item.groupId || groupAssets.find(g => g.path === item.group)?.id || null,
    sortOrder: item.sortOrder ?? null })).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function hostOrderFiltered() { return Boolean($('host-search').value.trim() || $('tag-filter').value); }
function hostSortMode(kind) { return kind === 'group' ? uiPreferences.groupSort || 'name-asc' : uiPreferences.hostSort || 'recent'; }

async function saveHostOrder(kind, mode, scopes = [], expected = hostOrderState(kind), expectedMode = hostSortMode(kind)) {
  if (hostSortBusy || vaultStatus.locked) return;
  hostSortBusy = true;
  $('host-sort').disabled = true;
  const scroll = $('host-library').scrollTop;
  const focusedId = document.activeElement?.closest('[data-order-id]')?.dataset.orderId;
  try {
    const result = await api.hosts.reorder({ kind, mode, scopes, expected, expectedMode });
    if (vaultStatus.locked) return;
    hosts = result.hosts; groupAssets = result.groups; uiPreferences = result.preferences;
    status('已保存排序。');
  } catch (error) {
    await refreshHosts().catch(() => {});
    status(message(error));
  } finally {
    hostSortBusy = false;
    renderHosts();
    $('host-library').scrollTop = scroll;
    if (focusedId) [...$('host-list').querySelectorAll('.host-order-handle')].find(handle => handle.parentElement.dataset.orderId === focusedId)?.focus({preventScroll:true});
  }
}

function showHostSortMenu(anchor) {
  const actions = [];
  for (const [kind, label] of [['group', '分组排序'], ['host', '主机排序']]) {
    actions.push(node('div', 'sort-menu-label', label));
    for (const [mode, text] of [...(kind === 'host' ? [['recent','最近连接']] : []), ['name-asc','名称升序'], ['name-desc','名称降序'], ['manual','自定义']]) {
      const choice = button(text, () => {
        if (mode === hostSortMode(kind)) return;
        let scopes = [];
        if (mode === 'manual') {
          const entries = kind === 'group' ? groupAssets : hosts;
          const sourceMode = entries.some(item => item.sortOrder != null) ? 'manual' : hostSortMode(kind);
          scopes = window.hostTree.scopes(orderedHostTree({ [kind === 'group' ? 'groupSort' : 'hostSort']: sourceMode }), kind);
        }
        return saveHostOrder(kind, mode, scopes);
      });
      choice.setAttribute('role', 'menuitemradio');
      choice.setAttribute('aria-checked', String(mode === hostSortMode(kind)));
      choice.disabled = hostSortBusy;
      actions.push(choice);
    }
  }
  actions.push(node('p', 'sort-menu-help muted', hostOrderFiltered() ? '清除搜索和标签筛选后可调整顺序。' : '自定义模式下，拖动手柄或使用操作菜单调整同级顺序。'));
  actions.push(node('p', 'sort-menu-help muted', '手动顺序随备份和 Git 同步；同一保险库的设备需使用支持排序的版本。'));
  showActionMenu('主机与分组排序', anchor, actions);
}

function showHostActions() {
  const anchor = $('host-actions'), actions = [];
  const add = (label, run, icon, id, style = '') => {
    const action = button('', run, `menu-with-icon ${style}`);
    action.append(chromeIcon(icon), node('span', '', label));
    if (id) action.id = id;
    actions.push(action);
  };
  if (api.groups) add('新建分组', async () => {
    const created = await editGroup(undefined, groupAssets.find(group => group.path === currentGroup), undefined, { submitLabel: '创建分组' });
    if (created) openGroup(created.path);
  }, 'group');
  add('导入 OpenSSH', () => importHosts(), 'import', 'import-hosts');
  if (api.hosts.csvPreview) add('导入 CSV', () => importHosts(true), 'import', 'import-csv');
  if (api.hosts.csvExport) add('导出 CSV', () => exportHosts(), 'export', 'export-csv');
  if (currentGroup) add('删除当前分组', () => deleteHostGroup(currentGroup), 'group', undefined, 'danger');
  showActionMenu('更多主机操作', anchor, actions, anchor.getBoundingClientRect().left);
}

function hostOrderScope(kind, item) {
  const parentId = kind === 'group' ? item.parentId || null : item.groupId || groupAssets.find(g => g.path === item.group)?.id || null;
  return window.hostTree.scopes(orderedHostTree(), kind).find(scope => scope.parentId === parentId);
}

function moveHostOrder(kind, item, position) {
  const scope = hostOrderScope(kind, item);
  if (!scope || hostOrderFiltered() || hostSortMode(kind) !== 'manual') return;
  const ids = scope.ids.filter(id => id !== item.id);
  ids.splice(Math.max(0, Math.min(ids.length, position)), 0, item.id);
  if (ids.every((id,index) => id === scope.ids[index])) return Promise.resolve();
  return saveHostOrder(kind, 'manual', [{ ...scope, ids }]).then(() => {
    [...$('host-list').querySelectorAll('.host-order-handle')].find(handle => handle.parentElement.dataset.orderId === item.id)?.focus({ preventScroll:true });
  });
}

function hostOrderActions(kind, item) {
  if (!api.hosts.reorder || hostSortMode(kind) !== 'manual' || hostOrderFiltered()) return [];
  const scope = hostOrderScope(kind, item);
  if (!scope || scope.ids.length < 2) return [];
  const index = scope.ids.indexOf(item.id), last = scope.ids.length - 1;
  return [['上移',index-1,index===0], ['下移',index+1,index===last], ['移到最前',0,index===0], ['移到最后',last,index===last]].map(([label, position, disabled]) => {
    const action = button(label, () => moveHostOrder(kind, item, position));
    action.disabled = disabled || hostSortBusy;
    return action;
  });
}

function decorateHostOrder(row, kind, item) {
  row.dataset.orderKind = kind; row.dataset.orderId = item.id;
  row.dataset.orderParent = (kind === 'group' ? item.parentId : item.groupId || groupAssets.find(g => g.path === item.group)?.id) || '';
  if (!api.hosts.reorder || hostSortMode(kind) !== 'manual') return;
  const handle = button('⠿', () => {
    const actions = hostOrderActions(kind, item);
    if (actions.length) showActionMenu(`调整${item.name}的顺序`, handle, actions);
  }, 'host-order-handle order-handle', `调整${kind === 'group' ? '分组' : '主机'}顺序 ${item.name}`);
  handle.title = hostOrderFiltered() ? '清除搜索和标签筛选后可调整顺序' : '拖动调整同级顺序；Alt + ↑ / ↓ 移动';
  handle.disabled = hostSortBusy || hostOrderFiltered();
  handle.setAttribute('aria-haspopup', 'menu'); handle.setAttribute('aria-expanded','false');
  handle.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const scope = hostOrderScope(kind, item);
    void moveHostOrder(kind, item, scope.ids.indexOf(item.id) + (event.key === 'ArrowUp' ? -1 : 1));
  });
  wireOrderDrag(handle, () => {
    const scope = hostOrderScope(kind, item);
    if (!scope) return;
    const expected = hostOrderState(kind), expectedMode = hostSortMode(kind);
    return {
      source: row, ids: scope.ids, name: item.name, scrollArea: $('host-library'),
      horizontal: workspace.dataset.hostLayout === 'cards',
      isTarget: hit => hit.dataset.orderKind === kind && hit.dataset.orderParent === row.dataset.orderParent,
      save: ids => saveHostOrder(kind, 'manual', [{ ...scope, ids }], expected, expectedMode)
    };
  });
  row.prepend(handle);
}

const orderMarker = node('div', 'order-marker');
const orderGhost = node('div', 'order-ghost');
orderMarker.hidden = orderGhost.hidden = true;
document.body.append(orderMarker, orderGhost);

function orderDragBlocked() {
  return vaultStatus.locked || document.body.classList.contains('overlay-open');
}

function wireOrderDrag(handle, prepare) {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || handle.disabled || orderDragBlocked()) return;
    cancelOrderDrag();
    closeHostMenu();
    const options = prepare();
    if (!options || options.ids.length < 2) return;
    const { clientX: x, clientY: y, pointerId } = event;
    orderDrag = { ...options, handle, pointerId, x, y, startX: x, startY: y };
    handle.setPointerCapture(pointerId);
  });
  handle.addEventListener('lostpointercapture', () => { if (orderDrag?.handle === handle) cancelOrderDrag(); });
}

function cancelOrderDrag() {
  if (!orderDrag) return;
  const drag = orderDrag;
  orderDrag = undefined;
  if (drag.started) suppressOrderClickUntil = performance.now() + 250;
  cancelAnimationFrame(orderDragFrame);
  drag.source.classList.remove('order-source');
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  document.body.classList.remove('order-drag-active');
  orderMarker.hidden = orderGhost.hidden = true;
}

function updateOrderDrag() {
  const drag = orderDrag;
  if (!drag?.started) return;
  if (orderDragBlocked() || !drag.source.getClientRects().length) { cancelOrderDrag(); return; }
  const hit = document.elementFromPoint(drag.x, drag.y)?.closest('[data-order-id]');
  drag.nextIds = undefined;
  orderMarker.hidden = true;
  orderGhost.textContent = drag.name;
  orderGhost.hidden = false;
  orderGhost.style.left = `${Math.min(drag.x + 12, innerWidth - orderGhost.offsetWidth - 8)}px`;
  orderGhost.style.top = `${Math.min(drag.y + 12, innerHeight - 36)}px`;
  if (!hit || hit === drag.source || !drag.isTarget(hit)) return;
  const rect = hit.getBoundingClientRect();
  const before = drag.horizontal ? drag.x < rect.left + rect.width / 2 : drag.y < rect.top + rect.height / 2;
  const sourceId = drag.source.dataset.orderId;
  const ids = drag.ids.filter(id => id !== sourceId);
  const index = ids.indexOf(hit.dataset.orderId);
  if (index < 0) return;
  ids.splice(index + (before ? 0 : 1), 0, sourceId);
  drag.nextIds = ids;
  Object.assign(orderMarker.style, drag.horizontal
    ? {left:`${(before ? rect.left : rect.right)-2}px`,top:`${rect.top}px`,width:'3px',height:`${rect.height}px`}
    : {left:`${rect.left}px`,top:`${(before ? rect.top : rect.bottom)-2}px`,width:`${rect.width}px`,height:'3px'});
  orderMarker.hidden = false;
}

function scrollOrderDrag() {
  const drag = orderDrag;
  if (!drag?.started) return;
  const rect = drag.scrollArea.getBoundingClientRect();
  if (drag.x >= rect.left && drag.x <= rect.right) {
    const delta = drag.y < rect.top + 36 ? -10 : drag.y > rect.bottom - 36 ? 10 : 0;
    if (delta) { drag.scrollArea.scrollTop += delta; updateOrderDrag(); }
  }
  if (orderDrag === drag) orderDragFrame = requestAnimationFrame(scrollOrderDrag);
}
window.addEventListener('pointermove', event => {
  const drag = orderDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.started && Math.hypot(drag.x-drag.startX, drag.y-drag.startY) >= 6) {
    drag.started = true;
    drag.source.classList.add('order-source');
    document.body.classList.add('order-drag-active');
    scrollOrderDrag();
  }
  updateOrderDrag();
});
function finishOrderDrag(event) {
  const drag = orderDrag;
  if (!drag || event.pointerId != null && event.pointerId !== drag.pointerId) return;
  if (drag.started) {
    event.preventDefault(); event.stopPropagation();
    drag.x = event.clientX; drag.y = event.clientY;
    updateOrderDrag();
  }
  if (orderDrag !== drag) return;
  cancelOrderDrag();
  if (drag.nextIds?.some((id, index) => id !== drag.ids[index])) void drag.save(drag.nextIds);
}
window.addEventListener('pointerup', finishOrderDrag, true);
// WKWebView can deliver mouseup without pointerup when the pointer crosses native surfaces.
window.addEventListener('mouseup', event => { if (orderDrag?.started) finishOrderDrag(event); }, true);
document.addEventListener('click', event => {
  if (event.detail && performance.now() < suppressOrderClickUntil && event.target.closest('.order-handle')) {
    event.preventDefault(); event.stopPropagation();
  }
}, true);
for (const event of ['pointercancel', 'blur', 'resize']) window.addEventListener(event, cancelOrderDrag);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && orderDrag) { event.preventDefault(); event.stopPropagation(); cancelOrderDrag(); }
}, true);

function recentFirst(a, b) {
  return (recent.get(b.id) || 0) - (recent.get(a.id) || 0) || a.name.localeCompare(b.name, 'zh-CN');
}

function renderHosts() {
  if (orderDrag && $('host-list').contains(orderDrag.source)) cancelOrderDrag();
  closeHostMenu();
  $('host-sort').hidden = !api.hosts.reorder;
  $('host-sort').disabled = hostSortBusy;
  const treeLayout = workspace.dataset.hostLayout === 'tree';
  const groupByPath = new Map(groupAssets.map(group => [group.path, group]));
  const groupById = new Map(groupAssets.map(group => [group.id, group]));
  const groups = new Map(groupAssets.map(g=>[g.path,0]));
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
  const scope = currentGroup && !treeLayout ? hosts.filter((host) => host.group === currentGroup) : hosts;
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
  const text = $('host-search').value.trim();
  const query = text.toLowerCase();
  const target = hostTarget(text);
  const searching = Boolean(query || tag);
  const matching = scope.filter((host) => (!tag || host.tags?.includes(tag)) && hostMatches(host, query, target));
  const visibleHosts = treeLayout || currentGroup || searching ? matching : matching.filter((host) => !host.group);
  if (!visibleHosts.some((host) => host.id === selectedHostId)) selectedHostId = '';
  const ordered = orderedHostTree();
  const groupPositions = new Map(window.hostTree.flattenGroups(ordered).map((g,index) => [g.id,index]));
  const positions = new Map(window.hostTree.flatten(ordered).map((h, index) => [h.id, index]));
  const hostSort = uiPreferences.hostSort || 'recent';
  visibleHosts.sort(hostSort === 'manual' ? (a,b) => positions.get(a.id) - positions.get(b.id) : window.hostTree.compare(hostSort, recent));
  const matchingGroups = new Set(matching.map((host) => host.group));
  const visibleGroups = [...groups]
    .filter(([group]) => {
      const parent = groupById.get(groupByPath.get(group)?.parentId)?.path || '';
      if (currentGroup && parent !== currentGroup) return false;
      return searching ? matchingGroups.has(group) || group.toLowerCase().includes(query) : parent === currentGroup;
    })
    .sort(([a], [b]) => {
      const first = groupByPath.get(a) || {id:a,name:a}, second = groupByPath.get(b) || {id:b,name:b};
      return uiPreferences.groupSort === 'manual' ? groupPositions.get(first.id) - groupPositions.get(second.id) : window.hostTree.compare(uiPreferences.groupSort)(first,second);
    });
  if (!visibleGroups.some(([group]) => group === selectedGroup)) selectedGroup = '';
  $('host-breadcrumb').hidden = treeLayout || !currentGroup;
  if (!treeLayout && currentGroup) {
    renderHostBreadcrumb(groupByPath.get(currentGroup) ?? { name: currentGroup, path: currentGroup }, groupById);
  }
  const exact = query ? matching.filter((host) => target ? matchesTarget(host, target) : host.name.toLowerCase() === query) : [];
  const candidates = target || exact.length ? exact : matching;
  const saved = query && candidates.length === 1 ? candidates[0] : undefined;
  const draft = target && !exact.length;
  hostSearchMatch = saved ? { run: () => openHost(saved) } : draft ? { draft: true, run: () => editHost(undefined, undefined, target) } : undefined;
  updateHostActions();
  if (treeLayout) { renderHostTree(matching, query, tag, draft); return; }
  const groupEntries = visibleGroups.map(([group, count]) => groupCard(group, count, groupByPath.get(group)));
  const hostEntries = visibleHosts.map(hostCard);
  if (!currentGroup && !groupEntries.length) groupEntries.push(node('p', 'muted', searching ? '没有匹配的分组' : '暂无分组'));
  if (!hostEntries.length) {
    const empty = draft ? '按回车或点「填写主机」，核对连接信息后保存。'
      : searching ? '没有匹配的主机'
      : currentGroup ? '分组中暂无主机' : '暂无未分组的主机';
    hostEntries.push(node('p', 'muted', empty));
  }
  const sections = [];
  if (groupEntries.length) sections.push(hostSection(currentGroup ? '子分组' : '分组', groupEntries));
  sections.push(hostSection(searching ? '匹配的主机' : '主机', hostEntries));
  $('host-list').replaceChildren(...sections);
}

async function exportHosts(initial = {}) {
  const scope = node('select');
  scope.append(new Option('全部主机与分组', 'all'));
  for (const group of groupAssets) scope.append(new Option(`分组 · ${group.path}`, `group:${group.id}`));
  for (const host of hosts) scope.append(new Option(`主机 · ${host.name} · ${endpoint(host)}`, `host:${host.id}`));
  const groupId = initial.groupId || groupAssets.find(g => g.path === (selectedGroup || currentGroup))?.id;
  const hostId = initial.hostId || (!groupId ? selectedHostId : '');
  scope.value = hostId ? `host:${hostId}` : groupId ? `group:${groupId}` : 'all';
  const result = await prompt('导出主机与分组 CSV', [
    field('导出范围', selectControl(scope, '导出范围', { searchable: true, placeholder: '搜索主机或分组' })),
    node('p', 'muted', '导出主机名称、地址、端口、SSH 用户名、认证方式、标签、备注和连接设置。分组会保留层级、空分组、默认端口及配色；按组导出包含子组和组内主机。'),
    node('p', 'muted', '不包含密码、私钥、私钥路径、私钥口令或登录配置关联。导入后需在本机重新配置凭据。启动命令、端口转发和信任记录也不包含在内。'),
    node('p', 'muted', '所需的上级分组和跳板机会一并导出。CSV 为明文，请妥善保管其中的主机信息。')
  ], '选择保存位置', () => {
    const [kind, id] = scope.value.split(':');
    return api.hosts.csvExport(kind === 'host' ? { hostId: id } : kind === 'group' ? { groupId: id } : {});
  });
  if (result) status(`已导出 ${result.count} 台主机、${result.groupCount} 个分组，未包含密码或密钥。`);
}

async function importHosts(csv=false) {
  const preview = await (csv ? api.hosts.csvPreview() : api.hosts.importPreview());
  if (!preview) return;
  const duplicates = input('', 'checkbox');
  const groups = (preview.groups || []).map(group => {
    const selected = input('', 'checkbox');
    selected.checked = true;
    return { group, selected, view: node('label', 'checkbox-row', selected, group.path || group.name) };
  });
  const rows = preview.rows.map(source => {
    const row = { ...source, id: source.id || sessionId() };
    const selected = input('', 'checkbox');
    selected.checked = !row.issue;
    selected.disabled = Boolean(row.issue) && !row.editable;
    const username = input(row.username);
    username.placeholder = 'SSH 用户名';
    username.addEventListener('input', () => { if (row.editable) selected.checked = Boolean(username.value.trim()); });
    const label = node('label', 'checkbox-row', selected, `${row.name || row.address} · ${row.address}:${row.port} · ${row.username || '待填写用户'}${row.issue ? ` · ${row.issue}` : ''}`);
    const authentication = node('small', 'muted', row.auth === 'key'
      ? row.keyPath ? `本机私钥 · ${row.keyPath}` : '私钥认证 · 导入后选择本机私钥'
      : row.auth === 'password' ? '密码认证 · 导入后单独配置密码' : 'SSH Agent · 使用本机已加载的密钥');
    return { row, selected, username, view: node('div', 'import-row', label,
      ...(row.group ? [node('small', 'muted', `分组 · ${row.group}`)] : []), authentication,
      ...(row.editable ? [field('SSH 用户名', username)] : [])) };
  });
  const list = node('div', 'key-list',
    ...(groups.length ? [node('h3', '', `分组（${groups.length}）`), ...groups.map(g => g.view)] : []),
    ...(rows.length ? [node('h3', '', `主机（${rows.length}）`), ...rows.map(r => r.view)] : []));
  const result = await prompt(csv ? '预览 CSV 导入' : '预览 OpenSSH 导入', [
    ...preview.warnings.map(warning => node('p', 'muted', warning)),
    ...(csv ? [node('p', 'muted', '所选主机需要的分组、上级分组和跳板机会一并导入。同路径分组复用现有分组；相同地址、端口和用户名的主机默认跳过，不覆盖原配置。')] : []),
    node('div', 'forward-actions', button('全选', () => {
      for (const item of [...groups, ...rows]) if (!item.selected.disabled) item.selected.checked = true;
    }, 'outlined'), button('全不选', () => {
      for (const item of [...groups, ...rows]) item.selected.checked = false;
    }, 'outlined')),
    list, node('label', 'checkbox-row', duplicates, '保留重复主机配置')
  ], csv ? '导入所选主机与分组' : '导入所选主机', () => {
    const selectedRows = new Map(rows.filter(r => r.selected.checked).map(r => [r.row.id, r]));
    const selectedGroups = new Map(groups.filter(g => g.selected.checked).map(g => [g.group.id, g.group]));
    const addGroup = id => {
      if (!id) return;
      const group = groups.find(g => g.group.id === id)?.group;
      if (!group) throw new Error('CSV 中缺少所需分组。');
      selectedGroups.set(id, group);
      if (group.parentId) addGroup(group.parentId);
    };
    const addHost = item => {
      if (item.selected.disabled) throw new Error('所需跳板机配置无效，请先修正 CSV。');
      if (item.row.jumpHostId && !selectedRows.has(item.row.jumpHostId)) {
        const jump = rows.find(r => r.row.id === item.row.jumpHostId);
        if (!jump) throw new Error('CSV 中缺少所需跳板机。');
        selectedRows.set(jump.row.id, jump);
        addHost(jump);
      }
      addGroup(item.row.groupId);
    };
    for (const item of selectedRows.values()) addHost(item);
    for (const group of selectedGroups.values()) addGroup(group.id);
    const selected = [...selectedRows.values()].map(({ row, username }) => ({ ...row, username: username.value }));
    if (!selected.length && !selectedGroups.size) throw new Error('请选择至少一台主机或一个分组。');
    return api.hosts.import({ rows: selected, groups: [...selectedGroups.values()], keepDuplicates: duplicates.checked });
  });
  if (result) {
    hosts = result.hosts;
    await refreshHosts();
    status(`已导入 ${result.count} 台主机、${result.groupCount || 0} 个新分组。${csv ? '密码和私钥请在本机单独配置。' : ''}`);
  }
}

function attachTerminal(tab) {
  const surface = node('div', 'terminal-surface');
  const view = node('div', 'terminal-view', surface);
  view.hidden = true;
  $('terminal-views').append(view);
  const terminal = new Terminal({
    fontFamily: uiPreferences.fontFamily, fontSize: uiPreferences.fontSize, lineHeight: 1.2, scrollback: 6000,
    cursorBlink: tab.kind === 'shell', disableStdin: tab.kind === 'command',
    convertEol: tab.kind === 'command', allowProposedApi: true, minimumContrastRatio: 4.5, theme: terminalThemeFor(tab.host)
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(surface);
  const rendering = createTerminalRendering(terminal, () => {
    if (surface.clientWidth && surface.clientHeight) fit.fit();
  });
  const paths = terminalPaths.observe(terminal, (path, text, mayProbe) => {
    void openLinkedTerminalPath(tab, path, text, mayProbe).catch((error) => status(message(error)));
  }, () => {}, () => tab.kind === 'shell' && tab.status === 'ready');
  view.addEventListener('contextmenu', (event) => {
    const selected = terminal.getSelection().trim();
    if (!selected || selected.includes('\n') || !readySession(origin(tab))) return;
    event.preventDefault();
    void chooseTerminalPath(tab, selected).catch((error) => status(message(error)));
  });
  terminal.attachCustomKeyEventHandler(event => keyboard.terminalKey(event, terminal.hasSelection()));
  terminal.onData((data) => {
    paths.invalidate(data);
    if (tab.status === 'ready') api.ssh.input({ id: tab.id, data });
  });
  terminal.onResize(() => syncTerminalSize(tab));
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
  view.addEventListener('pointerdown', event => {
    if (!event.target.closest('.split-pane-header') && active !== tab && splitLayout?.panes.includes(tab.id)) selectTab(tab);
  });
  const resizeObserver = new ResizeObserver(() => { if (surface.clientHeight) void rendering.fit(); });
  resizeObserver.observe(surface);
  tab.resizeObserver = resizeObserver;
  Object.assign(tab, { view, surface, terminal, rendering, search, paths });
  if (tab.kind === 'shell') {
    tab.paneLabel = summaryText('span', tabTitle(tab));
    tab.paneLabel.classList.add('split-pane-title');
    tab.paneHeader = node('div', 'split-pane-header', tab.paneLabel,
      button('×', () => detachSplitPane(tab), '', `将 ${tab.host.name} 移出分屏`));
    wireTabDrag(tab.paneHeader, tab, { pane: true });
    tab.paneHeader.addEventListener('click', event => { if (!event.target.closest('button')) selectTab(tab); });
    tab.paneHeader.hidden = true;
    view.append(tab.paneHeader);
  }
  if (tab.kind === 'shell') {
    tab.connectionPage = node('section', 'connection-page');
    tab.connectionPage.setAttribute('aria-label', 'SSH 连接');
    view.append(tab.connectionPage);
    renderConnectionPage(tab);
  }
  applyTerminalPreferences(tab);
}

function syncTerminalSize(tab) {
  if (tab.kind === 'shell' && !vaultStatus.locked) {
    api.ssh.resize({ id: tab.id, size: { rows: tab.terminal.rows, cols: tab.terminal.cols } });
  }
}

function selectTab(tab, view = tab?.kind === 'new' ? 'new-tab' : tab ? 'session' : 'hosts', options = {}) {
  if (!options.keepDrag) cancelTabDrag();
  cancelOrderDrag();
  syncPendingSplitLayout();
  closeDropdown();
  closeHostMenu();
  if (view === 'settings' && !settingsRun) { openSettings(); return; }
  if (view !== 'settings') leaveSettings();
  active = tab;
  splitLayout = splitGroupFor(tab?.id);
  if (splitLayout) splitLayout.focusId = tab.id;
  if (!tab && view !== 'new-tab') libraryView = view;
  $('workspace-tools').hidden = view !== 'settings';
  if (tab) tab.unread = false;
  workspace.dataset.view = view;
  updateNavigation();
  const library = $('library-button');
  library.dataset.active = String(!tab);
  if (view === 'hosts') library.setAttribute('aria-current', 'page');
  else library.removeAttribute('aria-current');
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
  if (view === 'transfers') {
    refreshTransferActions();
    void loadTransferHistory();
  }
  if (tab) tab.used = Date.now();
  if (tab?.kind === 'shell' && tab.status === 'ready') {
    recent.set(tab.host.id, tab.used);
    status(`${tab.host.name} · SSH 已连接${tab.jumpHost ? `（经 ${tab.jumpHost.name}）` : ''}`);
  }
  else if (tab?.kind === 'shell') status(`${tab.host.name} · ${tab.message || sessionLabels[tab.status]}`);
  else if (tab?.kind === 'command') status(`${tab.host.name} · ${actionLabels[tab.action]}`);
  else if (view !== 'session') status(({ hosts: '已保存的主机', 'new-tab': '选择要连接的主机', keys: 'SSH 密钥', transfers: '上传和下载记录', settings: '设置' })[view]);
  $('terminal-find').hidden = true;
  $('terminal-drop').hidden = true;
  renderTerminalBottom();
  renderSplitLayout();
  renderTabs();
  revealActiveTab('smooth');
  if (view === 'hosts') {
    selectedHostId = selectedGroup = '';
    renderHosts();
  }
  renderContext();
  renderFiles();
  if (filesOpen) ensureFiles(origin());
  renderServerInfo();
  if (serverInfoOpen) void loadServerInfo(origin(), true);
  if (tab?.kind === 'new') {
    $('quick-connect-search').value = tab.query;
    renderQuickConnect(tab);
    $('new-tab-page').scrollTop = 0;
    if (!vaultStatus.locked) $('quick-connect-search').focus({ preventScroll: true });
  } else if (tab) {
    requestAnimationFrame(() => {
      if (active !== tab || tabDrag?.started) return;
      tab.rendering.fit();
      focusTerminal(tab);
    });
  }
}

function focusTerminal(tab) {
  if (tab?.connectionPage && !tab.connectionPage.hidden) return;
  if (active === tab && !vaultStatus.locked && !dialog.open && !fileEditor.open && !$('key-dialog').open && !$('session-switcher').open) {
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
  const row = workspaceEntryFor(active?.id)?.tab.tabRow;
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
  if(tab.title) return tab.title;
  return tabName(tab) + (tab.number > 1 ? ` · ${tab.number}` : '');
}

function tabIcon(tab) {
  return chromeIcon(({ new: 'new-tab', command: 'file', shell: 'terminal' })[tab.kind]);
}

function renderTabs() {
  const strip = $('tabs'), entries = workspaceEntries();
  const membership = new Map(entries.flatMap(entry => entry.panes.map(id => [id, entry])));
  for (const tab of tabs.values()) {
    if (tab.tabRow?.dataset.kind !== tab.kind) {
      const open = button('', () => selectTab(workspaceFocus(workspaceEntryFor(tab.id))), 'tab-open');
      open.replaceChildren(node('span', 'tab-status'), summaryText('span', tabName(tab)), node('span', 'tab-unread', '新'), node('span', 'tab-number'));
      const close = button('×', () => closeWorkspaceTab(tab), 'tab-close');
      const icon = tabIcon(tab), leading = tab.kind === 'new' ? node('span', 'tab-leading', icon, close) : close;
      if (tab.kind !== 'new') open.append(icon);
      const row = node('div', 'tab', leading, open);
      row.dataset.kind = tab.kind;
      wireTabDrag(row, tab);
      row.addEventListener('contextmenu', event => { event.preventDefault(); void editTab(tab); });
      if (tab.tabRow) tab.tabRow.replaceWith(row); else strip.append(row);
      tab.tabRow = row;
    }
    const entry = membership.get(tab.id), group = entry.group;
    const current = entry.panes.includes(active?.id), focused = workspaceFocus(entry);
    const title = workspaceTitle(entry), members = entry.panes.map(id => tabs.get(id));
    const unread = members.some(item => item.unread);
    tab.tabRow.hidden = entry.representativeId !== tab.id;
    tab.tabRow.dataset.workspaceId = entry.key;
    tab.tabRow.dataset.active = String(current);
    tab.tabRow.dataset.grouped = String(Boolean(group));
    tab.tabRow.querySelector('.tab-close').setAttribute('aria-label', group ? `关闭${title}（${members.length} 个会话）` : `关闭 ${title}`);
    const open = tab.tabRow.querySelector('.tab-open');
    open.querySelector('.text-ellipsis').textContent = group ? title : tab.title || tabName(tab);
    const state = tab.kind === 'new' ? '选择主机' : sessionLabels[focused.status] || '等待连接';
    const description = group ? `${title} · ${members.length} 个分屏 · ${members.map(item => tabTitle(item)).join('、')}` : title;
    open.setAttribute('aria-pressed', String(current));
    open.setAttribute('aria-label', `${description} · ${state}${unread ? ' · 有未读输出' : ''}`);
    open.title = open.getAttribute('aria-label');
    const number = open.querySelector('.tab-number');
    number.hidden = !group && !(tab.number > 1);
    number.textContent = group ? String(members.length) : String(tab.number || '');
    tab.tabRow.dataset.status = focused.status || '';
    const indicator = open.querySelector('.tab-status');
    indicator.hidden = tab.kind === 'new'; indicator.title = state;
    open.querySelector('.tab-unread').hidden = !unread;
  }
  $('switch-tabs').hidden = entries.length < 2;
  $('close-all-tabs').hidden = tabs.size < 2;
  $('close-all-tabs').disabled = closingAllTabs;
  updateTabEdges();
  if (sessionFilters && $('session-switcher').open) renderSessionSwitcher();
}

function tabChoice(tab) {
  const detail = [tab === active ? '当前标签' : '', tab.host ? endpoint(tab.host) : '选择主机',
    tab.host?.group, sessionLabels[tab.status]].filter(Boolean).join(' · ');
  const choice = button('', () => {
    if (!tabs.has(tab.id)) throw new Error('这个会话已关闭，请重新搜索。');
    if ($('session-switcher').open) $('session-switcher').close();
    selectTab(tab);
  }, 'tab-choice');
  choice.append(tabIcon(tab), summaryText('span', tabTitle(tab)), summaryText('small', detail));
  if (tab === active) choice.setAttribute('aria-current', 'true');
  return choice;
}

function matchingTabs(query, filters = {}) {
  return [...tabs.values()].filter(tab => matchesHostFilters(tab.host, filters) &&
    (!filters.status || (filters.status === 'command' ? tab.kind === 'command' : tab.kind === 'shell' &&
      (filters.status === 'connecting' ? ['connecting','trust'].includes(tab.status)
        : filters.status === 'closed' ? ['closed','failed'].includes(tab.status) : tab.status === filters.status))) &&
    matchesQuery(query, tabTitle(tab), tab.host?.name, tab.host ? endpoint(tab.host) : '', tab.host?.group,
      tab.host?.tags, tab.host?.note, sessionLabels[tab.status]));
}

function renderSessionSwitcher() {
  const query = $('session-switcher-search').value.trim().toLowerCase();
  sessionFilters.refresh([...tabs.values()].map(tab => tab.host));
  const entries = matchingTabs(query, sessionFilters.values).map(tabChoice);
  $('session-switcher-results').replaceChildren(...(entries.length ? entries : [node('p', 'muted', '没有匹配的标签。')]));
}

function chooseSession() {
  const switcher = $('session-switcher');
  if (tabs.size < 2 || vaultStatus.locked || dialog.open || $('key-dialog').open || switcher.open) return;
  closeDropdown();
  $('session-switcher-search').value = '';
  sessionFilters.set({});
  renderSessionSwitcher();
  $('switch-tabs').setAttribute('aria-expanded', 'true');
  window.overlays.show(switcher);
  $('session-switcher-search').focus();
}

function quickConnectGroup(title, entries) {
  return node('section', 'quick-connect-group', node('h2', '', title), ...entries);
}

function renderQuickConnect(draftTab) {
  const results = $('quick-connect-results');
  const text = draftTab.query.trim();
  const query = text.toLowerCase();
  const target = hostTarget(text);
  quickConnectFilters.refresh([...hosts, ...[...tabs.values()].map(tab => tab.host)]);
  quickConnectFilters.set(draftTab.filters || {});
  const filters = quickConnectFilters.values;
  draftTab.filters = filters;
  const matching = filters.type === 'session' ? [] : hosts.filter(host => matchesHostFilters(host, filters) && hostMatches(host, query, target)).sort((a, b) =>
    (target ? Number(matchesTarget(b, target)) - Number(matchesTarget(a, target)) : 0) || recentFirst(a, b));
  const visited = query ? [] : matching.filter((host) => recent.has(host.id)).slice(0, 8);
  const groups = [];
  const hostChoice = (host) => {
    const choice = button('', () => openHost(host, { draftTab }), 'tab-choice');
    choice.append(chromeIcon('server'), summaryText('span', host.name),
      summaryText('small', [endpoint(host), host.group].filter(Boolean).join(' · ')));
    choice.title = [host.name, endpoint(host), host.group].filter(Boolean).join(' · ');
    return choice;
  };
  if (visited.length) groups.push(quickConnectGroup('最近连接', visited.map(hostChoice)));
  if (target && !Object.values(filters).some(Boolean) && !hosts.some(host => matchesTarget(host, target))) {
    const choice = button('', () => editHost(undefined, draftTab, target), 'tab-choice');
    choice.append(chromeIcon('new-tab'), summaryText('span', '填写新主机'), summaryText('small', text));
    groups.push(quickConnectGroup('快速连接', [choice]));
  }
  const saved = matching.filter((host) => !visited.includes(host));
  if (saved.length) groups.push(quickConnectGroup(query ? '匹配的主机' : '已保存的主机', saved.map(hostChoice)));
  if (filters.type !== 'host' && (query || filters.type === 'session')) {
    const entries = matchingTabs(query, filters).filter(tab => tab !== draftTab).map(tabChoice);
    if (entries.length) groups.push(quickConnectGroup('已打开的标签', entries));
  }
  if (!groups.length) {
    const hint = query || Object.values(filters).some(Boolean) ? '没有匹配的主机或会话，请调整搜索或筛选。'
      : hostsLoaded ? '还没有已保存的主机。' : draftTab.loadError || '正在读取主机…';
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

async function manageForwards(host, session) {
  if (forwardPanelOpen || dialog.open || vaultStatus.locked) return;
  forwardPanelOpen = true;
  try { await openForwardPanel(host, session); }
  finally { forwardPanelOpen = false; }
}

async function openForwardPanel(host, session) {
  const version = forwardVersion;
  const live = await api.forwards.list();
  if (vaultStatus.locked) return;
  for (const [id, run] of forwardRuns) if ((forwardVersions.get(id) || 0) <= version && run.status !== 'stopped' && !live.some((item) => item.id === id)) forwardRuns.delete(id);
  for (const run of live) if ((forwardVersions.get(run.id) || 0) <= version) forwardRuns.set(run.id, run);
  const list = node('div', 'forward-list');
  const feedback = node('p', 'dialog-error');
  feedback.setAttribute('role', 'alert');
  const name = input('');
  const kind=node('select');for(const[value,label]of [['local','本地转发：本机 → SSH 主机侧'],['remote','远程转发：SSH 主机侧 → 本机'],['dynamic','动态转发：本机 SOCKS5（仅 CONNECT）']]){const o=node('option','',label);o.value=value;kind.append(o);}const kindPicker=selectControl(kind,'转发类型');
  const localPort = input('', 'number');
  const address = input('127.0.0.1');
  const remotePort = input('', 'number');
  for (const port of [localPort, remotePort]) { port.min = 1; port.max = 65535; }
  const listenField=field('本机监听端口（127.0.0.1）',localPort),targetField=field('目标服务地址（由 SSH 主机访问）',address);
  const updateKind=()=>{address.disabled=remotePort.disabled=kind.value==='dynamic';address.required=remotePort.required=kind.value!=='dynamic';listenField.firstChild.textContent=kind.value==='remote'?'远端监听端口（请求 127.0.0.1）':'本机监听端口（127.0.0.1）';targetField.firstChild.textContent=kind.value==='remote'?'目标服务地址（由本机访问）':'目标服务地址（由 SSH 主机访问）';};
  const editor = node('section', 'forward-editor', node('h3', '', '规则设置'), field('规则名称', name),field('转发类型',kindPicker),
    listenField, targetField, field('目标服务端口', remotePort));
  editor.hidden = true;
  let editing, original = '', pending = new Set();
  const draft = () => ({ id: editing?.id, name: name.value, kind:kind.value, localPort: Number(localPort.value), remoteAddress: address.value, remotePort: Number(remotePort.value) });
  const openEditor = (rule) => {
    editing = rule || null;
    kind.value=rule?.kind||'local';kind.dispatchEvent(new Event('change'));
    name.value = rule?.name || ''; localPort.value = rule?.localPort || ''; address.value = rule?.remoteAddress || '127.0.0.1'; remotePort.value = rule?.remotePort || '';
    editor.hidden = false;
    for (const field of [name, localPort, address, remotePort]) field.required = true;
    address.disabled=remotePort.disabled=kind.value==='dynamic';address.required=remotePort.required=kind.value!=='dynamic';
    original = JSON.stringify(draft());
    render();
    name.focus();
  };
  kind.addEventListener('change',updateKind);
  const cancelEdit = button('取消编辑', () => {
    if (JSON.stringify(draft()) !== original && !window.confirm('放弃尚未保存的转发规则？')) return;
    editor.hidden = true;
    for (const field of [name, localPort, address, remotePort]) field.required = false;
    render();
  }, 'outlined');
  editor.append(cancelEdit);
  const currentHost = () => hosts.find((item) => item.id === host.id);
  const activeRuns = () => [...forwardRuns.values()].filter((job) => job.hostId === host.id && job.status !== 'stopped');
  const perform = async (key, action) => {
    if (pending.has(key)) return;
    pending.add(key); feedback.textContent = ''; render();
    try { await action(); } catch (error) { feedback.textContent = message(error); }
    finally { pending.delete(key); render(); }
  };
  const render = () => {
    if (!dialog.open || !list.isConnected) return;
    const rules = currentHost()?.localForwards || [];
    const runs = activeRuns();
    const savedIds = new Set(rules.map((rule) => rule.id));
    const ruleIds = new Set(savedIds);
    const displayed = [...rules, ...runs.filter((run) => !ruleIds.has(run.rule.id) && ruleIds.add(run.rule.id)).map((run) => run.rule)];
    const rows = displayed.map((rule) => {
      const running = runs.filter((job) => job.rule.id === rule.id);
      const last = [...forwardRuns.values()].findLast((job) => job.hostId === host.id && job.rule.id === rule.id);
      const detail = node('div', 'forward-status', running.length ? '' : last ? '已停止' : '未启动');
      if (!running.length && last?.error) detail.append(node('p', 'dialog-error', last.error));
      for (const run of running) {
        const label = run.sessionId === session?.id ? '此会话' : `会话 ${tabs.get(run.sessionId)?.number || run.sessionId.slice(0, 8)}`;
        const stop = button('停止', () => perform(rule.id, () => api.forwards.stop(run.id)), 'outlined');
        stop.disabled = pending.has(rule.id) || run.status === 'stopping';
        detail.append(node('div', 'forward-run', node('span', '', `${label} · ${run.status === 'stopping' ? '停止中' : '监听中'} · ${run.activeConnections} 个连接`), stop));
        if (run.error) detail.append(node('p', 'dialog-error', run.error));
        if (JSON.stringify(run.rule) !== JSON.stringify(rule)) detail.append(node('p', 'muted', `使用启动时规则：127.0.0.1:${run.rule.localPort} → ${run.rule.remoteAddress}:${run.rule.remotePort}`));
      }
      const actions = node('div', 'forward-actions');
      const start = button('启动', () => perform(rule.id, async () => {
        const run = await api.forwards.start({ sessionId: session.id, ruleId: rule.id, expected: rule });
        if (!forwardRuns.has(run.id)) forwardRuns.set(run.id, run);
      }), 'outlined');
      start.disabled = !session || session.status !== 'ready' || running.some((run) => run.sessionId === session?.id) || pending.has(rule.id) || !savedIds.has(rule.id) || !currentHost();
      const edit = button('编辑', () => openEditor(rule), 'outlined');
      const remove = button('删除', () => perform(rule.id, async () => {
        if (!window.confirm(`删除「${rule.name}」的转发规则？`)) return;
        const saved = await api.forwards.remove({ hostId: host.id, rule, expected: rule });
        if (vaultStatus.locked) return;
        hosts = saved; renderHosts();
      }), 'outlined danger');
      edit.disabled = remove.disabled = Boolean(running.length || pending.has(rule.id) || !currentHost());
      actions.append(start, edit, remove);
      const row = node('section', 'forward-rule', node('strong', '', rule.name),
        node('code', '', rule.kind==='dynamic'?`本机 127.0.0.1:${rule.localPort} → SOCKS5`:`${rule.kind==='remote'?'远端':'本机'} 127.0.0.1:${rule.localPort} → ${rule.kind==='remote'?'本机服务':'远端服务'} ${rule.remoteAddress.includes(':') ? `[${rule.remoteAddress}]` : rule.remoteAddress}:${rule.remotePort}`), detail, actions);
      row.setAttribute('aria-label', `转发规则 ${rule.name}`);
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [node('p', 'muted', '还没有转发规则。')]));
    const save = dialog.querySelector('button[type="submit"]');
    save.hidden = editor.hidden;
  };
  renderForwardPanel = render;
  const add = button('新增规则', () => openEditor(), 'outlined');
  const reload = button('刷新', () => perform('reload', async () => {
    const version = forwardVersion;
    const [saved, live] = await Promise.all([api.hosts.list(), api.forwards.list()]);
    if (vaultStatus.locked) return;
    hosts = saved;
    for (const [id, run] of forwardRuns) if ((forwardVersions.get(id) || 0) <= version && run.status !== 'stopped' && !live.some((item) => item.id === id)) forwardRuns.delete(id);
    for (const run of live) if ((forwardVersions.get(run.id) || 0) <= version) forwardRuns.set(run.id, run);
    renderHosts();
  }), 'outlined');
  add.disabled = !currentHost();
  try {
    const task = prompt(`${host.name} · 端口转发`, [
      node('p', 'muted', `${endpoint(host)}${session?.jumpHost ? ` · 经 ${session.jumpHost.name}` : ''}`),
      node('p', 'muted', '本地/动态转发只监听本机 127.0.0.1；远程转发请求服务器监听 127.0.0.1（实际范围受 sshd 配置影响）。远程类型的目标由本机访问；其他类型由 SSH 主机访问。仅手动启停，不随重连恢复。'),
      ...(!session ? [node('p', 'muted', '连接主机后，从会话工具栏启动规则。')] : []), node('div', 'forward-actions', add, reload), list, feedback, editor
    ], '保存规则', async () => {
      const saved = await api.forwards.save({ hostId: host.id, rule: draft(), expected: editing || undefined });
      if (vaultStatus.locked) return;
      hosts = saved;
      editor.hidden = true;
      for (const field of [name, localPort, address, remotePort]) field.required = false;
      renderHosts(); render();
    }, [], { closeOnSubmit: false, cancelLabel: '关闭', canClose: () => editor.hidden || JSON.stringify(draft()) === original || window.confirm('放弃尚未保存的转发规则？') });
    render();
    await task;
  } finally { renderForwardPanel = undefined; }
}

function renderConnectionPage(tab) {
  const page = tab.connectionPage;
  if (!page) return;
  page.hidden = tab.status === 'ready';
  tab.surface.inert = !page.hidden;
  if (page.hidden) return;

  page.dataset.status = tab.status;
  const title = tab.status === 'closed' ? (tab.connected ? '连接已断开' : '连接失败') : sessionLabels[tab.status];
  const detail = node('p', tab.status === 'closed' ? 'danger' : 'muted', tab.message || title);
  detail.setAttribute('role', 'status');
  const logs = node('pre', 'connection-log', (tab.connectionLog || []).join('\n'));
  logs.hidden = !tab.connectionLogOpen;
  const showLogs = button(logs.hidden ? '查看连接日志' : '收起连接日志', () => {
    logs.hidden = !logs.hidden;
    tab.connectionLogOpen = !logs.hidden;
    showLogs.textContent = logs.hidden ? '查看连接日志' : '收起连接日志';
    showLogs.setAttribute('aria-expanded', String(!logs.hidden));
  }, 'outlined');
  showLogs.setAttribute('aria-expanded', String(!logs.hidden));
  showLogs.disabled = !tab.connectionLog?.length;
  const actions = node('div', 'connection-actions');
  const body = node('div', 'connection-body',
    node('header', 'connection-header', settingsIcon('server'),
      node('div', 'connection-target', summaryText('strong', tab.host.name),
        summaryText('small', `SSH · ${endpoint(tab.host)}`)), showLogs),
    node('div', 'connection-track', node('span', 'connection-start', chromeIcon('server')),
      node('span', 'connection-line'), node('span', 'connection-end', chromeIcon('terminal'))),
    node('h2', '', title), detail);
  if (tab.credentialForm) {
    body.append(tab.credentialForm);
  } else if (tab.status === 'trust') {
    const host = tab.trustHost || tab.host;
    body.append(node('p', 'connection-fingerprint', tab.trustStage === 'jump' ? '跳板机 ' : '目标主机 ',
      endpoint(host), ' · ', node('code', '', tab.fingerprint)));
    actions.append(button('信任并连接', () => trust(tab, true), 'primary'),
      button('拒绝指纹', () => trust(tab, false), 'outlined'));
  } else if (tab.status === 'idle' || tab.status === 'closed') {
    if (tab.reconnectTimer) {
      actions.append(button('取消自动重连', () => {
        clearTimeout(tab.reconnectTimer);
        tab.reconnectTimer = undefined;
        tab.reconnectCancelled = true;
        renderConnectionPage(tab);
      }, 'outlined'));
    } else {
      actions.append(button(tab.promptForPassword ? '重新输入密码' : tab.attempts ? '重新连接' : '连接',
        () => connect(tab, tab.promptForPassword), 'primary'));
    }
    if (tab.status === 'closed' && tab.host.auth === 'key') {
      actions.append(button('编辑主机认证', () => editHost(hosts.find(host => host.id === tab.host.id) || tab.host), 'outlined'));
    }
  }
  actions.append(button(tab.status === 'connecting' ? '取消连接' : '关闭', () => closeTab(tab), 'outlined'));
  body.append(actions, logs);
  page.replaceChildren(body);
}

function addConnectionLog(tab, detail) {
  const log = tab.connectionLog ||= [];
  if (detail && log.at(-1) !== detail) log.push(detail);
}

function renderContext() {
  const tab = active;
  const session = origin(tab);
  const split = tab?.kind === 'shell' && visibleSplitLayout();
  $('toolbar').hidden = !tab?.terminal || Boolean(tab.connectionPage && !tab.connectionPage.hidden && !split);
  $('save-layout').hidden = !api.layouts || !split;
  $('session-notice').hidden = true;
  if ($('toolbar').hidden) return;
  const labels = { idle: '等待连接', connecting: '连接中', trust: '核对主机指纹', ready: '已连接', closed: '已断开', running: '运行中', done: '已完成', stopped: '已停止', failed: '失败' };
  $('context').replaceChildren(summaryText('strong', endpoint(tab.host)), node('span', tab.status === 'ready' ? 'online' : 'muted', labels[tab.status] || tab.status));
  if (session?.jumpHost) $('context').append(summaryText('small', `经 ${session.jumpHost.name}`));
  const controls = $('session-actions');
  controls.replaceChildren();
  if (tab.pendingTransfer && readySession(tab)) {
    const label = { locate: '定位远端文件', retry: '核对传输路径', resume: '继续传输', discard: '取消传输' }[tab.pendingTransfer.action];
    controls.append(button(label, () => continueTransferAction(tab), 'outlined'));
  }
  if (tab.kind === 'command') {
    if (session) controls.append(button('返回终端', () => selectTab(session), 'outlined'));
    if (tab.action === 'follow' && ['running', 'connecting'].includes(tab.status)) controls.append(button('停止跟踪', () => api.commands.stop(tab.id)));
  } else {
    const output = [...tabs.values()].findLast((entry) => entry.kind === 'command' && entry.sessionId === tab.id);
    if (output) controls.append(button('查看输出', () => selectTab(output), 'outlined', `查看输出 · ${actionLabels[output.action]}`));
  }
  const moreActions = [];
  if (readySession(session)) moreActions.push(button('打开远端路径', () => chooseTerminalPath()));
  let runningForwards = 0;
  if (api.forwards && session) {
    const running = [...forwardRuns.values()].filter((job) => job.sessionId === session.id && ['running', 'stopping'].includes(job.status)).length;
    runningForwards = running;
    moreActions.push(button(`端口转发${running ? ` · ${running}` : ''}`, () => manageForwards(session.host, session)));
  }
  if(api.logs&&session?.status==='ready') moreActions.push(button(recordingSessions.has(session.id)?'停止录制':'记录输出',()=>toggleRecording(session)));
  if(api.history&&session) moreActions.push(button('历史',()=>commandHistory(session)));
  if (api.layouts) moreActions.push(button('管理会话布局', () => manageLayouts()));
  const shortcuts = button('快捷命令', () => openPalette('commands'));
  shortcuts.disabled = session?.status !== 'ready';
  controls.append(shortcuts);
  if (api.ssh.serverInfo) {
    const info = button('服务器信息', toggleServerInfo);
    info.disabled = session?.status !== 'ready';
    info.setAttribute('aria-expanded', String(serverInfoOpen && Boolean(session)));
    info.setAttribute('aria-controls', 'server-info');
    controls.append(info);
  }
  const fileButton = button('文件', toggleFiles);
  fileButton.setAttribute('aria-expanded', String(filesOpen && Boolean(session)));
  fileButton.setAttribute('aria-controls', 'files');
  fileButton.disabled = !session;
  controls.append(fileButton);
  if (moreActions.length) {
    const more = menuButton(`更多${runningForwards ? ` · 转发 ${runningForwards}` : ''}${recordingSessions.has(session?.id) ? ' · 录制中' : ''} ⋯`, moreActions);
    controls.append(more);
  }

  const notice = $('session-notice');
  if ((tab.message && tab.status === 'failed') || tab.passwordSaveError) {
    notice.hidden = false;
    const actions = node('div');
    if (tab.host.auth === 'key') actions.append(button('编辑主机认证', () => editHost(hosts.find(host => host.id === tab.host.id) || tab.host), 'outlined'));
    actions.append(button('收起提示', () => { tab.passwordSaveError = ''; notice.hidden = true; }));
    notice.replaceChildren(node('div', '', tab.message || tab.passwordSaveError), actions);
  }
}

async function trust(tab, accepted) {
  if (tab.status !== 'trust') return;
  const challenge = tab.trustChallenge;
  updateSession(tab, 'connecting', accepted ? '已确认指纹，正在继续连接…' : '正在取消连接…');
  await api.ssh.trust({ id: tab.id, accepted, challenge });
}

async function enterCredential(host, jump = false, pane) {
  const passwordAuth = host.auth === 'password';
  const credential = input('', 'password');
  credential.required = passwordAuth;
  const label = passwordAuth ? 'SSH 密码' : '私钥口令（未加密可留空）';
  const remember = input('', 'checkbox');
  const share = input('', 'checkbox');
  const fields = [node('p', '', `${host.name} · ${endpoint(host)}`), field(label, credential)];
  if (passwordAuth) {
    fields.push(node('label', 'checkbox-row', remember, host.identityId ? '在本机记住此登录配置的密码' : '在本机记住密码'));
    if (vaultStatus.enabled) {
      const portable = node('label', 'checkbox-row', share, '同时加入加密备份和 Git 同步');
      portable.hidden = true;
      remember.addEventListener('change', () => { portable.hidden = !remember.checked; if (!remember.checked) share.checked = false; });
      fields.push(portable);
    }
  }
  try {
    if (pane) {
      return await new Promise(resolve => {
        const submit = node('button', 'primary', '连接');
        submit.type = 'submit';
        const finish = value => {
          pane.credentialForm = pane.cancelCredential = undefined;
          resolve(value);
        };
        const form = node('form', 'pane-credential', node('strong', '', jump ? '跳板机认证' : '目标主机认证'), ...fields,
          node('div', 'connection-actions', submit, button('取消认证', () => finish(undefined), 'outlined')));
        form.onsubmit = event => {
          event.preventDefault();
          finish({ secret: credential.value, remember: remember.checked, sharePassword: share.checked });
        };
        pane.credentialForm = form;
        pane.cancelCredential = () => finish(undefined);
        renderConnectionPage(pane);
        if (active === pane) credential.focus();
      });
    }
    return await prompt(jump ? '跳板机认证' : '目标主机认证', fields, '连接', () => ({ secret: credential.value, remember: remember.checked, sharePassword: share.checked }));
  } finally {
    credential.value = '';
  }
}

async function connect(tab, enterPassword = false, automatic = false, paneCredentials = false) {
  clearTimeout(tab.reconnectTimer);clearTimeout(tab.stableTimer);
  tab.reconnectTimer=undefined;
  if(!automatic){tab.retryCount=0;tab.reconnectCancelled=false;}
  if (tab.status === 'connecting' || !tabs.has(tab.id)) return;
  if(!tab.attempts) tab.host=hosts.find(h=>h.id===tab.host.id)||tab.host;
  tab.paths.reset();
  tab.connected = false;
  tab.connectionLog = [];
  tab.passwordSaveError = '';
  tab.passwordSaveErrors = new Map();
  updateSession(tab, 'connecting', '正在准备 SSH 连接…');
  try {
    const jumpHost = tab.host.jumpHostId ? hosts.find((host) => host.id === tab.host.jumpHostId) : undefined;
    if (tab.host.jumpHostId && !api.ssh.jumpHosts) throw new Error('跳板连接需使用 Termlume 桌面应用。');
    if (tab.host.jumpHostId && (!jumpHost || jumpHost.jumpHostId)) throw new Error('跳板机不可用，请编辑主机并核对连接路径。');
    if (jumpHost?.auth === 'key' && !jumpHost.keyPath) throw new Error(`请先为跳板机「${jumpHost.name}」选择本机私钥。`);
    tab.jumpHost = jumpHost;
    renderContext();
    const credentialFor = async (host, isJump = false) => {
      const useSaved = host.auth === 'password' && !enterPassword && !tab.promptForPassword && await api.hosts.hasPassword(host.id);
      if (!tabs.has(tab.id) || tab.closing || vaultStatus.locked) return;
      if(automatic&&!automaticCredential(host.auth,useSaved)) throw new Error('自动重连需要手动输入凭据，请点击连接继续。');
      const credentials = host.auth === 'agent' || (host.auth === 'key' && api.hosts.hasKeyPassphrase) || useSaved ? { secret: '' } : await enterCredential(host, isJump, paneCredentials ? tab : undefined);
      return credentials && { ...credentials, useSaved };
    };
    const jumpCredentials = jumpHost ? await credentialFor(jumpHost, true) : undefined;
    if (jumpHost && !jumpCredentials) { if (tabs.has(tab.id)) updateSession(tab, 'idle', '已取消连接。'); return; }
    if (!tabs.has(tab.id)) return;
    const credentials = await credentialFor(tab.host);
    if (!tabs.has(tab.id) || tab.closing) return;
    if (!credentials || vaultStatus.locked) { updateSession(tab, 'idle', '已取消连接。'); return; }
    tab.usedSavedPassword = credentials.useSaved || jumpCredentials?.useSaved;
    if (enterPassword) tab.promptForPassword = true;
    tab.files.generation = (tab.files.generation || 0) + 1;
    tab.files.entries = undefined;
    tab.files.error = '';
    tab.files.loading = false;
    if (tab.attempts++) tab.rendering.write('\r\n\x1b[90m── 正在建立新 SSH 会话 ──\x1b[0m\r\n');
    if (tab.view.clientHeight) await tab.rendering.fit();
    if (!tabs.has(tab.id)) return;
    await api.ssh.connect({ id: tab.id, expected: tab.host, ...credentials, jump: jumpHost ? { expected: jumpHost, ...jumpCredentials } : undefined, dimensions: { rows: tab.terminal.rows, cols: tab.terminal.cols } });
  } catch (error) {
    if (tabs.has(tab.id)) updateSession(tab, 'closed', message(error));
  }
}

async function openHost(host, { force = false, draftTab, connectNow = true } = {}) {
  if (draftTab && (active !== draftTab || draftTab.kind !== 'new')) return;
  if (connectNow && host.auth === 'key' && !host.keyPath) { if(host.identityId){await manageIdentities();}else await editHost(host,draftTab);return; }
  const sessions = [...tabs.values()].filter((tab) => tab.kind === 'shell' && tab.host.id === host.id);
  const existing = sessions.filter((tab) => ['ready', 'trust', 'connecting'].includes(tab.status)
    && ['address', 'port', 'username', 'auth', 'keyPath', 'jumpHostId', 'identityId', 'identityVersion'].every((field) => tab.host[field] === host[field])
    && (!host.jumpHostId || ['address', 'port', 'username', 'auth', 'keyPath', 'jumpHostId', 'identityId', 'identityVersion'].every((field) => tab.jumpHost?.[field] === hosts.find((item) => item.id === host.jumpHostId)?.[field]))).sort((a, b) => b.used - a.used)[0];
  if (existing && !force && !draftTab) { selectTab(existing); return existing; }
  const tab = draftTab || { id: sessionId() };
  Object.assign(tab, { kind: 'shell', host, status: 'idle', number: Math.max(0, ...sessions.map((entry) => entry.number)) + 1,
    attempts: 0, files: { selected: new Set() } });
  attachTerminal(tab);
  tabs.set(tab.id, tab);
  selectTab(tab);
  if (connectNow) await connect(tab);
  else updateSession(tab, 'idle', '点击「连接」开始 SSH 会话。');
  return tab;
}

async function closeAllTabs() {
  if (closingAllTabs || vaultStatus.locked || dialog.open || fileEditor.open || $('key-dialog').open) return;
  const targets = [...tabs.values()];
  if (!targets.length) return;
  closingAllTabs = true; renderTabs();
  try {
    const ids = new Set(targets.map(tab => tab.id));
    const ongoing = () => [...jobs.values()].filter(job => ids.has(job.sessionId) && ['queued', 'running', 'verifying', 'committing'].includes(job.status));
    if (ongoing().some(job => job.status === 'committing')) { status('文件正在提交，请等待完成后再关闭所有会话。'); return; }
    const transfers = ongoing();
    if (transfers.length && !await confirm('关闭所有会话', `关闭 ${targets.length} 个标签，将中断 ${transfers.length} 项传输，已保存的断点可继续。`, '中断传输并关闭所有')) return;
    if (ongoing().some(job => job.status === 'committing')) { status('文件正在提交，请等待完成后再关闭所有会话。'); return; }
    for (const tab of [...targets.filter(tab => tab.kind === 'command'), ...targets.filter(tab => tab.kind !== 'command')]) {
      if (tabs.has(tab.id)) await closeTab(tab, { confirmed: true });
    }
    if (!tabs.size) status('已关闭所有会话。');
  } finally { closingAllTabs = false; renderTabs(); }
}

async function closeWorkspaceTab(tab) {
  const entry = workspaceEntryFor(tab.id);
  if (!entry?.group) { await closeTab(tab); return; }
  const ongoing = [...jobs.values()].filter(job => entry.panes.includes(job.sessionId) && ['queued', 'running', 'verifying', 'committing'].includes(job.status));
  if (ongoing.some(job => job.status === 'committing')) { status('文件正在提交，请等待完成后再关闭工作区。'); return; }
  if (ongoing.length && !await confirm('关闭分屏工作区', `关闭 ${entry.panes.length} 个会话，将中断 ${ongoing.length} 项传输，已保存的断点可继续。`, '中断传输并关闭')) return;
  for (const id of [...entry.panes]) if (tabs.has(id)) await closeTab(tabs.get(id), { confirmed: true });
}

async function closeTab(tab, options = {}) {
  if (tab.closing || !tabs.has(tab.id)) return;
  tab.closing = true;
  clearTimeout(tab.reconnectTimer);clearTimeout(tab.stableTimer);
  try {
    if (tab.kind === 'shell') {
      const ongoing = [...jobs.values()].filter((job) => job.sessionId === tab.id && ['queued', 'running', 'verifying', 'committing'].includes(job.status));
      if (ongoing.some((job) => job.status === 'committing')) { status('文件正在提交，请等待完成后再关闭会话。'); return; }
      if (ongoing.length && !options.confirmed && !await confirm('关闭 SSH 会话', `「${tab.host.name}」的 ${ongoing.length} 项传输将中断，已保存的断点可继续。`, '中断传输并关闭')) return;
      if (!tabs.has(tab.id)) return;
      await api.ssh.close(tab.id);
    } else if (tab.kind === 'command') {
      await api.commands.close(tab.id);
    }
    removeTab(tab);
  } finally { tab.closing = false; }
}

function removeTab(tab) {
  cancelTabDrag();
  if (!tabs.delete(tab.id)) return;
  tab.cancelCredential?.();
  tab.pendingTransfer = undefined;
  clearTimeout(tab.reconnectTimer);
  clearTimeout(tab.stableTimer);
  const partner = tabs.get(removeSplitPane(tab.id));
  recordingSessions.delete(tab.id);
  tab.tabRow.remove();
  refreshTransferActions(tab.id);
  for (const acknowledge of tab.pendingAcks?.values() || []) acknowledge();
  tab.resizeObserver?.disconnect();
  tab.rendering?.dispose();
  tab.terminal?.dispose();
  tab.view?.remove();
  if (active === tab) selectTab(partner || tabs.get(tab.sessionId) || [...tabs.values()].sort((a, b) => b.used - a.used)[0]);
  else {
    renderSplitLayout();
    renderTabs();
    if (active?.kind === 'new') renderQuickConnect(active);
    if (active?.sessionId === tab.id || active?.id === tab.sessionId) {
      renderContext();
      renderFiles();
      renderServerInfo();
    }
  }
}

function updateSession(tab, next, detail = '') {
  tab.status = next;
  if (next !== 'ready') {
    tab.serverInfo = tab.networkHistory = tab.resourceHistory = tab.diskHistory = undefined;
    tab.serverHistoryPaused = true;
  }
  if(next==='closed')recordingSessions.delete(tab.id);
  renderForwardPanel?.();
  tab.message = detail;
  if (tab.connectionPage) {
    addConnectionLog(tab, detail);
    renderConnectionPage(tab);
  }
  if (next === 'ready') {
    tab.connected = true;
    // Resizes sent during the handshake may arrive before the remote PTY exists.
    syncTerminalSize(tab);
    clearTimeout(tab.stableTimer);tab.stableTimer=setTimeout(()=>{tab.retryCount=0;},30000);
    recent.set(tab.host.id, Date.now());
    void api.hosts.touch(tab.host.id).catch(() => {});
    if (active === tab) status(`${tab.host.name} · SSH 已连接${tab.jumpHost ? `（经 ${tab.jumpHost.name}）` : ''}`);
    focusTerminal(tab);
    if (active?.kind === 'new') renderQuickConnect(active);
    if (filesOpen && origin() === tab) ensureFiles(tab);
  } else if (next === 'closed') {
    clearTimeout(tab.stableTimer);
    tab.paths.reset();
    tab.rendering.write(`\r\n\x1b[90m${detail.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m\r\n`);
  }
  if (active === tab && tab.connectionPage && !tab.connectionPage.hidden) {
    status(`${tab.host.name} · ${detail || sessionLabels[next]}`);
    $('terminal-find').hidden = true;
    renderTerminalBottom();
  }
  if (active === tab || origin() === tab) renderContext();
  if (next === 'ready' && tab.pendingTransfer && active === tab && !dialog.open && !fileEditor.open) void continueTransferAction(tab);
  if (filesOpen && origin() === tab) renderFiles();
  if (origin() === tab) {
    renderServerInfo();
    if (next === 'ready' && serverInfoOpen) void loadServerInfo(tab);
  }
  refreshTransferActions(tab.id);
  renderTabs();
}

async function useLibraryCommand(session, snippet, paste = !/[\r\n]/.test(snippet.command), attempt = session?.attempts) {
  if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。');
  const keys = commandLibrary.parameters(snippet.command);
  if (!keys.length) return useSnippet(session, snippet, paste, attempt);
  const profile = hosts.find(host => host.id === session.host.id) || session.host;
  const values = { path: profile.logPath || '', service: profile.service || 'sshd.service', lines: 100 };
  const fields = [node('p', 'muted', `目标 ${session.host.name} · ${endpoint(session.host)}`)];
  const preview = node('code', 'command-preview');
  const update = () => { try { preview.textContent = commandLibrary.render(snippet.command, values); } catch (error) { preview.textContent = message(error); } };
  for (const key of keys) {
    const control = input(String(values[key]), key === 'lines' ? 'number' : 'text');
    control.required = true;
    if (key === 'lines') { control.min = 1; control.max = 10000; }
    control.addEventListener('input', () => { values[key] = key === 'lines' ? Number(control.value) : control.value; update(); });
    fields.push(field(({ path: '日志文件绝对路径', service: '服务名', lines: '行数' })[key], control));
  }
  update();
  const confirmed = await prompt(snippet.name, [...fields, preview], paste ? '填入终端' : '预览执行', () => {
    if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。');
    commandLibrary.render(snippet.command, values);
    return true;
  });
  if (confirmed) await useSnippet(session, snippet, paste, attempt, values);
}

async function openQuickCommands() {
  const source = active, session = origin(), attempt = session?.attempts;
  const snippets = commandLibrary.sorted(await api.snippets.list());
  if (vaultStatus.locked || active !== source || dialog.open) return;
  const search = input('', 'search');
  search.placeholder = '搜索命令名称、标签和内容'; search.setAttribute('aria-label', search.placeholder);
  const choices = node('div', 'palette-list quick-command-panel');
  let selected, entries = [];
  const choose = action => { selected = action; dialog.close(); };
  const update = () => {
    const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = snippets.filter(s => words.every(word => `${s.name} ${s.command} ${s.tags.join(' ')}`.toLowerCase().includes(word)));
    entries = []; choices.replaceChildren();
    for (const [pinned, label] of [[true, '常用快捷'], [false, '其他命令']]) {
      const group = matches.filter(s => Boolean(s.pinned) === pinned);
      if (!group.length) continue;
      choices.append(node('h3', 'palette-group', label));
      const section = node('div', pinned ? 'quick-command-grid' : 'quick-command-list');
      for (const snippet of group) {
        const multiline = /[\r\n]/.test(snippet.command), parameters = commandLibrary.parameters(snippet.command).length > 0;
        const run = () => useLibraryCommand(session, snippet, !multiline, attempt);
        const control = button('', () => choose(run), `palette-choice ${pinned ? 'quick-command-tile' : 'quick-command-row'}`);
        control.append(summaryText('span', pinned ? snippet.name : `${multiline ? '独立执行' : parameters ? '填写参数' : '填入终端'} · ${snippet.name}`),
          summaryText('small', parameters ? '填写参数后预览' : multiline ? '预览后独立执行' : snippet.command));
        control.disabled = !readySession(session, attempt);
        if (!control.disabled) entries.push(run);
        section.append(control);
      }
      choices.append(section);
    }
    if (!matches.length) choices.append(node('p', 'muted', '没有匹配的命令。'));
    const submit = search.form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !entries.length;
  };
  search.addEventListener('input', update);
  const target = node('p', 'palette-target muted', session ? `命令目标：${session.host.name} · ${endpoint(session.host)}` : '连接主机后可使用命令');
  const selection = prompt('快捷命令', [search, target, choices], '使用首项', () => entries[0],
    [button('管理命令库', () => choose(() => manageSnippets(session)), 'outlined')]);
  wireSearchChoices(search.form, search, choices, '.palette-choice:not(:disabled)');
  update();
  const first = await selection;
  if (!vaultStatus.locked && (selected || first)) await (selected || first)();
  else focusTerminal(source);
}

async function openPalette(scope = 'all') {
  if (scope === 'commands' && api.snippets) return openQuickCommands();
  const source = active;
  const session = origin();
  const attempt = session?.attempts;
  const [snippets, layouts] = await Promise.all([
    api.snippets ? api.snippets.list() : [],
    scope !== 'commands' && api.layouts ? api.layouts.list() : []
  ]);
  if (vaultStatus.locked || active !== source || dialog.open) return;
  const search = input('', 'search');
  const searchLabel = scope === 'commands' ? '搜索内置动作、命令名称、标签和内容' : '搜索主机、会话、命令或工具';
  search.placeholder = searchLabel;
  search.setAttribute('aria-label', searchLabel);
  const choices = node('div', 'palette-list');
  let selected, entries;
  const filters = scope === 'commands' ? undefined : selectionFilters('快捷查找', () => update(), {
    types: [['host','主机'],['session','已有会话'],['layout','会话布局'],['command','命令与会话操作'],['tool','设置与工具']]
  });
  const choose = run => { selected = run; dialog.close(); };
  const update = () => {
    const all = [];
    const types = { '主机':'host', '已打开的会话':'session', '会话布局':'layout', '内置动作':'command', '保存的命令':'command', '命令库':'command', '会话操作':'command' };
    const add = (group, label, detail, run, keywords = '', relatedHosts = []) =>
      all.push({ group, label, detail, run, keywords, type: types[group] || 'tool', relatedHosts });
    if (scope !== 'commands') {
      for (const tab of [...tabs.values()].sort((a,b) => (b.used || 0) - (a.used || 0)))
        add('已打开的会话', tabTitle(tab), [tab.host ? endpoint(tab.host) : '', tab.host?.group,
          sessionLabels[tab.status] || '选择主机'].filter(Boolean).join(' · '), () => {
            if (!tabs.has(tab.id)) throw new Error('这个会话已关闭，请重新搜索。');
            selectTab(tab);
          },
          [tab.host?.name, ...(tab.host?.tags || []), tab.host?.note].filter(Boolean).join(' '), tab.host ? [tab.host] : []);
      for (const host of [...hosts].sort(recentFirst))
        add('主机', host.name, [endpoint(host), host.group, ...(host.tags || [])].filter(Boolean).join(' · '), () => openHost(host), host.note, [host]);
    }
    if (readySession(session, attempt)) {
      for (const [action, label] of Object.entries(actionLabels).filter(([action]) => !api.snippets && action !== 'custom'))
        add('内置动作', label, session.host.name, () => { if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。'); return configureCommand(session, action); }, '', [session.host]);
      for (const snippet of commandLibrary.sorted(snippets)) {
        const keywords = `${snippet.command} ${snippet.tags.join(' ')}`;
        const multiline = /[\r\n]/.test(snippet.command);
        if (!multiline) add('命令库', `填入终端 · ${snippet.name}`, '按回车后执行', () => useLibraryCommand(session, snippet, true, attempt), keywords, [session.host]);
        if (multiline || scope !== 'commands') add('命令库', `独立执行 · ${snippet.name}`, session.host.name, () => useLibraryCommand(session, snippet, false, attempt), keywords, [session.host]);
      }
      add('会话操作', '在新标签连接', session.host.name, () => openHost(session.host, {force: true}), '', [session.host]);
    }
    if (api.snippets) add('工具', '管理命令库', '新增、编辑与整理命令', () => manageSnippets(session));
    if (scope !== 'commands') {
      add('工具', '新建主机', '保存连接信息', () => editHost());
      for (const layout of layouts) {
        const names = layout.tabs.map(tab => tab.title || hosts.find(host => host.id === tab.hostId)?.name || '').join(' ');
        add('会话布局', `打开布局 · ${layout.name}`, sessionLayoutSummary(layout),
          () => openSessionLayout(layout), `会话布局 分屏 ${names}`, layout.tabs.map(tab => hosts.find(host => host.id === tab.hostId)).filter(Boolean));
      }
      if (api.layouts) {
        if (source?.kind === 'shell' && visibleSplitLayout()) add('会话操作', '保存当前会话布局', '保存当前分屏中的会话和排列', saveSessionLayout);
        add('设置', '管理会话布局', '重命名或删除已保存的布局', manageLayouts);
      }
      if (api.logs) add('工具', '会话日志', '查找本机输出记录', manageLogs);
      if (api.preferences) add('工具', '偏好设置', '主题、终端字体与字号', editPreferences);
      add('设置', '安全与同步', '主密码保护、应用锁、加密备份和 Git 同步', () => openSettings('security'), '保险库');
    }
    filters?.refresh([...hosts, ...[...tabs.values()].map(tab => tab.host)]);
    const selectedFilters = filters?.values || {};
    entries = filterCommands(all.filter(entry => (!selectedFilters.type || entry.type === selectedFilters.type) &&
      (!selectedFilters.group || entry.relatedHosts.some(host => matchesHostFilters(host, selectedFilters)))), search.value);
    choices.replaceChildren();
    let group;
    for (const {group: section, label, detail, run} of entries) {
      if (group !== section) { choices.append(node('h3', 'palette-group', section)); group = section; }
      const choice = button('', () => choose(run), 'palette-choice');
      choice.append(summaryText('span', label), summaryText('small', detail));
      choices.append(choice);
    }
    if (!entries.length) choices.append(node('p', 'muted', '没有匹配的结果。'));
    const submit = search.form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !entries.length;
  };
  search.addEventListener('input', update);
  const target = session ? node('p', 'palette-target muted', `命令目标：${session.host.name} · ${endpoint(session.host)}${readySession(session, attempt) ? '' : ' · 连接后可填入命令'}`) : node('p', 'palette-target muted', '连接主机后可粘贴或执行保存的命令');
  const selection = prompt(scope === 'commands' ? '快捷命令' : '快速查找', [search, ...(filters ? [filters.view] : []), target, choices], '打开首项', () => entries[0]?.run);
  wireSearchChoices(search.form, search, choices, '.palette-choice');
  update();
  const first = await selection;
  const run = selected || first;
  if (!vaultStatus.locked && run) await run();
  else focusTerminal(source);
}

function fillTerminalCommand(session, command, attempt) {
  if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。');
  const { terminal } = session;
  if (terminal.buffer.active.type !== 'normal' || terminal.modes.mouseTrackingMode !== 'none') {
    throw new Error('请退出终端中的交互程序后再填入命令。');
  }
  if (active !== session) selectTab(session);
  terminal.paste(command);
  focusTerminal(session);
  status('已填入当前终端 · 确认输入位置和命令后按回车执行');
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
  if (!file) fields.push(node('p', 'muted', '请先让终端停在 Shell 提示符。填入后可修改，再按回车执行。'));
  const details = await prompt(actionLabels[action], [...fields, preview], file ? '打开输出标签' : '填入终端', async () => {
    if (!readySession(session, attempt)) throw new Error('SSH 会话已变化，请重新选择命令。');
    const command = request();
    return { request: command, preview: await api.commands.preview(command) };
  });
  if (!details || !readySession(session, attempt)) { focusTerminal(source); return; }
  if (!file) { fillTerminalCommand(session, details.preview, attempt); return; }
  await openFileCommandOutput(session, details.request, details.preview);
}

async function openFileCommandOutput(session, request, preview) {
  const { action } = request;
  const tab = { id: sessionId(), kind: 'command', sessionId: session.id, host: session.host, action, status: 'connecting' };
  attachTerminal(tab);
  tab.rendering.write(`\x1b[90m$ ${preview}\x1b[0m\r\n`);
  tabs.set(tab.id, tab);
  selectTab(tab);
  try { await api.commands.start({ id: tab.id, sessionId: session.id, request }); }
  catch (error) {
    if (!tabs.has(tab.id)) return;
    updateSession(tab, 'failed', message(error));
    if (active === session) status(`${actionLabels[action]}失败 · ${message(error)}`);
  }
}

function toggleFiles() {
  filesOpen = !filesOpen;
  if (filesOpen) serverInfoOpen = false;
  renderServerInfo();
  renderContext();
  renderFiles();
  if (filesOpen) ensureFiles(origin());
  else focusTerminal(active);
}

function toggleServerInfo() {
  serverInfoOpen = !serverInfoOpen;
  if (serverInfoOpen) filesOpen = false;
  renderContext();
  renderFiles();
  renderServerInfo();
  if (serverInfoOpen) {
    void loadServerInfo(origin(), true);
    $('server-info').querySelector('button')?.focus({ preventScroll: true });
  } else {
    $('session-actions').querySelector('[aria-controls="server-info"]')?.focus({ preventScroll: true });
  }
}

function stopServerInfoRefresh() {
  if (serverInfoRefresh) {
    clearInterval(serverInfoRefresh.timer);
    serverInfoRefresh.tab.serverHistoryPaused = true;
  }
  serverInfoRefresh = undefined;
}

function syncServerInfoRefresh(tab, open) {
  if (!open || !readySession(tab)) { stopServerInfoRefresh(); return; }
  const attempt = tab.attempts;
  if (serverInfoRefresh?.tab === tab && serverInfoRefresh.attempt === attempt) return;
  stopServerInfoRefresh();
  const refresh = { tab, attempt };
  refresh.timer = setInterval(() => {
    if (serverInfoRefresh !== refresh) return;
    if (!serverInfoOpen || $('server-info').hidden || origin() !== tab || !readySession(tab, attempt)) {
      stopServerInfoRefresh();
      return;
    }
    // loadServerInfo coalesces requests if a previous sample is still in flight.
    void loadServerInfo(tab, true);
  }, 5000);
  serverInfoRefresh = refresh;
}

async function loadServerInfo(tab, refresh = false) {
  if (!readySession(tab)) return;
  if (tab.serverInfo?.loading || (!refresh && tab.serverInfo)) return;
  const attempt = tab.attempts;
  const refreshRun = serverInfoRefresh;
  const collecting = () => refreshRun && serverInfoRefresh === refreshRun && serverInfoOpen &&
    origin() === tab && !$('server-info').hidden;
  const state = { ...tab.serverInfo, loading: true, error: '' };
  tab.serverInfo = state;
  if (origin() === tab) renderServerInfo();
  try {
    const source = await api.ssh.serverInfo(tab.id);
    if (!readySession(tab, attempt) || tab.serverInfo !== state) return;
    state.data = window.serverInfo.parse(source);
    state.at = new Date();
    if (collecting()) {
      tab.networkHistory = window.serverInfo.appendNetworkHistory(tab.networkHistory,
        state.data.network, state.at.getTime(), tab.serverHistoryPaused);
      tab.resourceHistory = window.serverInfo.appendResourceHistory(tab.resourceHistory,
        state.data, state.at.getTime(), tab.serverHistoryPaused);
      tab.diskHistory = window.serverInfo.appendDiskHistory(tab.diskHistory,
        state.data.diskIo, state.at.getTime(), tab.serverHistoryPaused);
      tab.serverHistoryPaused = false;
    }
  } catch (error) {
    if (!readySession(tab, attempt) || tab.serverInfo !== state) return;
    state.error = message(error);
    if (collecting()) tab.serverHistoryPaused = true;
  } finally {
    if (tab.serverInfo === state) {
      state.loading = false;
      if (origin() === tab) renderServerInfo();
    }
  }
}

function renderServerInfo() {
  const panel = $('server-info');
  const tab = origin();
  const open = serverInfoOpen && Boolean(tab) && !vaultStatus.locked &&
    (!active.connectionPage || active.connectionPage.hidden);
  panel.hidden = panel.inert = !open;
  workspace.dataset.serverInfo = open ? 'open' : 'closed';
  syncServerInfoRefresh(tab, open);
  if (!open) return;
  const scrollTop = panel.dataset.session === tab.id ? panel.querySelector('.server-info-body')?.scrollTop || 0 : 0;
  const networkExpanded = panel.dataset.session === tab.id && Boolean(panel.querySelector('.server-network-others')?.open);
  const networkFocused = panel.dataset.session === tab.id &&
    panel.querySelector('.server-network-others summary') === document.activeElement;
  const state = tab.serverInfo || {};
  const refresh = button('刷新', () => loadServerInfo(tab, true), 'outlined', '刷新服务器信息');
  refresh.disabled = state.loading || !readySession(tab);
  const close = button('×', toggleServerInfo, 'file-icon-button', '关闭服务器信息');
  const heading = node('header', 'file-heading', chromeIcon('server'),
    node('div', 'file-heading-title', node('strong', '', '服务器信息'), summaryText('small', tab.host.name)), refresh, close);
  // Keep header controls mounted while sampling so keyboard focus survives refresh.
  const oldHeader = panel.querySelector('header');
  if (oldHeader && panel.dataset.session === tab.id) {
    oldHeader.querySelector('[aria-label="刷新服务器信息"]').disabled = refresh.disabled;
  } else {
    panel.replaceChildren(heading);
    panel.dataset.session = tab.id;
  }
  panel.querySelector('.server-info-body')?.remove();
  const body = node('div', 'server-info-body');
  panel.append(body);
  const feedback = node('p', state.error ? 'danger' : 'muted',
    !readySession(tab) ? '连接 SSH 后可查看服务器信息。' : state.error ? `采集失败：${state.error}` : state.loading && !state.data
      ? '正在采集服务器信息…' : state.at ? `更新于 ${state.at.toLocaleTimeString()} · 每 5 秒自动刷新` : '准备采集…');
  feedback.setAttribute('role', 'status');
  body.append(feedback);
  const data = state.data;
  if (!data || !readySession(tab)) return;
  if (state.error) body.append(node('p', 'muted', '以下为上次成功采集的数据。'));
  const row = (label, value) => node('div', 'server-info-row', node('dt', '', label), node('dd', '', value || '暂不可用'));
  const card = (label, ...content) => node('section', 'server-info-card', node('h3', '', label), ...content);
  const details = (...content) => node('dl', 'server-info-details', ...content);
  const size = value => Number.isFinite(value) ? bytes(value) : '暂不可用';
  const usage = (label, value, detail) => {
    const known = Number.isFinite(value);
    const bar = node('div', 'server-info-meter', node('span'));
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', label);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuetext', known ? `${value.toFixed(1)}%` : '暂不可用');
    if (known) bar.setAttribute('aria-valuenow', String(value));
    else bar.classList.add('unavailable');
    bar.firstChild.style.width = `${known ? value : 0}%`;
    if (value >= 90) bar.classList.add('high');
    return node('div', 'server-info-usage', node('div', 'server-info-value',
      node('span', '', label), node('strong', '', known ? `${value.toFixed(1)}%` : '暂不可用')), bar,
    ...(detail ? [node('small', 'muted', detail)] : []));
  };
  const uptime = Number.isFinite(data.uptime)
    ? `${Math.floor(data.uptime / 86400)} 天 ${Math.floor(data.uptime % 86400 / 3600)} 小时 ${Math.floor(data.uptime % 3600 / 60)} 分钟` : '';
  body.append(card('系统', details(row('主机名', data.hostname), row('系统', data.os),
    row('内核', data.kernel), row('架构', data.architecture), row('运行时间', uptime))),
  card('CPU', usage('CPU 使用率', data.cpuPercent), resourceHistoryChart(tab.resourceHistory, 'cpu'), details(row('型号', data.cpuModel),
    row('逻辑核心', data.cpuCount ? `${data.cpuCount} 核` : ''), row('负载 · 1 / 5 / 15 分钟', data.load))),
  card('内存', usage('内存使用率', data.memory.percent,
    `已用 ${size(data.memory.used)} / 总计 ${size(data.memory.total)}`),
    resourceHistoryChart(tab.resourceHistory, 'memory'),
    details(row('可用内存', size(data.memory.available)),
      row('交换空间', data.swap.total === undefined ? '暂不可用' : data.swap.total === 0 ? '未配置' : `${size(data.swap.used)} / ${size(data.swap.total)}`)),
    node('small', 'muted', data.platform === 'Darwin' ? '可用内存按空闲与非活跃页估算。' : '已用内存按总量减可用量计算，包含可回收缓存的估算。')));
  const network = card('网络');
  if (!data.network.length) network.append(node('p', 'muted', '暂未获取到网络信息。'));
  const networkEntry = entry => {
    const speed = (label, value) => node('div', 'server-network-speed', node('span', 'muted', label),
      node('strong', '', window.serverInfo.formatNetworkBytes(value, true)));
    return node('div', 'server-info-network', node('strong', '', entry.name),
      node('div', 'server-network-speeds', speed('↓ 下行（接收）', entry.downloadRate), speed('↑ 上行（发送）', entry.uploadRate)),
      networkHistoryChart(tab.networkHistory, entry.name),
      details(row('累计接收', window.serverInfo.formatNetworkBytes(entry.received)),
        row('累计发送', window.serverInfo.formatNetworkBytes(entry.sent))));
  };
  if (data.network.length) network.append(networkEntry(data.network[0]));
  if (data.network.length > 1) {
    const others = node('details', 'server-network-others', node('summary', '', `其他网卡（${data.network.length - 1}）`),
      node('div', 'server-network-other-list', ...data.network.slice(1).map(networkEntry)));
    others.open = networkExpanded;
    network.append(others);
  }
  network.append(node('small', 'muted', '速度为本次约 1 秒采样均值；累计为网卡计数，不含回环接口。'));
  body.append(network);
  const diskIo = card('磁盘读写');
  if (!data.diskIo.length) diskIo.append(node('p', 'muted', '暂未获取到磁盘读写信息。'));
  for (const entry of data.diskIo) {
    const speed = (label, value) => node('div', 'server-network-speed', node('span', 'muted', label),
      node('strong', '', window.serverInfo.formatNetworkBytes(value, true)));
    diskIo.append(node('div', 'server-info-disk-io', node('strong', '', entry.name),
      node('div', 'server-network-speeds', speed('读取', entry.readRate), speed('写入', entry.writeRate)),
      diskHistoryChart(tab.diskHistory, entry.name),
      node('div', 'server-network-speeds',
        node('div', 'server-network-speed', node('span', 'muted', 'IOPS（读写合计）'), node('strong', '', formatIops(entry.iops))),
        node('div', 'server-network-speed', node('span', 'muted', 'I/O 利用率'), node('strong', '', formatUtilization(entry.utilization)))),
      diskMetricHistoryChart(tab.diskHistory, entry.name, 'iops'),
      diskMetricHistoryChart(tab.diskHistory, entry.name, 'utilization'),
      node('div', 'server-network-speeds',
        node('div', 'server-network-speed', node('span', 'muted', '平均读取延迟'), node('strong', '', formatDiskDetail(entry.readLatency, 'ms'))),
        node('div', 'server-network-speed', node('span', 'muted', '平均写入延迟'), node('strong', '', formatDiskDetail(entry.writeLatency, 'ms')))),
      diskLatencyHistoryChart(tab.diskHistory, entry.name),
      node('div', 'server-network-speed', node('span', 'muted', '平均 I/O 队列长度'), node('strong', '', formatDiskDetail(entry.queueLength, '个请求'))),
      diskMetricHistoryChart(tab.diskHistory, entry.name, 'queueLength')));
  }
  diskIo.append(node('small', 'muted', '速度为本次约 1 秒采样均值；按块设备分别显示，不加总或重复统计分区。'));
  diskIo.append(node('small', 'muted', 'IOPS 为每秒完成的读写次数；I/O 利用率按设备忙碌时间占比计算。'));
  diskIo.append(node('small', 'muted', '延迟按采样期完成请求的平均耗时计算，无对应完成请求时暂不可用；队列长度为同期平均在途请求数。'));
  if (data.platform === 'Darwin') diskIo.append(node('small', 'muted', '当前系统未提供设备忙碌时间与加权在途时间，I/O 利用率和平均队列长度暂不可用。'));
  body.append(diskIo);
  const storage = card('存储 · 本地文件系统');
  if (!data.disks.length) storage.append(node('p', 'muted', '暂未获取到存储信息。'));
  for (const disk of data.disks) storage.append(node('div', 'server-info-disk',
    node('strong', '', disk.mount), node('small', 'muted', disk.device),
    usage('存储使用率', disk.percent, `已用 ${size(disk.used)} / 总计 ${size(disk.total)} · 可用 ${size(disk.available)}`)));
  body.append(storage);
  if (networkFocused) panel.querySelector('.server-network-others summary')?.focus({ preventScroll: true });
  body.scrollTop = scrollTop;
}

function networkHistoryChart(history, name) {
  const model = window.serverInfo.networkChartModel(history, name);
  return historyChart(history, model, { name, description: `${name} 最近 5 分钟上下行速度曲线`,
    format: value => window.serverInfo.formatNetworkBytes(value, true),
    series: [
      { type: 'download', label: '下行', key: 'downloadRate', segments: model.download, peak: model.downloadPeak },
      { type: 'upload', label: '上行', key: 'uploadRate', segments: model.upload, peak: model.uploadPeak }
    ] });
}

function diskHistoryChart(history, name) {
  const model = window.serverInfo.diskChartModel(history, name);
  const figure = historyChart(history, model, { name, description: `${name} 最近 5 分钟磁盘读写速度曲线`,
    format: value => window.serverInfo.formatNetworkBytes(value, true),
    series: [
      { type: 'download', label: '读取', key: 'readRate', segments: model.read, peak: model.readPeak },
      { type: 'upload', label: '写入', key: 'writeRate', segments: model.write, peak: model.writePeak }
    ] });
  figure.classList.add('server-disk-chart');
  return figure;
}

function formatIops(value) {
  if (!Number.isFinite(value)) return '暂不可用';
  const scale = value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return `${Number((value / scale).toFixed(1))} ${scale === 1e6 ? 'M' : scale === 1e3 ? 'k' : ''}IOPS`;
}

function formatUtilization(value) {
  return Number.isFinite(value) ? `${Number(value.toFixed(1))}%` : '暂不可用';
}

function formatDiskDetail(value, unit) {
  if (!Number.isFinite(value)) return '暂不可用';
  return `${value > 0 && value < .001 ? '<0.001' : Number(value.toFixed(3))} ${unit}`;
}

function diskLatencyHistoryChart(history, name) {
  const model = window.serverInfo.diskLatencyChartModel(history, name);
  const figure = historyChart(history, model, { name, description: `${name} 最近 5 分钟平均读写延迟曲线`,
    format: value => formatDiskDetail(value, 'ms'), emptyText: '暂无有效延迟采样',
    series: [
      { type: 'download', label: '读取延迟', key: 'readLatency', segments: model.read, peak: model.readPeak },
      { type: 'upload', label: '写入延迟', key: 'writeLatency', segments: model.write, peak: model.writePeak }
    ] });
  figure.classList.add('server-disk-latency-chart');
  return figure;
}

function diskMetricHistoryChart(history, name, metric) {
  const model = window.serverInfo.diskMetricChartModel(history, name, metric);
  const { label, format } = {
    iops: { label: 'IOPS', format: formatIops },
    utilization: { label: 'I/O 利用率', format: formatUtilization },
    queueLength: { label: '平均 I/O 队列长度', format: value => formatDiskDetail(value, '个请求') }
  }[metric];
  const figure = historyChart(history, model, { name, description: `${name} 最近 5 分钟${label}曲线`,
    format,
    series: [{ type: 'download', label, key: metric, segments: model.series, peak: model.peak }],
    emptyText: `暂无有效${label}采样` });
  figure.classList.add('server-disk-metric-chart');
  figure.dataset.diskMetric = metric;
  return figure;
}

function resourceHistoryChart(history, metric) {
  const model = window.serverInfo.resourceChartModel(history, metric);
  const label = metric === 'cpu' ? 'CPU' : '内存';
  const figure = historyChart(history, model, { name: metric, description: `${label} 最近 5 分钟使用率曲线`,
    format: value => Number.isFinite(value) ? `${Number(value.toFixed(1))}%` : '暂不可用',
    series: [{ type: 'download', label: '使用率', key: 'percent', segments: model.series, peak: model.peak }] });
  figure.classList.add('server-usage-chart');
  figure.dataset.metric = metric;
  return figure;
}

function historyChart(history, model, { name, description, format, series, emptyText = '等待有效采样以绘制曲线' }) {
  const figure = node('figure', 'server-network-chart');
  const legend = (label, type) => node('span', `network-chart-key ${type}`, node('i'), label);
  figure.append(node('figcaption', '', node('span', '', '最近 5 分钟'),
    node('span', 'network-chart-legend', ...series.map(entry => legend(entry.label, entry.type)))));
  const svgElement = (tag, attributes = {}) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  };
  const svg = svgElement('svg', { viewBox: '0 0 300 112', preserveAspectRatio: 'none', role: 'img',
    'aria-label': `${description}，${model.count} 个采样点；${series.map(entry => `${entry.label}峰值 ${format(entry.peak)}`).join('，')}` });
  const x = at => 2 + (at - model.start) / (model.end - model.start) * 296;
  const y = value => 108 - value / model.maximum * 104;
  for (const value of [0, model.maximum / 2, model.maximum]) {
    svg.append(svgElement('line', { x1: 0, x2: 300, y1: y(value), y2: y(value), class: 'network-chart-grid', 'vector-effect': 'non-scaling-stroke' }));
  }
  for (const { type, segments } of series) {
    const path = segments.map(segment => segment.map((point, index) =>
      `${index ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')).join(' ');
    svg.append(svgElement('path', { d: path, class: `network-chart-line ${type}`, 'vector-effect': 'non-scaling-stroke' }));
    for (const segment of segments) {
      const point = segment.at(-1);
      svg.append(svgElement('circle', { cx: x(point.at), cy: y(point.value), r: 2.5,
        class: `network-chart-dot ${type}` }));
    }
  }
  for (const sample of history || []) {
    const value = sample.values[name];
    if (sample.at < model.start || sample.at > model.end || !value) continue;
    const hit = svgElement('rect', { x: x(sample.at) - 2, y: 0, width: 4, height: 112, fill: 'transparent' });
    const title = svgElement('title');
    title.textContent = `${new Date(sample.at).toLocaleTimeString()} · ${series.map(entry => `${entry.label} ${format(value[entry.key])}`).join(' · ')}`;
    hit.append(title);
    svg.append(hit);
  }
  const axis = node('div', 'network-chart-y', ...[model.maximum, model.maximum / 2, 0].map(value =>
    node('span', '', model.count ? format(value) : '—')));
  figure.append(node('div', 'network-chart-plot', axis, svg),
    node('div', 'network-chart-x', node('span', '', '5 分钟前'), node('span', '', '现在')),
    node('small', 'muted network-chart-note', model.count ? `${model.count} 个采样点 · 空档为未采集时段` : emptyText));
  figure.dataset.samples = model.count;
  return figure;
}

function readySession(tab, attempt = tab?.attempts) {
  return !vaultStatus.locked && tab?.status === 'ready' && tabs.get(tab.id) === tab && tab.attempts === attempt;
}

function renderTerminalBottom() {
  const control = $('terminal-bottom');
  const buffer = active?.terminal?.buffer.active;
  control.hidden = Boolean(active?.connectionPage && !active.connectionPage.hidden) ||
    !buffer || buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY;
  if (control.hidden && active) active.newOutput = false;
  control.textContent = active?.newOutput ? '有新输出 · 回到底部 ↓' : '回到底部 ↓';
}

async function currentTerminalDirectory(tab) {
  const reported = tab.paths.uploadDirectory;
  if (reported) return reported;
  const probed = await api.ssh.directory?.(tab.id);
  return terminalPaths.absolute(probed) ? probed : undefined;
}

async function openLinkedTerminalPath(source, path, text, mayProbe = true) {
  if (path) return openTerminalPath(source, path);
  const tab = origin(source);
  if (active !== source || !readySession(tab) || dialog.open || fileEditor.open) return;
  const attempt = tab.attempts;
  const directory = mayProbe && source === tab ? await currentTerminalDirectory(tab) : undefined;
  if (active !== source || !readySession(tab, attempt) || dialog.open || fileEditor.open) return;
  const resolved = terminalPaths.resolve(text, directory);
  if (resolved) return openTerminalPath(source, resolved);
  return chooseTerminalPath(source, text, directory || '');
}

async function chooseTerminalPath(source = active, selected, knownDirectory) {
  const tab = origin(source);
  if (!readySession(tab) || active !== source || dialog.open) return;
  const attempt = tab.attempts;
  const directory = knownDirectory ?? (source === tab && !terminalPaths.absolute(selected) ? await currentTerminalDirectory(tab) : undefined);
  if (active !== source || !readySession(tab, attempt) || dialog.open) return;
  const value = input(selected ? terminalPaths.resolve(selected, directory) || selected : directory);
  value.placeholder = '/var/log/app.log';
  const fields = [field('路径', value),
    node('p', 'muted', `可按住 ${keyboard.modifier} 单击路径，也可选中文字后右键打开此窗口。请核对远端路径。`)];
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
  if (active !== source || !readySession(tab) || dialog.open || fileEditor.open) return;
  const attempt = tab.attempts;
  const { path, kind, downloadable } = inspected || await api.files.inspect({ id: tab.id, path: candidate });
  if (active !== source || !readySession(tab, attempt) || dialog.open || fileEditor.open) return;

  const detail = node('p', '', endpoint(tab.host), ' · ', node('code', '', path));
  const downloadPath = () => downloadRemotePath(tab, attempt, path);
  if (kind === 'file') {
    if (api.files.readText) openRemoteFile(tab, path);
    else if (await prompt('远端文件', [detail], '下载', () => true, [], { focusHeading: true, cancelLast: true })) await downloadPath();
  } else if (kind === 'directory') {
    const enter = node('button', 'outlined', '进入');
    const download = node('button', 'outlined', '下载');
    enter.type = download.type = 'submit';
    enter.value = 'enter';
    download.value = 'download';
    download.disabled = path === '/' || !downloadable || !api.files.directoryDownloads;
    if (download.disabled) download.title = '当前路径不支持目录下载';
    const choice = await prompt('远端目录', [detail], '文件区打开', async (action) => {
      if (action === 'enter') await enterTerminalDirectory(tab, attempt, path);
      return action || 'browse';
    }, [enter, download], { focusHeading: true, cancelLast: true });
    if (!readySession(tab, attempt) || active !== source) return;
    if (choice === 'download') await downloadPath();
    else if (choice === 'enter') {
      if (active !== tab) selectTab(tab);
      focusTerminal(tab);
    } else if (choice === 'browse') {
      filesOpen = true;
      serverInfoOpen = false;
      renderServerInfo();
      renderContext();
      await loadFiles(tab, path);
    }
  } else {
    status('该路径是链接或特殊文件。');
  }
}

async function enterTerminalDirectory(tab, attempt, path) {
  const { paths } = tab;
  const unconfirmed = '请让终端停在空的 Shell 提示符，再进入目录。';
  if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新选择路径。');
  if (tab.pendingAcks?.size) throw new Error(unconfirmed);
  if (!paths.emptyPrompt) {
    // Without a shell integration marker, verify the foreground shell as well as
    // the rendered prompt so password prompts and unfinished input stay intact.
    const prompt = paths.visiblePrompt;
    if (!prompt || !terminalPaths.absolute(await api.ssh.directory?.(tab.id)) ||
        prompt !== paths.visiblePrompt || tab.pendingAcks?.size) throw new Error(unconfirmed);
  }
  if (!dialog.open || !readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新选择路径。');
  const command = `cd -- '${path.replaceAll("'", "'\\''")}'\r`;
  tab.terminal.input(command, true);
}

function downloadRemotePath(tab, attempt, path) {
  if (!readySession(tab, attempt)) return;
  const split = path.lastIndexOf('/');
  return prepareTransfer(tab, 'down', [path.slice(split + 1)], { directory: path.slice(0, split) || '/' });
}

function openRemoteFile(tab, path, trigger) {
  if (origin() !== tab || !readySession(tab) || dialog.open || fileEditor.open) return;
  const source = active;
  const attempt = tab.attempts;
  const lifetime = new AbortController();
  let view, editor, savedFile, revision, remotePath, formatRequest;
  let editing = false, busy = false, conflict = false, comparison, reviewed;
  const title = summaryText('h2', path.split('/').at(-1));
  title.id = 'file-editor-title';
  title.tabIndex = -1;
  title.setAttribute('autofocus', '');
  const location = summaryText('p', `${endpoint(tab.host)} · ${path}`);
  const content = node('div', 'file-editor-content');
  content.hidden = true;
  const notice = node('p', 'muted', '正在读取远端文件…');
  notice.setAttribute('role', 'status');
  const mode = node('span', 'file-editor-mode');
  const modified = node('span', 'file-editor-modified', '未保存');
  const position = node('span', 'file-editor-position');
  const format = node('span', 'file-editor-format');
  const ending = node('span');
  const modes = node('select');
  const languagePicker = selectControl(modes, '文件语言', { searchable: true, align: 'end', placeholder: '搜索文件语言' });
  languagePicker.hidden = true;
  modes.addEventListener('change', () => { view.setFormat(modes.value); refresh(); });
  const dirty = () => editing && (Boolean(reviewed) || !view.matches(savedFile));
  const comparePanel = node('div', 'file-editor-content file-comparison');
  const compareBody = node('div', 'file-comparison-body');
  const compareNotice = node('span', '', '远端文件已更改。核对差异后可继续保存。');
  const compareButton = button('查看差异', openComparison, 'outlined');
  const compareBar = node('div', 'file-conflict-bar', compareNotice, compareButton);
  function leaveComparison(accepted) {
    comparison.destroy();
    comparison = undefined;
    conflict = !accepted;
    comparePanel.hidden = true;
    content.hidden = false;
    heading.hidden = false;
    notice.textContent = accepted ? '已核对远端版本，点击保存提交草稿。' : '草稿已保留，保存前请完成对比。';
    refresh();
    editor.focus();
  }
  const remoteLabel = node('strong');
  const draftLabel = node('strong');
  const finishComparison = button('完成对比', () => leaveComparison(true), 'primary');
  comparePanel.append(node('div', 'file-comparison-actions', title.textContent, node('div', 'file-tools',
    button('返回编辑', () => leaveComparison(false), 'outlined'), finishComparison)),
    node('div', 'file-comparison-labels', remoteLabel, draftLabel), compareBody);
  comparePanel.hidden = compareBar.hidden = true;
  async function openComparison() {
    if (busy || !editing || !conflict || comparison) return;
    busy = true;
    refresh();
    try {
      if (!readySession(tab, attempt)) throw new Error('原 SSH 会话已断开，草稿仍可复制。');
      const latest = await api.files.readText({ id: tab.id, path: remotePath });
      if (!content.isConnected) return;
      if (!readySession(tab, attempt) || latest.path !== remotePath) throw new Error('连接目标已变化，草稿已保留。');
      if (latest.tooLarge) throw new Error('远端文件已超过 4 MiB，无法就地对比。草稿已保留。');
      view.search(false);
      toggleJump(false);
      comparePanel.hidden = false;
      content.hidden = true;
      heading.hidden = true;
      const breaks = new Set(latest.text.match(/\r\n|\r|\n/g));
      const ending = breaks.size > 1 ? '混合换行' : breaks.has('\r\n') ? 'CRLF' : breaks.has('\r') ? 'CR' : 'LF';
      remoteLabel.textContent = `远端最新版本 · 只读 · ${ending}`;
      draftLabel.textContent = `我的草稿 · 可编辑 · ${view.lineEnding}`;
      comparison = view.compare(compareBody, latest.text);
      reviewed = latest;
    } catch (error) {
      heading.hidden = false;
      content.hidden = false;
      comparePanel.hidden = true;
      notice.textContent = message(error);
    } finally { busy = false; refresh(); }
  }
  function action(icon, label, run, tooltip = label, primary = false) {
    const control = button(label, run, primary ? 'primary' : '', label);
    control.replaceChildren(chromeIcon(icon), node('span', '', label));
    control.title = tooltip;
    return control;
  }
  function syncMode() {
    fileEditor.dataset.mode = editing ? 'edit' : 'preview';
    mode.replaceChildren(chromeIcon(editing ? 'edit' : 'eye'), editing ? '编辑中' : '只读预览');
    position.hidden = !editing;
    edit.hidden = close.hidden = editing;
    undo.hidden = redo.hidden = save.hidden = cancel.hidden = !editing;
    search.title = editing ? `查找或替换 (${keyboard.label('F')})` : `查找 (${keyboard.label('F')})`;
    refresh();
  }
  function refresh() {
    edit.disabled = !view || busy;
    save.disabled = !editing || busy || conflict || Boolean(formatRequest);
    compareBar.hidden = !editing || !conflict || Boolean(comparison);
    compareButton.disabled = busy || Boolean(formatRequest);
    close.disabled = cancel.disabled = busy;
    undo.disabled = !editing || busy || !view?.canUndo;
    redo.disabled = !editing || busy || !view?.canRedo;
    download.disabled = busy;
    search.disabled = go.disabled = wrap.disabled = !view;
    prettify.disabled = !editing || busy || Boolean(formatRequest) || !view?.parser;
    prettify.title = !editing ? '进入编辑后可格式化' : view?.parser ? '格式化当前文件 (Shift+Alt+F)' : `${view.format} 暂无可用的格式化工具`;
    modified.hidden = !dirty();
    if (view) ending.textContent = view.lineEnding;
  }
  function preview(messageText) {
    formatRequest?.abort();
    formatRequest = undefined;
    editing = false;
    jumpRow.hidden = true;
    go.setAttribute('aria-pressed', 'false');
    view.preview(savedFile);
    notice.textContent = messageText;
    syncMode();
    editor.focus();
  }
  const edit = action('edit', '编辑', () => {
    if (!view || editing || busy) return;
    view.search(false);
    view.writable(true);
    editing = true;
    notice.textContent = '';
    syncMode();
    editor.focus();
  }, '编辑当前文件', true);
  const save = action('check', '保存', async () => {
    if (!editing || busy || formatRequest) return;
    if (conflict || comparison) return;
    if (!dirty() && !reviewed) { preview(''); return; }
    const snapshot = view.snapshot();
    busy = true;
    view.writable(false);
    refresh();
    notice.textContent = '正在保存…';
    try {
      if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化。请重新打开文件后合并更改。');
      const result = await api.files.saveText({ id: tab.id, path: remotePath, text: view.serialize(), revision: reviewed?.revision ?? revision });
      if (!content.isConnected) return;
      if (result.conflict) {
        reviewed = undefined;
        conflict = true;
        view.writable(true);
        notice.textContent = '保存前需要核对远端版本';
        compareButton.focus();
        return;
      }
      reviewed = undefined;
      savedFile = snapshot;
      revision = result.revision;
      const entry = tab.files.entries?.find(item => item.kind === 'file' && pathOf(tab, item.name) === path);
      if (entry && Number.isFinite(result.size)) {
        entry.size = result.size;
        if (origin() === tab && filesOpen) {
          renderFiles();
          if (trigger) trigger = [...$('files').querySelectorAll('.file-entry-file')].find(row => row.getAttribute('aria-label') === entry.name);
        }
      }
      preview('已保存到远端');
    } catch (error) {
      view.writable(true);
      notice.textContent = message(error);
      editor.focus();
    } finally { busy = false; refresh(); }
  }, `保存到远端 (${keyboard.label('S')})`, true);
  save.setAttribute('aria-keyshortcuts', keyboard.aria('S'));
  const cancel = action('close', '取消', async () => {
    if (!editing || busy || dialog.open) return;
    // A formatter finishing while the user decides must not replace the draft.
    formatRequest?.abort();
    formatRequest = undefined;
    refresh();
    if (dirty()) {
      const discard = await prompt('放弃未保存的修改？', [node('p', '', `「${title.textContent}」的修改尚未保存到远端。`)],
        '放弃修改', () => true, [], { cancelLabel: '继续编辑' });
      if (!content.isConnected) return;
      if (!discard) { notice.textContent = ''; editor.focus(); return; }
    }
    if (conflict && !reviewed && readySession(tab, attempt)) {
      busy = true;
      refresh();
      try {
        const latest = await api.files.readText({id: tab.id, path: remotePath});
        if (!content.isConnected) return;
        if (!latest.tooLarge && latest.path === remotePath) reviewed = latest;
      } catch { /* The original preview is still available offline. */ }
      finally { busy = false; }
    }
    const stale = conflict && !reviewed;
    conflict = false;
    if (reviewed) {
      const latest = reviewed;
      reviewed = undefined;
      editor.destroy();
      mountFile(latest);
    }
    preview(stale ? '显示打开时的版本' : '');
  }, '取消编辑，返回预览');
  const close = action('close', '关闭', () => { if (!editing && !busy) fileEditor.close(); });
  const download = action('import', '下载', async () => {
    if (busy) return;
    busy = true;
    refresh();
    try { await downloadRemotePath(tab, attempt, path); }
    catch (error) { notice.textContent = message(error); }
    finally { busy = false; refresh(); }
  }, '下载远端已保存的文件');
  const prettify = action('format', '格式化', async () => {
    if (!editing || busy || formatRequest || !view.parser) return;
    const request = new AbortController();
    formatRequest = request;
    const original = editor.state.doc;
    const text = original.toString();
    const parser = view.parser;
    editor.focus();
    refresh();
    notice.textContent = '正在格式化…';
    try {
      const result = await window.TermlumeFileEditor.formatDocument({
        text, parser, path: remotePath, cursor: editor.state.selection.main.head
      }, request.signal);
      if (request.signal.aborted) return;
      if (editor.state.doc !== original || view.parser !== parser) notice.textContent = '内容或语言已更改，请重新格式化';
      else if (result.formatted === text) notice.textContent = '格式已规范';
      else { view.applyFormat(result.formatted, result.cursor); notice.textContent = '已格式化，可撤销'; }
    } catch (error) {
      if (!request.signal.aborted) notice.textContent = `格式化失败 · ${message(error)}`;
    } finally {
      if (formatRequest === request) { formatRequest = undefined; refresh(); }
    }
  });
  prettify.setAttribute('aria-keyshortcuts', 'Alt+Shift+F');

  const undo = action('undo', '撤销', () => view.undo(), `撤销 (${keyboard.label('Z')})`);
  undo.setAttribute('aria-keyshortcuts', keyboard.aria('Z'));
  const redoKey = keyboard.isMac ? 'Z' : 'Y';
  const redo = action('redo', '恢复', () => view.redo(), `恢复 (${keyboard.label(redoKey, keyboard.isMac)})`);
  redo.setAttribute('aria-keyshortcuts', keyboard.aria(redoKey, keyboard.isMac));

  const search = action('search', '查找', () => {
    toggleJump(false);
    const open = search.getAttribute('aria-pressed') !== 'true';
    view.search(open);
    if (!open) editor.focus();
  });
  search.setAttribute('aria-keyshortcuts', keyboard.aria('F'));
  const go = action('jump', '跳行', () => toggleJump(jumpRow.hidden), '跳转到行 (Ctrl+G)');
  const enableWrapHint = '开启自动换行，超出编辑区宽度的文字会折行显示';
  const wrap = action('wrap', '自动换行', () => {
    const enabled = wrap.getAttribute('aria-pressed') !== 'true';
    wrap.setAttribute('aria-pressed', String(enabled));
    wrap.title = enabled ? '关闭自动换行，左右滚动查看长行' : enableWrapHint;
    view.wrap(enabled);
  }, enableWrapHint);
  for (const control of [search, go, wrap]) control.setAttribute('aria-pressed', 'false');
  const jumpInput = input('');
  jumpInput.setAttribute('aria-label', '跳转到行');
  jumpInput.placeholder = '行号或行:列';
  const jumpSubmit = node('button', '', '跳转');
  jumpSubmit.type = 'submit';
  const jumpRow = node('form', 'file-jump-row', field('跳转到行', jumpInput), jumpSubmit);
  jumpRow.hidden = true;
  function toggleJump(open) {
    go.setAttribute('aria-pressed', String(open));
    jumpRow.hidden = !open;
    if (open) {
      view.search(false);
      jumpInput.setCustomValidity('');
      jumpInput.value = String(editor.state.doc.lineAt(editor.state.selection.main.head).number);
      jumpInput.focus();
      jumpInput.select();
    } else if (jumpRow.contains(document.activeElement)) editor.focus();
  }
  jumpInput.oninput = () => jumpInput.setCustomValidity('');
  jumpRow.onsubmit = event => {
    event.preventDefault();
    if (view.jump(jumpInput.value)) { toggleJump(false); editor.focus(); }
    else { jumpInput.setCustomValidity('请输入行号或行:列'); jumpInput.reportValidity(); }
  };
  const tools = node('div', 'file-editor-tools', download, prettify, search, go, wrap, undo, redo);
  const actions = node('div', 'actions', tools, node('div', 'file-mode-actions', edit, save, close, cancel));
  const identity = node('div', 'file-editor-identity', chromeIcon('file'), node('div', '', title, location));
  const heading = node('header', 'file-editor-heading', identity, actions);
  fileEditor.addEventListener('cancel', event => {
    event.preventDefault();
    if (comparison) { leaveComparison(false); return; }
    if (!jumpRow.hidden) { toggleJump(false); editor.focus(); }
    else if (search.getAttribute('aria-pressed') === 'true') { view.search(false); editor.focus(); }
    else (editing ? cancel : close).click();
  }, { signal: lifetime.signal });
  fileEditor.addEventListener('keydown', event => {
    if (event.isComposing || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if (comparison) {
      if (keyboard.primary(event) && key === 's') event.preventDefault();
      return;
    }
    if (keyboard.primary(event) && !event.shiftKey && key === 's') { if (editing) save.click(); }
    else if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyF') prettify.click();
    else if (view && key === 'f' && !event.shiftKey && keyboard.primary(event)) { toggleJump(false); view.search(true); }
    else if (view && key === 'g' && !event.shiftKey && ((event.ctrlKey && !event.metaKey && !event.altKey &&
      !event.target.closest('.file-search-panel')) || (event.altKey && (event.metaKey || event.ctrlKey)))) toggleJump(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal: lifetime.signal });
  fileEditor.addEventListener('close', () => {
    lifetime.abort();
    formatRequest?.abort();
    comparison?.destroy();
    editor?.destroy();
    fileEditor.replaceChildren();
    if (active === source) {
      if (trigger?.isConnected && origin() === tab) trigger.focus({ preventScroll: true });
      else focusTerminal(source);
    }
  }, { once: true });
  fileEditor.replaceChildren(heading, compareBar, jumpRow, content, comparePanel, node('footer', 'file-editor-footer',
    node('div', 'file-editor-status', mode, modified, notice), position, languagePicker, format, ending));
  syncMode();
  window.overlays.show(fileEditor);
  title.focus({ preventScroll: true });
  function mountFile(file) {
    revision = file.revision;
    const draftChanged = () => {
      if (!busy && !formatRequest) notice.textContent = '';
      refresh();
    };
    const updatePosition = (line, column, selected) => {
      position.textContent = `行 ${line}，列 ${column}${selected ? ` · 已选 ${selected}` : ''}`;
    };
    view = window.TermlumeFileEditor.open(content, remotePath, file.text, draftChanged,
      document.documentElement.dataset.theme === 'dark', updatePosition, open => search.setAttribute('aria-pressed', String(open)));
    editor = view.editor;
    savedFile = view.snapshot();
    content.hidden = false;
    if (!modes.length) for (const name of window.TermlumeFileEditor.formatNames) modes.add(new Option(name, name));
    modes.value = view.format;
    modes.dispatchEvent(new Event('input'));
    languagePicker.hidden = false;
    format.textContent = 'UTF-8';
    updatePosition(1, 1, 0);
    notice.textContent = '';
    refresh();
    if (document.activeElement === title) editor.focus();
  }
  void (async () => {
    try {
      const file = await api.files.readText({ id: tab.id, path });
      if (!fileEditor.open || !content.isConnected) return;
      if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化。请重新打开文件。');
      ({ path: remotePath, revision } = file);
      if (file.tooLarge) {
        const largeLog = window.TermlumeFileEditor.isLogFile(remotePath) || remotePath === tab.host.logPath;
        if (!largeLog) { notice.textContent = '文件超过 4 MiB，可下载到本机查看。'; return; }
        async function openLog(action) {
          if (busy) return;
          if (!readySession(tab, attempt)) { notice.textContent = 'SSH 会话已变化，请重新打开日志。'; return; }
          busy = true;
          refresh();
          const request = { action, argument: remotePath, lines: 200 };
          try {
            const command = await api.commands.preview(request);
            if (!content.isConnected || !fileEditor.open) return;
            if (!readySession(tab, attempt) || active !== source) throw new Error('SSH 会话已变化，请重新打开日志。');
            fileEditor.close();
            await openFileCommandOutput(tab, request, command);
          } catch (error) { notice.textContent = message(error); }
          finally { busy = false; if (content.isConnected) refresh(); }
        }
        content.replaceChildren(node('div', 'empty-state', settingsIcon('file'), node('h3', '', '日志超过 4 MiB'),
          node('p', '', '可读取最后 200 行，或从这里开始跟踪新增内容。'),
          node('div', 'file-tools', button('查看最后 200 行', () => openLog('tail'), 'primary'),
            button('实时跟踪', () => openLog('follow'), 'outlined'))));
        notice.textContent = '';
        content.hidden = false;
        return;
      }
      mountFile(file);
    } catch (error) { notice.textContent = message(error); }
  })();
}

function handleFileDrag({ phase, position, count, ticket }) {
  if (tabDrag?.started) return;
  if (phase === 'enter' || phase === 'drop') draggedFileCount = count;
  if (phase === 'leave') draggedFileCount = 0;
  const overlay = $('terminal-drop');
  const tab = active;
  const rect = $('terminal-stage').getBoundingClientRect();
  const eligible = draggedFileCount > 0 && readySession(tab) && !dialog.open && !fileEditor.open &&
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
  status(`${tab.host.name} · SSH 已连接${tab.jumpHost ? `（经 ${tab.jumpHost.name}）` : ''}`);
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

async function loadFiles(tab, directory, revealName) {
  const files = tab.files;
  const attempt = tab.attempts;
  const generation = files.generation = (files.generation || 0) + 1;
  files.loading = true;
  files.error = '';
  files.notice = '';
  if (origin() === tab) renderFiles();
  try {
    const result = await api.files.list({ id: tab.id, directory });
    if (files.generation !== generation || !readySession(tab, attempt)) return;
    if (api.files.places && (!files.entries || files.directory !== result.directory)) {
      files.recordVisit = api.files.places({ id: tab.id, action: 'visit', path: result.directory })
        .catch(error => { if (readySession(tab, attempt)) status(`记录最近目录失败 · ${message(error)}`); });
    }
    if (files.directory !== result.directory) {
      files.selected.clear();
      files.scrollTop = 0;
      files.query = '';
    }
    Object.assign(files, result);
    if (revealName) {
      files.query = '';
      files.selected.clear();
      const item = result.entries.find(entry => entry.name === revealName);
      if (item) {
        if (revealName.startsWith('.')) files.showHidden = true;
        files.selected.add(revealName);
      } else {
        files.notice = `已打开所在目录，未找到「${revealName}」。`;
      }
    }
  } catch (error) {
    if (files.generation === generation) {
      files.error = message(error);
      if (revealName) {
        Object.assign(files, { directory, entries: [], query: '', error: `无法打开远端目录 ${directory} · ${files.error}` });
        files.selected.clear();
      }
    }
  } finally {
    if (files.generation === generation) {
      files.loading = false;
      if (origin() === tab) {
        renderFiles();
        if (filesOpen && revealName && files.selected.has(revealName)) {
          $('files').querySelector('.file-row.selected')?.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }
}

function bytes(size) {
  if (!Number.isFinite(size)) return '—';
  if (size >= 2 ** 30) return `${(size / 2 ** 30).toFixed(1)} GiB`;
  if (size >= 2 ** 20) return `${(size / 2 ** 20).toFixed(1)} MiB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

async function goToRemoteDirectory(tab) {
  const attempt = tab.attempts;
  const current = tab.files.directory || '';
  const directory = input(current);
  directory.placeholder = api.files.places ? '输入路径或筛选已记住的目录' : '/var/log';
  const fields = [field('远端路径', directory)];
  const choices = node('div', 'palette-list directory-places');
  const feedback = node('p', 'dialog-error');
  feedback.setAttribute('role', 'status');
  let places, filtered = [], query = '', selected;
  let savingFavorite = false;
  const pinCurrent = button('收藏当前目录', () => changeFavorite(current, !places.favorites.includes(current)), 'outlined');
  pinCurrent.disabled = true;
  async function changeFavorite(path, pin) {
    if (savingFavorite || !readySession(tab, attempt)) return;
    savingFavorite = true;
    feedback.textContent = '';
    try {
      places = await api.files.places({ id: tab.id, path, action: pin ? 'pin' : 'unpin' });
    } catch (error) { feedback.textContent = message(error); }
    finally { savingFavorite = false; if (choices.isConnected) render(); }
  }
  function render() {
    if (!places) return;
    pinCurrent.disabled = !current;
    pinCurrent.textContent = places.favorites.includes(current) ? '取消收藏当前目录' : '收藏当前目录';
    choices.replaceChildren();
    filtered = [];
    const groups = [
      ['收藏目录', places.favorites],
      ['最近目录', places.recent.filter(path => !places.favorites.includes(path))]
    ];
    for (const [title, paths] of groups) {
      const matches = paths.filter(path => path.toLowerCase().includes(query.toLowerCase()));
      if (!matches.length) continue;
      choices.append(node('h3', 'palette-group', title));
      for (const path of matches) {
        filtered.push(path);
        const open = button('', () => { selected = path; directory.form.requestSubmit(); }, 'directory-choice', `前往 ${path}`);
        open.append(summaryText('span', path));
        const favorite = places.favorites.includes(path);
        const pin = button(favorite ? '取消收藏' : '收藏', () => changeFavorite(path, !favorite), '', `${favorite ? '取消收藏' : '收藏'} ${path}`);
        choices.append(node('div', 'directory-choice-row', open, pin));
      }
    }
    if (!filtered.length) choices.append(node('p', 'muted', query ? '没有匹配的目录，可直接输入路径。' : '暂无目录记录'));
  }
  if (api.files.places) fields.push(pinCurrent, choices, feedback);
  directory.addEventListener('input', () => { query = directory.value.trim(); render(); });
  const destination = prompt('前往目录', fields, '前往', () => {
    const value = directory.value;
    const keywordMatch = query && !value.includes('/') && !value.startsWith('.') && filtered[0];
    const path = selected || keywordMatch || terminalPaths.resolve(value, current);
    if (!path) throw new Error('请输入有效的远端目录。');
    return path;
  });
  directory.select();
  if (api.files.places && directory.form) {
    wireSearchChoices(directory.form, directory, choices, '.directory-choice');
    void Promise.resolve(tab.files.recordVisit).then(() => api.files.places({ id: tab.id }))
      .then(result => { if (choices.isConnected) { places = result; render(); } })
      .catch(error => { feedback.textContent = message(error); });
  }
  const path = await destination;
  if (path && filesOpen && origin() === tab && readySession(tab, attempt)) await loadFiles(tab, path);
}

function renderFiles() {
  const panel = $('files');
  if (hostMenu && panel.contains(hostMenu.anchor)) closeHostMenu();
  const tab = origin();
  const open = filesOpen && Boolean(tab) && (!active.connectionPage || active.connectionPage.hidden);
  panel.inert = !open;
  workspace.dataset.files = open ? 'open' : 'closed';
  if (!open) return;
  const files = tab.files;
  const host = summaryText('small', tab.host.name);
  const close = button('×', toggleFiles, 'file-icon-button', '关闭文件区');
  const heading = node('header', 'file-heading', chromeIcon('folder'),
    node('div', 'file-heading-title', node('strong', '', '远端文件'), host), close);
  panel.replaceChildren(heading);
  if (tab.status !== 'ready') {
    panel.append(node('div', 'empty-state', settingsIcon('folder'), node('p', 'muted', '连接 SSH 后可浏览文件。')));
    return;
  }
  close.before(button('前往', () => goToRemoteDirectory(tab), '', '前往目录'),
    button('↻', () => loadFiles(tab, files.directory), 'file-icon-button', '刷新远端文件'));
  const shellDirectory = button('终端目录', async () => {
    const attempt = tab.attempts;
    const path = await currentTerminalDirectory(tab);
    if (origin() !== tab || !readySession(tab, attempt)) return;
    if (!path) throw new Error('尚未识别终端目录，可点「前往」输入路径。');
    await loadFiles(tab, path);
  }, '', '打开当前终端目录');
  const crumbs = node('nav', 'file-breadcrumbs');
  crumbs.setAttribute('aria-label', '远端目录层级');
  for (const {name, path} of pathBreadcrumbs(files.directory)) {
    const crumb = button(name, () => loadFiles(tab, path));
    crumb.title = path;
    if (path === files.directory) crumb.setAttribute('aria-current', 'location');
    crumbs.append(crumb);
  }
  panel.append(node('div', 'file-location', crumbs, shellDirectory));
  crumbs.scrollLeft = crumbs.scrollWidth;
  if (files.loading) { panel.append(node('p', 'inline-status muted', '正在读取目录…')); return; }
  if (files.error) panel.append(node('p', 'inline-status danger', files.error));
  if (files.notice) panel.append(node('p', 'inline-status muted', files.notice));
  if (!files.directory || !files.entries || (files.error && !files.entries.length)) return;

  const selectable = (kind) => kind === 'file' || (kind === 'directory' && api.files.directoryDownloads);
  const selection = () => files.entries.filter(({ name, kind }) => selectable(kind) && files.selected.has(name));
  const logPath = () => {
    const [entry, other] = selection();
    return entry?.kind === 'file' && !other ? pathOf(tab, entry.name) : undefined;
  };
  const create = menuButton('新建 / 上传', [
    button('新建文件', () => createRemoteItem(tab, false)),
    button('新建目录', () => createRemoteItem(tab, true)),
    button('上传文件', () => prepareTransfer(tab, 'up')),
    ...(api.files.directoryUploads ? [button('上传目录', () => prepareTransfer(tab, 'up', undefined, { folder: true }))] : [])
  ]);
  const download = button('下载所选项', () => prepareTransfer(tab, 'down', selection().map(({ name }) => name)));
  const follow = button('跟踪日志', () => configureCommand(tab, 'follow', logPath()));
  const tail = button('查看末尾', () => configureCommand(tab, 'tail', logPath()));
  const edit=button('外部编辑',()=>externalEdit(tab,logPath()),'outlined');
  const openSelected = button('打开文件', () => {
    const path = logPath();
    if (path) openRemoteFile(tab, path, selectedActions);
  });
  const rename = button('重命名', () => mutateRemote(tab, false, selection()), 'outlined');
  const remove = button('删除', () => mutateRemote(tab, true, selection()), 'outlined danger');
  const filter = input(files.query || '', 'search');
  filter.placeholder = '筛选当前目录';
  filter.setAttribute('aria-label', '筛选当前目录文件名');
  const sortName = button('按名称排序', () => updateView({ sort: 'name' }));
  const sortSize = button('按文件大小排序', () => updateView({ sort: 'size' }));
  const hidden = button('', () => updateView({ showHidden: files.showHidden === false }, true));
  const more = menuButton('更多 ⋯', [sortName, sortSize, hidden,
    ...(files.lastMutation ? [button('操作结果', () => showMutationResults(tab))] : []),
    ...(api.editors ? [button('管理外部编辑副本', manageEditorTasks)] : [])]);
  more.setAttribute('aria-label', '文件区更多操作');
  const all = input('', 'checkbox');
  all.setAttribute('aria-label', '全选当前可见的可下载项');
  all.title = '全选可见项';
  let visible = [];
  const visibleEntries = () => files.entries.filter(({ name }) =>
    (files.showHidden !== false || !name.startsWith('.')) && name.toLowerCase().includes(filter.value.trim().toLowerCase()))
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
      || (files.sort === 'size' && a.kind === 'file' && b.kind === 'file' ? b.size - a.size : 0)
      || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const clear = button('清空选择', () => { files.selected.clear(); renderEntries(); });
  const selectedCount = node('small', 'muted');
  const nameHeading = node('span', '', '名称');
  const selectedActions = menuButton('所选项 ⋯', [...(api.files.readText ? [openSelected] : []), download, follow, tail, ...(api.editors ? [edit] : []),
    ...(api.files.mutations ? [rename, remove] : []), clear]);
  const updateSelection = () => {
    const count = selection().length;
    selectedActions.hidden = count === 0;
    nameHeading.hidden = count !== 0;
    edit.disabled=!logPath();
    openSelected.disabled = !logPath();
    rename.disabled=count!==1;remove.disabled=count===0;
    follow.disabled = tail.disabled = !logPath();
    selectedCount.textContent = count ? `已选 ${count} 项` : '';
    selectedCount.hidden = count === 0;
    const selectableEntries = visible.filter(({ kind }) => selectable(kind));
    const checked = selectableEntries.filter(({ name }) => files.selected.has(name)).length;
    all.disabled = selectableEntries.length === 0;
    all.checked = selectableEntries.length > 0 && checked === selectableEntries.length;
    all.indeterminate = checked > 0 && checked < selectableEntries.length;
  };
  panel.append(node('div', 'file-toolbar', create, filter, more),
    node('div', 'file-columns muted', all, node('div', 'file-column-name', nameHeading, selectedActions, selectedCount),
      node('span', '', '大小 / 类型')));
  const list = node('div', 'file-list');
  function renderEntries() {
    sortName.setAttribute('aria-current', String(files.sort !== 'size'));
    sortSize.setAttribute('aria-current', String(files.sort === 'size'));
    hidden.textContent = files.showHidden === false ? '显示隐藏项' : '不显示隐藏项';
    const entries = visibleEntries();
    visible = entries;
    const rows = [];
    for (const { name, kind, size } of entries) {
      const row = node('div', 'file-row');
      row.classList.toggle('selected', files.selected.has(name));
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
        row.append(checkbox);
        if (kind === 'file') {
          const entry = fileEntry(name, kind, () => checkbox.click());
          if (api.files.readText) {
            const open = () => openRemoteFile(tab, pathOf(tab, name), entry);
            entry.title = `${name} · 双击或按 Enter 打开`;
            entry.addEventListener('dblclick', open);
            entry.addEventListener('click', event => {
              if (event.detail === 1) { entry.focus({ preventScroll: true }); return; }
              event.stopImmediatePropagation();
              if (event.detail === 0) open(); // Keyboard or accessibility activation.
            }, true);
            checkbox.addEventListener('keydown', event => {
              if (event.key === 'Enter') { event.preventDefault(); open(); }
            });
          }
          row.append(entry);
        }
      }
      if (kind === 'directory') row.append(fileEntry(name, kind, () => loadFiles(tab, pathOf(tab, name))));
      if (kind === 'other') row.append(summaryText('span', name));
      row.append(node('small', '', kind === 'directory' ? '目录' : kind === 'file' ? bytes(size) : '链接或特殊文件'));
      if (selectable(kind)) row.append(button('↓', () => prepareTransfer(tab, 'down', [name]), 'file-download', `下载 ${name}`));
      rows.push(row);
    }
    if (!entries.length) rows.push(node('div', 'empty-state', settingsIcon('folder'),
      node('p', 'muted', files.entries.length ? '没有匹配的文件，请调整筛选或显示隐藏项。' : '空目录')));
    list.replaceChildren(...rows);
    updateSelection();
  }
  const updateView = (changes, clearSelection = false) => {
    Object.assign(files, changes, { scrollTop: 0 });
    if (clearSelection) files.selected.clear();
    renderEntries();
    list.scrollTop = 0;
  };
  filter.addEventListener('input', () => updateView({ query: filter.value }, true));
  all.addEventListener('change', () => {
    for (const { name, kind } of visible) if (selectable(kind)) {
      if (all.checked) files.selected.add(name);
      else files.selected.delete(name);
    }
    renderEntries();
  });
  renderEntries();
  panel.append(list);
  list.scrollTop = files.scrollTop || 0;
  list.addEventListener('scroll', () => {
    if (list.isConnected) files.scrollTop = list.scrollTop;
  }, { passive: true });
}

function fileEntry(name, kind, action) {
  const entry = button('', action, `file-entry file-entry-${kind}`, name);
  entry.replaceChildren(chromeIcon(kind === 'directory' ? 'folder' : 'file'), summaryText('span', name));
  return entry;
}

async function externalEdit(tab,path) {
  if(!path) return;
  if(await confirm('外部编辑',`${tab.host.name} · ${path}\n会创建本机临时副本，并用本机文本编辑器打开。保存后回到编辑任务手动上传；远端变化时拒绝覆盖。`,'打开编辑器')) {
    await api.editors.open({id:tab.id,path});await manageEditorTasks();
  }
}
async function manageEditorTasks() {
  while(!vaultStatus.locked) {
    const editors=await api.editors.list();let choice;
    const rows=editors.map(edit=>node('section','forward-rule',node('strong','',`${edit.host} · ${edit.remote}`),node('small','muted',edit.endpoint),node('small','muted',`本机副本：${edit.local}`),node('div','forward-actions',button('上传已保存副本',()=>{choice={upload:edit};dialog.close();},'outlined'),button('清理副本',()=>{choice={close:edit};dialog.close();},'outlined danger'))));
    await prompt('外部编辑任务',rows.length?rows:[node('p','muted','从文件侧栏选择普通文本文件后打开外部编辑器。')],'关闭',()=>true);
    if(!choice) break;
    if(choice.close) {if(await confirm('清理本机副本',`删除 ${choice.close.local}？远端文件保留，未上传的本机更改会丢失。`,'清理')) await api.editors.close(choice.close.id);}
    else {
      const prepared=await api.editors.prepare(choice.upload.id);
      try {if(await confirm('上传编辑结果',`${choice.upload.host} · ${choice.upload.endpoint}\n覆盖 ${choice.upload.remote}？将使用本次准备时保存的本机快照，后续编辑不会混入此次上传。`,'上传并覆盖')) await api.files.enqueue({ticket:prepared.ticket,policy:'replace'});}
      finally {await api.files.discard(prepared.ticket);}
    }
  }
}

async function showMutationResults(tab){const result=tab.files.lastMutation||[];await prompt('远端操作结果',[node('p','',`${tab.host.name} · ${result.filter(r=>r.status==='done').length}/${result.length} 项完成`),node('pre','operation-results',result.map(r=>`${r.status==='done'?'完成':'失败'} ${r.path}${r.message?' · '+r.message:''}`).join('\n'))],'关闭',()=>true);}

async function mutateRemote(tab, deleting, entries) {
  const attempt=tab.attempts;
  if([...jobs.values()].some(j=>j.sessionId===tab.id&&['queued','running','verifying','committing'].includes(j.status))) throw new Error('请先完成或取消此会话的传输，再修改远端文件。');
  const paths=entries.map(entry=>pathOf(tab,entry.name));
  const preview=await api.files.mutationPreview({id:tab.id,paths});
  if(!readySession(tab,attempt)) return;
  const name=input(entries[0]?.name);
  const check=input('','checkbox');check.required=true;
  const fields=[node('p','',`${tab.host.name} · ${endpoint(tab.host)}`),node('pre','operation-results',preview.roots.join('\n')),
    ...(deleting?[node('p','muted',`包含 ${preview.count} 个对象；目录会递归删除，不跟随符号链接。操作不能撤销，失败时可能只完成一部分。`),node('label','checkbox-row',check,'确认永久删除以上范围')]:[field('新名称',name),node('p','muted','在同一目录中重命名，不覆盖已有项目。')])];
  const result=await prompt(deleting?'删除远端项目':'重命名远端项目',fields,deleting?'永久删除':'重命名',async()=>{
    if(!readySession(tab,attempt)) throw new Error('SSH 会话已变化，请重新选择。');
    if(deleting) return api.files.remove({id:tab.id,roots:preview.roots,expected:preview.nodes});
    if(!name.value||/[\/\x00-\x1f]/.test(name.value)||['.','..'].includes(name.value)) throw new Error('请输入有效的新名称。');
    await api.files.rename({id:tab.id,source:preview.roots[0],destination:pathOf(tab,name.value),expected:preview.nodes.find(n=>n.path===preview.roots[0])});
    return [{path:paths[0],status:'done',message:`已重命名为 ${name.value}`}];
  });
  if(result) {
    tab.files.lastMutation=result;tab.files.selected.clear();await loadFiles(tab,tab.files.directory);
    await showMutationResults(tab);
  }
}

async function createRemoteItem(tab, folder) {
  const directory = tab.files.directory;
  const attempt = tab.attempts;
  const name = input();
  name.required = true;
  const created = await prompt(folder ? '新建目录' : '新建文件', [
    node('p', '', `${tab.host.name} · ${directory}`), field('名称', name)
  ], '创建', async () => {
    if (!readySession(tab, attempt)) throw new Error('SSH 会话已变化，请重新打开文件抽屉。');
    await api.files[folder ? 'mkdir' : 'createFile']({ id: tab.id, directory, name: name.value });
    return true;
  });
  if (created && readySession(tab, attempt) && tab.files.directory === directory) await loadFiles(tab, directory);
}

async function prepareTransfer(tab, direction, names, { directory = tab.files.directory, dropTicket, folder } = {}) {
  const attempt = tab.attempts;
  const preparing = direction === 'down' ? '正在准备下载，请选择本机保存位置…' : '正在准备上传…';
  if (origin() === tab) status(preparing);
  let prepared;
  try {
    prepared = await api.files.prepare({ id: tab.id, direction, directory, names, dropTicket, folder });
  } finally {
    if ($('status').textContent === preparing && origin() === tab) status(`${tab.host.name} · SSH 已连接${tab.jumpHost ? `（经 ${tab.jumpHost.name}）` : ''}`);
  }
  if (!prepared) return;
  return confirmTransfer(tab, attempt, direction, directory, prepared);
}

async function confirmTransfer(tab, attempt, direction, directory, prepared, record) {
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
    const fields = record ? [node('strong', '', `${tab.host.name} · ${endpoint(tab.host)}`),
      node('p', '', '将从头重新传输。请核对两端路径。'),
      field('本机路径', node('code', 'command-preview', record.local)),
      field('远端路径', node('code', 'command-preview', record.remote))]
      : [node('p', '', `${tab.host.name} · ${directory}`), targets];
    if (record && conflicts.length) fields.push(node('p', 'muted', '目标已存在，请选择同名处理方式。'));
    const skipped = files.reduce((sum, file) => sum + (file.skipped || 0), 0);
    if (skipped) fields.push(node('p', 'muted', `将跳过 ${skipped} 个链接、特殊文件或不支持的文件名。`));
    if (conflicts.length) fields.push(field('同名文件', selectControl(choices, '同名文件处理方式')));
    const confirmed = await prompt(record ? '核对重试路径' : direction === 'up' ? '确认上传' : '确认下载', fields, '开始传输', async () => {
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
  loadingHistory = Promise.all([api.files.history(), api.files.pending?.() || []]).then(([history, pending]) => {
    const records = [...history, ...pending];
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

async function removeTransferHistory(id = null) {
  if (editingHistory || !historyReady) return;
  editingHistory = true;
  renderTransferSummary();
  try {
    if (!id && !await confirm('清空全部历史', '将清空所有已结束的上传和下载记录，包括当前筛选之外的记录。文件和进行中的任务会保留。', '清空记录')) return;
    const ids = await api.files.removeHistory(id);
    for (const removed of ids) {
      removedJobs.add(removed);
      forgetJob(removed);
    }
    if (ids.length) status(id ? '已删除传输记录。' : '已清空全部历史。');
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
  const query = $('transfer-search').value.trim().toLocaleLowerCase();
  for (const job of jobs.values()) {
    const names = [job.remote?.split('/').pop(), job.local?.split(/[\\/]/).pop()];
    const visible = (!transferDirection || job.direction === transferDirection) &&
      (!query || names.some(name => name?.toLocaleLowerCase().includes(query)));
    jobRows.get(job.id).element.hidden = !visible;
    if (job.finishedAt) {
      if (visible) shownHistory += 1;
      canClear = true;
      if (!job.archived && ['failed', 'unverified'].includes(job.status)) failed += 1;
    } else {
      running += 1;
      if (visible) shownActive += 1;
    }
  }
  $('queue-button').textContent = `⇄ 传输记录${running ? ` · ${running} 项进行中` : ''}${failed ? ` · ${failed} 项待处理` : ''}`;
  const history = transferPage === 'history';
  for (const control of $('transfer-pages').children) {
    if (control.dataset.transferPage === transferPage) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  $('transfer-active-page').hidden = history;
  $('transfer-history-page').hidden = !history;
  $('clear-transfers').hidden = !history;
  const filtered = query || transferDirection;
  $('transfer-active-empty').textContent = filtered ? '没有匹配的进行中任务。' : '暂无进行中的传输。';
  $('transfer-history-empty').textContent = filtered ? '没有匹配的历史记录。' : '暂无传输记录。';
  $('transfer-active-empty').hidden = shownActive > 0;
  $('transfer-history-empty').hidden = !historyReady || shownHistory > 0;
  $('clear-transfers').disabled = !historyReady || editingHistory || !canClear;
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
    const name = node('strong', 'text-ellipsis');
    const meta = node('small', 'text-ellipsis');
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
  row.name.textContent = row.name.title = job.remote.split('/').pop() || job.remote;
  row.meta.textContent = row.meta.title = [upload ? '上传' : '下载', job.host,
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

async function continueTransferAction(tab) {
  const pending = tab.pendingTransfer;
  if (!pending || !readySession(tab) || dialog.open || fileEditor.open) return;
  const { job, legacyHost, action } = pending;
  const attempt = tab.attempts;
  tab.pendingTransfer = undefined;
  renderContext();
  try {
    if (action === 'locate') {
      const {path, route} = await api.files.remoteLocation({ id: tab.id, recordId: job.id, legacyHost });
      const current = jobs.get(job.id);
      if (current) current.route = route;
      if (active !== tab || !readySession(tab, attempt) || dialog.open || fileEditor.open) return;
      const split = path.lastIndexOf('/');
      filesOpen = true;
      serverInfoOpen = false;
      renderServerInfo();
      renderContext();
      await loadFiles(tab, path.slice(0, split) || '/', path.slice(split + 1));
      return;
    }
    if (action === 'resume' || action === 'discard') {
      await api.files.resume({id: job.id, sessionId: tab.id, discard: action === 'discard'});
      if (active === tab && !dialog.open && !fileEditor.open) {
        transferPage = 'active';
        selectTab(undefined, 'transfers');
        renderTransferSummary();
      }
      return;
    }
    const prepared = await api.files.prepareRetry({id: tab.id, recordId: job.id, legacyHost});
    if (active !== tab || !readySession(tab, attempt) || dialog.open || fileEditor.open) {
      await api.files.discard(prepared.ticket);
      if (readySession(tab, attempt) && !tab.pendingTransfer) tab.pendingTransfer = pending;
      renderContext();
      return;
    }
    await confirmTransfer(tab, attempt, job.direction, '', prepared, job);
  } catch (error) { status(message(error)); }
}

async function reconnectTransfer(job, action) {
  const discard = action === 'discard';
  if (discard && !await confirm('取消此传输？', '将清理这项任务的临时文件和断点。', '取消任务')) return;
  if (discard && job.direction === 'down') return api.files.cancelPausedDownload(job.id);
  await refreshHosts();
  if (vaultStatus.locked || dialog.open) return;
  const original = job.route?.target;
  let host = original && hosts.find(item => item.id === original.id);
  const matchesEndpoint = (entry, saved) => entry && entry.address.toLowerCase() === saved.address &&
    entry.port === saved.port && entry.username === saved.username;
  const jump = job.route?.jump;
  if (original && (!matchesEndpoint(host, original) || (host.jumpHostId || null) !== (jump?.id || null) ||
      (jump && !matchesEndpoint(hosts.find(item => item.id === jump.id), jump)))) {
    throw new Error('原主机已删除或连接目标已变化，请核对主机配置。');
  }
  if (!original) {
    const picker = node('select');
    picker.add(new Option('请选择主机', ''));
    for (const entry of hosts) picker.add(new Option(`${entry.name} · ${endpoint(entry)}`, entry.id));
    const matches = hosts.filter(entry => entry.name === job.host);
    if (matches.length === 1) picker.value = matches[0].id;
    picker.required = true;
    const hint = action === 'locate' ? '确认并连接成功后，这条记录会记住所选主机。' : '请选择对应的连接目标。';
    host = await prompt('为旧传输记录选择主机', [node('p', '', `原记录仅保存了主机名称「${job.host}」。${hint}`),
      field('目标主机', selectControl(picker, '目标主机', { searchable: true }))], '继续', () => {
        const selected = hosts.find(item => item.id === picker.value);
        if (!selected) throw new Error('请选择此次传输的目标主机。');
        return selected;
      });
    if (!host) return;
  }
  let tab = [...tabs.values()].filter(item => item.kind === 'shell' && item.host.id === host.id && !item.pendingTransfer &&
    !item.closing && ['ready','connecting','trust'].includes(item.status))
    .sort((a,b) => Number(readySession(b)) - Number(readySession(a)) ||
      Number(b.id === job.sessionId) - Number(a.id === job.sessionId))[0];
  if (!tab) tab = await openHost(host, {force:true, connectNow:false});
  else selectTab(tab);
  if (!tab || vaultStatus.locked) return;
  tab.pendingTransfer = {job, action, legacyHost: original ? undefined : host.id};
  if (readySession(tab)) return continueTransferAction(tab);
  if (tab.status === 'idle') await connect(tab, false, false, true);
}

function renderJobActions(job, row) {
  const tab = tabs.get(job.sessionId);
  const retry = !job.editorUpload && ['failed', 'canceled'].includes(job.status) && (Boolean(api.files.prepareRetry) || (!job.archived && readySession(tab)));
  const state = `${job.status}:${Boolean(tab)}:${retry}`;
  if (row.actionState === state) return;
  row.actionState = state;
  const controls = [];
  if (['running', 'verifying'].includes(job.status) && api.files.pause) controls.push(button('暂停', () => api.files.pause(job.id)));
  if (job.status === 'paused' && api.files.resume) {
    controls.push(button('继续传输', () => reconnectTransfer(job, 'resume'), 'primary'),
      button('取消任务', () => reconnectTransfer(job, 'discard')));
  } else if (['queued', 'running', 'verifying'].includes(job.status)) controls.push(button('取消', () => api.files.cancel(job.id)));
  if (retry) controls.push(button(api.files.prepareRetry ? '重新传输' : '重试', () => api.files.prepareRetry ? reconnectTransfer(job, 'retry') : api.files.retry(job.id)));
  if (api.files.remoteLocation) controls.push(button('定位远端文件', () => reconnectTransfer(jobs.get(job.id), 'locate'), 'outlined'));
  if (api.files.revealLocal) controls.push(button('打开本地目录', async () => {
    const { selected } = await api.files.revealLocal(job.id);
    status(selected ? '已在本地目录中选中该项目。' : '已打开本地目录，记录中的项目尚未生成或已移走。');
  }, 'outlined'));
  if (job.finishedAt) controls.push(button('删除记录', () => removeTransferHistory(job.id), '', `删除传输记录 ${job.remote}`));
  row.controls.hidden = !controls.length;
  row.controls.replaceChildren(...controls);
}

api.onEvent((event) => {
  if (event.type === 'update') {
    acceptAppUpdateState(event.state);
    renderAppUpdates();
    return;
  }
  if (event.type === 'vault') { applyVaultState(event.state); return; }
  if (event.type === 'git-auto') {
    const { state } = event;
    if (vaultStatus.locked || state.locked || !vaultStatus.enabled ||
        state.remote !== vaultStatus.remote || state.branch !== vaultStatus.branch) return;
    const { lastSynced, lastFetched, syncAttention } = state;
    vaultStatus = { ...vaultStatus, lastSynced, lastFetched, syncAttention };
    updateGitSummary();
    if (syncAttention && !vaultStatus.gitSettings?.paused) status(syncAttention);
    if (event.updated) void refreshHosts().catch(error => status(message(error)));
    return;
  }
  if(event.type==='log'){recordingSessions.delete(event.id);if(!vaultStatus.locked){status(event.message||'日志已停止');renderContext();}return;}
  if (event.type === 'forward') {
    if (vaultStatus.locked) return;
    forwardVersions.set(event.id, ++forwardVersion);
    forwardRuns.set(event.id, event);
    if (forwardRuns.size > 256) for (const [id, run] of forwardRuns) { if (run.status === 'stopped') { forwardRuns.delete(id); forwardVersions.delete(id); } if (forwardRuns.size <= 256) break; }
    renderForwardPanel?.();
    if (origin()?.id === event.sessionId) renderContext();
    return;
  }
  if (event.type === 'file-drag') { handleFileDrag(event); return; }
  const tab = tabs.get(event.id);
  if (event.type === 'output') {
    if (!tab) { api.ssh.ack(event.ack); return; }
    const pending = tab.pendingAcks ||= new Map();
    const acknowledge = () => { if (pending.delete(event.ack)) api.ssh.ack(event.ack); };
    pending.set(event.ack, acknowledge);
    tab.paths.invalidate();
    if ((tab.view.hidden || workspace.dataset.view !== 'session' || document.hidden || vaultStatus.locked) && !tab.unread) {
      tab.unread = true;
      renderTabs();
    }
    if (tab.terminal.buffer.active.viewportY < tab.terminal.buffer.active.baseY) tab.newOutput = true;
    tab.rendering.write(event.bytes, acknowledge);
  } else if (event.type === 'transfer') updateJob(event);
  else if (tab && event.type === 'trust') {
    tab.fingerprint = event.fingerprint;
    tab.trustHost = event.host;
    tab.trustStage = event.stage;
    tab.trustChallenge = event.challenge;
    updateSession(tab, 'trust', event.stage === 'jump' ? '等待核对跳板机指纹。' : '等待核对目标主机指纹。');
  } else if (tab && event.type === 'password') {
    const errors = tab.passwordSaveErrors ||= new Map();
    const host = event.host || tab.host;
    if (event.failed) errors.set(host.id, `${host.name} · ${event.message}`);
    else errors.delete(host.id);
    tab.passwordSaveError = [...errors.values()].join('；');
    if (!event.failed) tab.promptForPassword = false;
    if (tab === active) status(`${host.name} · ${event.message}`);
    if (tab === active) renderContext();
  } else if (tab && event.type === 'progress') {
    tab.message = event.message;
    addConnectionLog(tab, event.message);
    renderConnectionPage(tab);
    if (tab === active) status(`${tab.host.name} · ${event.message}`);
  } else if (tab?.kind === 'shell' && event.type === 'session' && event.status === 'closed' && event.exited) {
    removeTab(tab);
  } else if (tab) {
    if (event.retryWithPassword && !event.retryable) tab.promptForPassword = true;
    updateSession(tab, event.status, event.message);
    if (event.status === 'closed' && event.retryable && tab.host?.autoReconnect && !tab.reconnectCancelled && !vaultStatus.locked) {
      const count = (tab.retryCount || 0) + 1;
      const delay = retryDelay(count);
      if (delay) {
        tab.retryCount = count;
        tab.message += ` · ${delay / 1000} 秒后尝试第 ${count}/3 次重连（将创建新会话）`;
        tab.reconnectTimer = setTimeout(() => {
          tab.reconnectTimer = undefined;
          if (tabs.has(tab.id) && tab.status === 'closed' && !vaultStatus.locked && !dialog.open && !tab.reconnectCancelled && !tab.closing) {
            void connect(tab, false, true);
          } else renderConnectionPage(tab);
        }, delay);
        renderConnectionPage(tab);
      }
    }
  }
});

new ResizeObserver(() => active?.rendering?.fit()).observe($('terminal-stage'));
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
document.addEventListener('pointerdown', (event) => {
  if (hostMenu && !hostMenu.panel.contains(event.target) && !hostMenu.anchor.contains(event.target)) closeHostMenu();
}, true);
document.addEventListener('focusin', (event) => {
  if (hostMenu && !hostMenu.panel.contains(event.target) && event.target !== hostMenu.anchor) closeHostMenu();
});
for (const type of ['resize', 'blur']) window.addEventListener(type, () => closeHostMenu());
$('host-library').addEventListener('scroll', () => closeHostMenu(), { passive: true });
document.addEventListener('close', () => {
  if (appUpdateState?.phase === 'available' && !announcedUpdateVersions.has(appUpdateState.version)) {
    setTimeout(showAppUpdateNotice, 0);
  }
}, true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active?.unread && !vaultStatus.locked) { active.unread = false; renderTabs(); }
  if (!document.hidden) showAppUpdateNotice();
});
$('host-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  hostSearchAction?.().catch((error) => status(message(error)));
});
$('library-button').addEventListener('click', () => selectTab(undefined, libraryView));
$('tag-filter').addEventListener('change', renderHosts);
$('host-actions').addEventListener('click', showHostActions);
for (const control of pageButtons) {
  control.addEventListener('click', () => {
    const page = control.dataset.page;
    if (page !== workspace.dataset.view) selectTab(undefined, page);
  });
}
if (api.chrome) {
  const titlebar = document.querySelector('.titlebar');
  const isChromeClick = (event) => event.button === 0 && !event.target.closest('button, a, input, #tabs') && !tabDrag?.started;
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
async function unlockVault(request) {
  const submit = $('unlock-submit');
  const touchId = $('unlock-touch-id');
  if (submit.disabled) return;
  submit.disabled = touchId.disabled = true;
  $('unlock-error').textContent = '';
  try {
    applyVaultState(await api.vault.unlock(request));
    $('unlock-secret').value = '';
    await refreshHosts();
    selectTab(active, workspace.dataset.view);
  } catch (error) {
    $('unlock-error').textContent = message(error);
    if (request.useTouchId) void refreshTouchIdAvailability();
  } finally {
    submit.disabled = touchId.disabled = false;
    if (!request.useTouchId) $('unlock-secret').value = '';
    if (vaultStatus.locked) $('unlock-secret').focus();
  }
}
$('unlock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void unlockVault({ secret: $('unlock-secret').value, useRecovery: $('unlock-mode').value === 'recovery' });
});
$('unlock-touch-id').addEventListener('click', () => { void unlockVault({ useTouchId: true }); });
window.addEventListener('focus', refreshTouchIdAvailability);
let lastActivity = 0;
for (const type of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(type, () => {
    if (vaultStatus.locked || Date.now() - lastActivity < 1000) return;
    lastActivity = Date.now();
    api.vault.activity();
  }, { passive: true });
}
$('add-host').addEventListener('click', () => editHost().catch((error) => status(message(error))));
$('host-sort').addEventListener('click', () => showHostSortMenu($('host-sort')));
const hostSortCaret = node('span', 'dropdown-caret'); hostSortCaret.setAttribute('aria-hidden', 'true');
$('host-sort').replaceChildren(chromeIcon('sort'), node('span', 'dropdown-text', '排序'), hostSortCaret);
const hostLayout = $('host-layout');
try { const saved = localStorage.getItem('host-layout'); if (['cards', 'rows', 'tree'].includes(saved)) hostLayout.value = saved; } catch { /* Card view is the default. */ }
workspace.dataset.hostLayout = hostLayout.value;
const hostLayoutPicker = selectControl(hostLayout, '主机视图', { align: 'end', icon: option => chromeIcon(option?.value || 'cards') });
hostLayoutPicker.classList.add('host-layout');
selectControl($('tag-filter'), '筛选标签', { searchable: true, placeholder: '搜索主机标签', align: 'end', icon: () => chromeIcon('tag') });
selectControl($('unlock-mode'));
hostLayout.addEventListener('change', () => {
  workspace.dataset.hostLayout = hostLayout.value;
  try { localStorage.setItem('host-layout', hostLayout.value); } catch { /* Use the in-memory choice. */ }
  if (hostLayout.value === 'tree') currentGroup = selectedGroup = '';
  renderHosts();
  saveViewPreferences();
});
const toggleNav = $('toggle-nav');
let navigationPreference;
try { const saved = localStorage.getItem('nav-collapsed'); if (saved !== null) navigationPreference = saved === 'true'; } catch { /* Use adaptive navigation. */ }
function setNavigationCollapsed(collapsed) {
  workspace.dataset.navCollapsed = String(collapsed);
  toggleNav.setAttribute('aria-expanded', String(!collapsed));
  toggleNav.title = collapsed ? '展开导航' : '收起导航';
  toggleNav.setAttribute('aria-label', toggleNav.title);
}
function updateNavigation() {
  const compact = innerWidth <= 1100 && ['session', 'new-tab'].includes(workspace.dataset.view);
  setNavigationCollapsed(navigationPreference ?? compact);
}
updateNavigation();
window.addEventListener('resize', updateNavigation);
toggleNav.addEventListener('click', () => {
  navigationPreference = workspace.dataset.navCollapsed !== 'true';
  updateNavigation();
  try { localStorage.setItem('nav-collapsed', String(navigationPreference)); } catch { /* Use the in-memory choice. */ }
  saveViewPreferences();
});
function openGlobalSearch() {
  void openPalette().catch((error) => status(message(error)));
}

function wireSearchChoices(region, search, results, selector) {
  region.addEventListener('keydown', (event) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const choices = [search, ...results.querySelectorAll(selector)];
    const index = choices.indexOf(event.target);
    if (index === -1 || choices.length < 2) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    choices[(index + step + choices.length) % choices.length].focus();
  });
}

function wireTabSearch(formId, resultsId) {
  const form = $(formId);
  const search = form.querySelector('input');
  const results = $(resultsId);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    results.querySelector('.tab-choice')?.click();
  });
  wireSearchChoices(form.parentElement, search, results, '.tab-choice');
}

quickConnectFilters = selectionFilters('新建标签', () => {
  if (active?.kind !== 'new') return;
  active.filters = quickConnectFilters.values;
  renderQuickConnect(active);
}, { types: [['host','已保存主机'],['session','已有会话']], tags: true });
$('quick-connect-filters').append(quickConnectFilters.view);
sessionFilters = selectionFilters('会话切换', renderSessionSwitcher, {
  statuses: [['ready','已连接'],['connecting','连接中 / 待确认'],['idle','等待连接'],['closed','已断开 / 失败'],['command','命令输出']]
});
$('session-switcher-filters').append(sessionFilters.view);
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
$('close-all-tabs').addEventListener('click', () => { void closeAllTabs().catch(error => status(message(error))); });
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
  $('transfer-filters').querySelector('[aria-pressed="true"]')?.focus();
});
for (const control of $('transfer-pages').children) control.onclick = () => {
  transferPage = control.dataset.transferPage;
  renderTransferSummary();
};
$('transfer-search').addEventListener('input', renderTransferSummary);
$('clear-transfers').addEventListener('click', () => removeTransferHistory().catch((error) => status(message(error))));
for (const control of transferFilters) {
  control.addEventListener('click', () => {
    transferDirection = control.dataset.direction;
    for (const filter of transferFilters) filter.setAttribute('aria-pressed', String(filter === control));
    renderTransferSummary();
  });
}
$('save-layout').addEventListener('click', () => saveSessionLayout().catch((error) => status(message(error))));
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
  if (event.defaultPrevented || event.isComposing || dialog.open || fileEditor.open || $('key-dialog').open || sessionSwitcher.open || vaultStatus.locked || hostMenu) return;
  if (event.key === 'Escape' && !$('terminal-find').hidden) { event.preventDefault(); $('close-find').click(); return; }
  if (event.key === 'Escape' && serverInfoOpen && $('server-info').contains(document.activeElement)) { event.preventDefault(); toggleServerInfo(); return; }
  const action = keyboard.action(event);
  if (!action) return;
  event.preventDefault();
  if (action === 'navigation') { toggleNav.click(); return; }
  if (action === 'files') { if (origin()) toggleFiles(); return; }
  if (action === 'new-tab') { void addNewTab(); return; }
  if (action === 'close-tab') {
    if (active) void closeWorkspaceTab(active).catch((error) => status(message(error)));
    return;
  }
  if (action.startsWith('tab-')) {
    const tab = workspaceFocus(workspaceEntries()[Number(action.slice(4)) - 1]);
    if (tab) selectTab(tab);
    return;
  }
  if (['previous-tab', 'next-tab'].includes(action)) {
    const entries = workspaceEntries();
    if (entries.length) {
      const index = entries.findIndex(entry => entry.panes.includes(active?.id));
      const step = action === 'next-tab' ? 1 : -1;
      selectTab(workspaceFocus(entries[(index + step + entries.length) % entries.length]));
    }
    return;
  }
  if (action === 'search') { openGlobalSearch(); return; }
  if (action === 'sessions') { if (tabs.size > 1) chooseSession(); return; }
  if (action === 'find' && active?.terminal && (!active.connectionPage || active.connectionPage.hidden)) {
    $('terminal-find').hidden = false;
    $('terminal-find').querySelector('input').focus();
  }
  if (active?.terminal && action.startsWith('zoom-')) {
    active.terminal.options.fontSize = action === 'zoom-reset' ? uiPreferences.fontSize
      : Math.min(32, Math.max(9, active.terminal.options.fontSize + (action === 'zoom-out' ? -1 : 1)));
    active.rendering.fit();
  }
});
api.vault.state().then((state) => { applyVaultState(state); if (!state.locked) return refreshHosts(); }).catch((error) => status(message(error)));
selectTab();

for (const [feature, section, label, icon] of [
  ['preferences','preferences','外观与终端','settings'], ['vault','security','安全与同步','lock'], ['groups','groups','分组管理','group'],
  ['identities','identities','登录配置','key'], ['snippets','snippets','命令库','terminal'],
  ['layouts','layouts','会话布局','new-tab'], ['logs','logs','会话日志','file'],
  ['trust','trust','Known Hosts','lock'], ['updates','updates','关于与更新','settings']
]) if (api[feature]) {
  const control = sidebarAction(label, icon, () => openSettings(section));
  control.dataset.section = section;
  $('workspace-tools').append(control);
}
if (api.updates) {
  void api.updates.status().then(acceptAppUpdateState).catch(() => {});
  setTimeout(() => {
    if (localStorage.getItem('updates-on-start') !== 'false') {
      void api.updates.check().then(state => { acceptAppUpdateState(state); renderAppUpdates(); }).catch(() => {});
    }
  }, 8000);
}
if(api.preferences) matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(uiPreferences.theme==='system')applyPreferences();});
