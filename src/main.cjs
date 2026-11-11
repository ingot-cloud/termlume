const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isIP } = require('node:net');
const { WorkspaceSSH, commandFor } = require('./ssh.cjs');
const { Transfers } = require('./transfers.cjs');
const { scanKeys, generateKey, agentKeys } = require('./keys.cjs');
const { importSSHConfig } = require('./ssh-config.cjs');
const vault = require('./vault.cjs');
const { branchName, defaultBranch, remoteURL, resolveAuth, useRepository, mergeSnapshots, sameRecord } = require('./git-vault.cjs');

const pageURL = 'termlume://workspace/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'termlume', privileges: { standard: true, secure: true } }]);
app.setName('Termlume');
if (process.env.TERMLUME_DATA_DIR) app.setPath('userData', path.resolve(process.env.TERMLUME_DATA_DIR));

function checkedText(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`请输入有效的${label}。`);
  return value.trim();
}

function normalizeHost(input, id, { portable = false, allowMissingKey = false } = {}) {
  const address = checkedText(input.address, '主机地址', 255).replace(/^\[(.*)\]$/, '$1');
  if (!address || /[\s/@\\]/.test(address) || (address.includes(':') && isIP(address) !== 6)) throw new Error('请输入主机名或 IP 地址。');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须在 1 至 65535 之间。');
  if (!['agent', 'key', 'password'].includes(input.auth)) throw new Error('请选择认证方式。');
  const host = {
    id, address, port, auth: input.auth,
    name: input.name?.trim() ? checkedText(input.name, '主机名称') : address, username: checkedText(input.username, 'SSH 用户名'),
    group: input.group?.trim() ? checkedText(input.group, '分组') : '',
    tags: [...new Set((input.tags || []).map((tag) => checkedText(tag, '标签', 40)))].slice(0, 20),
    note: input.note?.trim() ? checkedText(input.note, '备注', 1024) : '',
    logPath: input.logPath?.trim() ? checkedText(input.logPath, '日志路径', 4096) : '',
    service: input.service?.trim() ? checkedText(input.service, '服务名', 255) : ''
  };
  if (input.localForwards !== undefined) {
    if (!Array.isArray(input.localForwards) || input.localForwards.length > 32) throw new Error('本地转发规则无效。');
    if(input.localForwards.some(r=>r.kind&&r.kind!=='local')) throw new Error('远程/动态转发数据需使用 macOS Tauri 应用。');
    host.localForwards = input.localForwards.map((rule) => {
      const localPort = Number(rule.localPort), remotePort = Number(rule.remotePort);
      const remoteAddress = checkedText(rule.remoteAddress, '目标地址', 255).replace(/^\[(.*)\]$/, '$1');
      if (!remoteAddress || /[\s/@\\]/.test(remoteAddress) || (remoteAddress.includes(':') && isIP(remoteAddress) !== 6) ||
          ![localPort, remotePort].every((port) => Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('本地转发规则无效。');
      return { id: checkId(rule.id), name: checkedText(rule.name, '规则名称'), localPort, remoteAddress, remotePort };
    });
    if (new Set(host.localForwards.map((r) => r.id)).size !== host.localForwards.length ||
        new Set(host.localForwards.map((r) => r.localPort)).size !== host.localForwards.length) throw new Error('转发规则标识和本地端口不能重复。');
    if (!host.localForwards.length) delete host.localForwards;
  }
  if(input.startupCommand) host.startupCommand=checkedText(input.startupCommand,'启动命令',16384);
  if(input.startupEnabled) host.startupEnabled=true;
  if (input.identityId) throw new Error('登录配置需使用 macOS Tauri 应用。');
  if (input.jumpHostId) host.jumpHostId = checkId(input.jumpHostId);
  if (host.logPath) commandFor({ action: 'tail', argument: host.logPath });
  if (host.service) commandFor({ action: 'journal', argument: host.service });
  if (host.auth === 'key' && !portable && (input.keyPath?.trim() || !allowMissingKey)) {
    host.keyPath = checkedText(input.keyPath, '私钥文件路径', 4096);
    if (!path.isAbsolute(host.keyPath)) throw new Error('请选择本机私钥文件。');
  }
  return host;
}

class HostStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workspace.json');
    try {
      const document = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (vault.isVault(document)) this.envelope = vault.validateEnvelope(document, 'local');
      else this.data = document;
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { hosts: [], fingerprints: [] };
    }
    this.passwordAttempts = new Map();
  }

  write(document) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(document)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  update(data) {
    if (this.envelope && !this.key) throw new Error('请先解锁保险库。');
    const document = this.envelope ? vault.encodeVault(this.key, this.envelope.header, 'local', data) : data;
    this.write(document);
    if (this.envelope) this.envelope = document;
    this.data = data;
  }

  installVault(key, header, data) {
    const envelope = vault.encodeVault(key, header, 'local', data);
    this.write(envelope);
    this.envelope = envelope;
    this.key = key;
    this.data = data;
  }

  lock() {
    if (!this.key) return;
    this.key.fill(0);
    this.key = undefined;
    this.data = undefined;
    this.passwordAttempts.clear();
  }

  host(id) {
    const host = this.data.hosts.find((entry) => entry.id === id);
    if (!host) throw new Error('主机已删除，请重新选择。');
    return host;
  }

  save(input) {
    const previous = input.id ? this.host(input.id) : undefined;
    const id = previous?.id ?? randomUUID();
    const host = normalizeHost(input, id, { allowMissingKey: previous?.auth === 'key' && !previous.keyPath });
    if (previous?.localForwards?.length) host.localForwards = previous.localForwards;
    const hosts = this.data.hosts.filter((entry) => entry.id !== id);
    if (host.jumpHostId) {
      const jump = hosts.find((item) => item.id === host.jumpHostId);
      if (!jump || jump.jumpHostId || this.sameEndpoint(jump, host)) throw new Error('请选择一台有效的直连主机作为跳板机。');
      if (hosts.some((item) => item.jumpHostId === id)) throw new Error('该主机被用作跳板机，不能再设置跳板。');
    }
    const resetPassword = previous && (host.auth !== 'password' || !this.sameEndpoint(previous, host) || previous.username !== host.username);
    const localPasswords = resetPassword ? this.withoutPasswords([id]) : this.data.localPasswords;
    const portablePasswords = resetPassword ? this.withoutPasswords([id], this.data.portablePasswords || {}) : this.data.portablePasswords;
    this.update({ ...this.data, hosts: [...hosts, host], localPasswords, portablePasswords });
    this.passwordAttempts.delete(id);
    return this.data.hosts;
  }

  remove(id) {
    if (this.data.hosts.some((host) => host.jumpHostId === id)) throw new Error('该主机仍被用作跳板机，请先修改相关主机的连接路径。');
    const localPasswords = this.withoutPasswords([id]);
    const portablePasswords = this.withoutPasswords([id], this.data.portablePasswords || {});
    this.update({ ...this.data, hosts: this.data.hosts.filter((entry) => entry.id !== id), localPasswords, portablePasswords });
    this.passwordAttempts.delete(id);
    return this.data.hosts;
  }

  removeGroup(group) {
    this.update({ ...this.data, hosts: this.data.hosts.map((host) => host.group === group ? { ...host, group: '' } : host) });
    return this.data.hosts;
  }

  import(rows, keepDuplicates) {
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('导入数量过多。');
    const previous = this.data.hosts;
    const hosts = [...previous];
    for (const row of rows) {
      const host = normalizeHost(row, randomUUID());
      if (keepDuplicates || !hosts.some((item) => this.sameEndpoint(item, host) && item.username === host.username)) hosts.push(host);
    }
    this.update({ ...this.data, hosts });
    return { hosts, count: hosts.length - previous.length };
  }

  passwordFor(host) { return host.auth === 'password' ? this.data.localPasswords?.[host.id] : undefined; }

  portablePasswordFor(host) { return host.auth === 'password' ? this.data.portablePasswords?.[host.id] : undefined; }

  withoutPasswords(ids, source = this.data.localPasswords) {
    const passwords = { ...source };
    for (const id of ids) delete passwords[id];
    return passwords;
  }

  clearPassword(id) {
    this.host(id);
    this.update({ ...this.data, localPasswords: this.withoutPasswords([id]), portablePasswords: this.withoutPasswords([id], this.data.portablePasswords || {}) });
    this.passwordAttempts.delete(id);
  }

  sameEndpoint(a, b) { return a.address.toLowerCase() === b.address.toLowerCase() && a.port === b.port; }

  fingerprint(host) { return this.data?.fingerprints.find((entry) => this.sameEndpoint(entry, host))?.fingerprint; }

  trust(host, fingerprint) {
    const existing = this.fingerprint(host);
    if (existing && existing !== fingerprint) throw new Error('另一条连接已信任不同指纹，请重新核对。');
    if (existing) return;
    const { address, port } = host;
    this.update({ ...this.data, fingerprints: [...this.data.fingerprints, { address, port, fingerprint }] });
  }

  forget(id) {
    const host = this.host(id);
    const affected = this.data.hosts.filter((entry) => this.sameEndpoint(entry, host)).map((entry) => entry.id);
    this.update({ ...this.data, fingerprints: this.data.fingerprints.filter((entry) => !this.sameEndpoint(entry, host)), localPasswords: this.withoutPasswords(affected) });
    for (const id of affected) this.passwordAttempts.delete(id);
  }
}

function passwordTarget(host, fingerprint) {
  return JSON.stringify([host.id, host.address.toLowerCase(), host.port, host.username, fingerprint]);
}

async function requirePasswordEncryption() {
  if (process.platform !== 'darwin' || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error('macOS 钥匙串暂不可用。');
}

async function savedPassword(host) {
  const encrypted = store.passwordFor(host);
  const fingerprint = store.fingerprint(host);
  const portable = store.portablePasswordFor(host);
  if (portable && (!fingerprint || fingerprint === portable.fingerprint)) return { ...portable, fromVault: true };
  try {
    if (!encrypted || !fingerprint) throw new Error();
    await requirePasswordEncryption();
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'));
    const { target, password } = JSON.parse(result);
    if (target !== passwordTarget(host, fingerprint) || typeof password !== 'string' || !password || password.length > 4096
      || !store.data?.hosts.includes(host) || store.passwordFor(host) !== encrypted || store.fingerprint(host) !== fingerprint) throw new Error();
    return { password, fingerprint };
  } catch {
    throw new Error('无法使用已保存的密码，请重新输入。');
  }
}

function rememberPassword(id, host, password, share) {
  const attempt = Symbol();
  store.passwordAttempts.set(host.id, attempt);
  return async (fingerprint) => {
    const stillCurrent = () => store.passwordAttempts.get(host.id) === attempt
      && store.data?.hosts.includes(host) && fingerprint && store.fingerprint(host) === fingerprint;
    try {
      if (!stillCurrent()) return;
      await requirePasswordEncryption();
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ target: passwordTarget(host, fingerprint), password }));
      if (!stillCurrent()) return;
      const portablePasswords = store.withoutPasswords([host.id], store.data.portablePasswords || {});
      if (share && store.key) portablePasswords[host.id] = { password, fingerprint };
      store.update({ ...store.data, localPasswords: { ...store.data.localPasswords, [host.id]: encrypted.toString('base64') }, portablePasswords });
      emit({ type: 'password', id, message: '已加密保存 SSH 密码。' });
    } catch {
      if (stillCurrent()) emit({ type: 'password', id, message: 'SSH 已连接，密码保存失败，请检查 macOS 钥匙串。', failed: true });
    } finally {
      if (store.passwordAttempts.get(host.id) === attempt) store.passwordAttempts.delete(host.id);
    }
  };
}

const rendererDir = path.join(__dirname, 'ui');
const dependencies = path.join(__dirname, '..', 'node_modules', '@xterm');
const resources = new Map([
  ['/index.html', [path.join(rendererDir, 'index.html'), 'text/html']],
  ['/style.css', [path.join(rendererDir, 'style.css'), 'text/css']],
  ['/workspace-state.js',[path.join(rendererDir,'workspace-state.js'),'text/javascript']],
  ['/renderer.js', [path.join(rendererDir, 'renderer.js'), 'text/javascript']],
  ['/dropdown.js', [path.join(rendererDir, 'dropdown.js'), 'text/javascript']],
  ['/overlays.js', [path.join(rendererDir, 'overlays.js'), 'text/javascript']],
  ['/terminal-paths.js', [path.join(rendererDir, 'terminal-paths.js'), 'text/javascript']],
  ['/xterm.js', [path.join(dependencies, 'xterm/lib/xterm.js'), 'text/javascript']],
  ['/xterm.css', [path.join(dependencies, 'xterm/css/xterm.css'), 'text/css']],
  ['/fit.js', [path.join(dependencies, 'addon-fit/lib/addon-fit.js'), 'text/javascript']],
  ['/search.js', [path.join(dependencies, 'addon-search/lib/addon-search.js'), 'text/javascript']]
]);

let window;
let store;
let ssh;
let transfers;
const historyLimit = 200;
let pendingTransferHistory = [];
const tickets = new Map();
let droppedFiles;
const defaultKeyDirectory = path.join(os.homedir(), '.ssh');
const keyDirectories = new Set([defaultKeyDirectory]);
function autoLockMinutes() {
  const { autoLockMinutes: minutes = 15 } = store.data?.lockSettings || {};
  return minutes;
}
let lastActivity = Date.now();
let syncTask;
let pendingConflict;
const emit = (event) => {
  if (window && !window.isDestroyed()) window.webContents.send('workspace:event', event);
};

function transferHistory(edit = (records) => records) {
  const stored = store.data.transferHistory || [];
  const records = edit([...stored, ...pendingTransferHistory]).slice(-historyLimit);
  if (records.length !== stored.length || records.some((item, index) => item !== stored[index])) {
    store.update({ ...store.data, transferHistory: records });
  }
  pendingTransferHistory = [];
  return records;
}

function publishTransfer(event) {
  if (!['queued', 'running', 'committing'].includes(event.status)) {
    event.finishedAt = Date.now();
    pendingTransferHistory.push(event);
    if (pendingTransferHistory.length > historyLimit) pendingTransferHistory.shift();
    if (store.data) {
      try { transferHistory(); } catch { /* Retry on the next history read. */ }
    }
  }
  emit(event);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1140, height: 740, minWidth: 550, minHeight: 490,
    titleBarStyle: 'hiddenInset', backgroundColor: '#151923', title: 'Termlume',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => {
    window = undefined;
    for (const id of ssh.sessions.keys()) transfers.cancelSession(id);
    ssh.dispose();
    tickets.clear();
    droppedFiles = undefined;
  });
  void window.loadURL(pageURL);
}

function verified(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url === pageURL && !event.senderFrame.parent;
}

function handle(name, fn) {
  ipcMain.handle(name, (event, request) => {
    if (!verified(event)) throw new Error('工作台请求来源无效。');
    if (!store.data && !['vault:state', 'vault:unlock'].includes(name)) throw new Error('请先解锁保险库。');
    lastActivity = Date.now();
    return fn(request);
  });
}

function listen(name, fn) {
  ipcMain.on(name, (event, request) => {
    if (!verified(event) || (!store.data && name !== 'ssh:ack')) return;
    fn(request);
  });
}

function checkId(id) {
  if (typeof id !== 'string' || !/^[\da-f-]{36}$/.test(id)) throw new Error('会话标识无效。');
  return id;
}

function vaultState() {
  const sync = store.data?.sync;
  const migration = store.data?.gitMigration;
  return {
    enabled: Boolean(store.envelope), locked: !store.data, remote: sync?.remote || '',
    autoLockMinutes: autoLockMinutes(),
    branch: sync ? sync.branch ?? defaultBranch : undefined,
    lastSynced: sync?.lastSynced,
    gitMigration: migration ? { remote: migration.remote, branch: migration.branch } : undefined
  };
}

function lockVault() {
  if (!store.key) return vaultState();
  syncTask?.abort();
  pendingConflict = undefined;
  droppedFiles = undefined;
  store.lock();
  for (const [id, session] of ssh.sessions) {
    if (session.channel) continue;
    ssh.disconnect(id);
    emit({ type: 'session', id, status: 'closed', message: '保险库已锁定，解锁后可重连。' });
  }
  const state = vaultState();
  emit({ type: 'vault', state });
  return state;
}

function portableRows(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('保险库主机列表无效。');
  const ids = new Set();
  const modernFields = ['groupId', 'identityId', 'inheritPort', 'inheritIdentity', 'inheritTheme', 'terminalTheme', 'startupCommand', 'startupEnabled', 'autoReconnect', 'keepaliveInterval', 'connectTimeout'];
  if (rows.some((row) => row?.asset || modernFields.some((key) => Object.hasOwn(row || {}, key)))) {
    throw new Error('此保险库包含新版共享资料或连接设置，请使用 macOS Tauri 应用。');
  }
  return rows.map((row) => {
    const id = checkId(row?.id);
    if (ids.has(id)) throw new Error('保险库包含重复的主机标识。');
    ids.add(id);
    const host = normalizeHost(row, id, { portable: true });
    if (row.password !== undefined) {
      const { password, fingerprint } = row.password || {};
      if (host.auth !== 'password' || typeof password !== 'string' || !password || password.length > 4096
        || typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('保险库凭据格式无效。');
      host.password = { password, fingerprint };
    }
    return host;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function snapshot(data = store.data) {
  return portableRows(data.hosts.map((host) => ({ ...host, password: data.portablePasswords?.[host.id] })));
}

function applySnapshot(data, rows, sync) {
  const previous = new Map(data.hosts.map((host) => [host.id, host]));
  const localPasswords = {};
  const portablePasswords = {};
  const hosts = rows.map(({ password, ...host }) => {
    const old = previous.get(host.id);
    if (old && store.sameEndpoint(old, host) && old.username === host.username && old.auth === host.auth) {
      if (old.keyPath) host.keyPath = old.keyPath;
      if (data.localPasswords?.[host.id] && sameRecord(data.portablePasswords?.[host.id], password)) localPasswords[host.id] = data.localPasswords[host.id];
    }
    if (password) portablePasswords[host.id] = password;
    return host;
  });
  return { ...data, hosts, localPasswords, portablePasswords, sync };
}

function unchangedVault(key) {
  if (!store.data || store.key !== key) throw new Error('保险库已锁定，请解锁后重试。');
}

function requireEmptyProfile() {
  if (store.envelope || store.data.hosts.length) throw new Error('恢复需要空工作区。请先保留当前数据，再在空工作区恢复。');
  return store.data;
}

async function restoreEnvelope(envelope, secret, useRecovery, original, sync) {
  vault.validateEnvelope(envelope, 'portable');
  const { key, data } = await vault.unlockVault(envelope, secret, useRecovery);
  try {
    if (requireEmptyProfile() !== original) throw new Error('工作区已变化，请重试恢复。');
    if (sync && data.parentCommit !== sync.parent) throw new Error('快照与仓库提交历史不一致。');
    const rows = portableRows(data.hosts);
    const binding = sync ? {
      remote: sync.remote, branch: sync.branch, syncKey: sync.syncKey, auth: sync.auth,
      commit: sync.commit, base: rows, lastSynced: sync.lastSynced
    } : undefined;
    store.installVault(key, envelope.header, applySnapshot({ hosts: [], fingerprints: [] }, rows, binding));
  } catch (error) { key.fill(0); throw error; }
  return vaultState();
}

function summarized(row) {
  if (!row) return { deleted: true };
  const { password, ...host } = row;
  return { ...host, passwordSaved: Boolean(password) };
}

function snapshotAt(tip, key, vaultId, gitKey) {
  const envelope = vault.openGitEnvelope(tip.envelope, gitKey);
  if (envelope.header.id !== vaultId) throw new Error('仓库中是另一套保险库。');
  const data = vault.decodeVault(key, envelope, 'portable');
  if ((data.parentCommit ?? null) !== tip.parent) throw new Error('快照与仓库提交历史不一致。');
  return portableRows(data.hosts);
}

async function synchronize({ address, branch: requestedBranch, auth: enteredAuth, changeConnection, syncKey: enteredKey, ticket, choices } = {}) {
  if (!store.key) throw new Error('请先启用并解锁保险库。');
  if (syncTask) throw new Error('已有同步任务正在运行。');
  if (store.data.gitMigration) throw new Error('请先继续或放弃待完成的 Git 迁移。');
  const binding = store.data.sync;
  const remote = remoteURL(address || binding?.remote);
  if (binding?.remote && binding.remote !== remote && !changeConnection) throw new Error('请在同步设置中更改仓库连接。');
  const currentBranch = binding?.branch ?? defaultBranch;
  const branch = branchName(requestedBranch ?? currentBranch);
  const switching = binding && currentBranch !== branch;
  const changingRemote = binding && binding.remote !== remote;
  if ((switching || changingRemote) && !binding.commit) throw new Error('请先完成当前分支的首次同步。');
  const auth = resolveAuth(remote, enteredAuth, binding?.remote === remote ? binding.auth : undefined);
  const syncKey = enteredKey?.trim() || binding?.syncKey;
  const key = store.key;
  const header = store.envelope.header;
  const controller = syncTask = new AbortController();
  try {
    return await useRepository(remote, branch, controller.signal, async ({ fetch, descendant, push }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const tip = await fetch();
        unchangedVault(key);
        let prior = store.data.sync;
        if (!prior && tip) throw new Error('仓库的同步分支已有保险库，请用「从 Git 恢复」。');
        if (prior?.commit && (!tip || !await descendant(prior.commit, tip.commit))) {
          if (changingRemote) throw new Error('新地址必须指向包含上次同步提交的仓库。换到空仓库请用「迁移到新仓库」。');
          if (switching) throw new Error('目标分支必须包含上次同步的提交。请先在 Git 服务上创建或重命名分支。');
          throw new Error('远端同步分支已删除或历史已重写，同步已暂停。');
        }
        unchangedVault(key);
        if (!prior) {
          prior = { remote, branch, auth, commit: null, base: [] };
          store.update({ ...store.data, sync: prior });
        }
        const oldFormat = tip && vault.isProtectedGitEnvelope(tip.envelope);
        const gitKey = oldFormat && syncKey ? vault.gitKey(syncKey) : undefined;
        let theirs;
        try { theirs = tip ? snapshotAt(tip, key, header.id, gitKey) : []; } finally { gitKey?.fill(0); }
        const ours = snapshot();
        const decision = pendingConflict && pendingConflict.ticket === ticket && pendingConflict.remote === remote && pendingConflict.branch === branch
          && pendingConflict.commit === tip?.commit && !pendingConflict.migration
          && sameRecord(pendingConflict.local, ours) ? choices : undefined;
        const { records, conflicts } = mergeSnapshots(prior.base, ours, theirs, decision);
        if (conflicts.length) {
          const conflictTicket = randomUUID();
          pendingConflict = { ticket: conflictTicket, remote, branch, commit: tip?.commit, local: ours };
          return { ticket: conflictTicket, conflicts: conflicts.map((item) => ({ id: item.id, local: summarized(item.local), remote: summarized(item.remote) })) };
        }
        let commit = tip?.commit;
        if (!tip || oldFormat || !sameRecord(records, theirs)) {
          try {
            const envelope = vault.encodeVault(key, header, 'portable', { hosts: records, parentCommit: tip?.commit || null });
            commit = await push(envelope, tip?.commit);
          }
          catch (error) { if (error.concurrent && attempt < 2) continue; throw error; }
        }
        unchangedVault(key);
        const latest = snapshot();
        // Edits made while the network operation ran stay pending on top of the accepted commit.
        const keepNewer = Object.fromEntries(ours.concat(latest).map((row) => [row.id, 'local']));
        const local = mergeSnapshots(ours, latest, records, keepNewer).records;
        store.update(applySnapshot(store.data, local, { remote, branch, auth, commit, base: records, lastSynced: Date.now() }));
        pendingConflict = undefined;
        return { state: vaultState(), pending: !sameRecord(local, records) };
      }
    }, auth);
  } finally { syncTask = undefined; }
}

async function migrateGit({ address, branch: requestedBranch, auth: enteredAuth, syncKey: enteredKey, ticket, choices, abandon } = {}) {
  if (!store.key) throw new Error('请先启用并解锁保险库。');
  if (syncTask) throw new Error('已有同步任务正在运行。');
  const pending = store.data.gitMigration;
  if (abandon) {
    if (pending) {
      store.update({ ...store.data, gitMigration: undefined });
      pendingConflict = undefined;
    }
    return { state: vaultState() };
  }
  const prior = store.data.sync;
  if (!prior?.commit) throw new Error('请先完成旧仓库的首次同步。');
  const remote = remoteURL(address || pending?.remote);
  const branch = branchName(requestedBranch ?? pending?.branch);
  if (remote === prior.remote) throw new Error('请选择一个新的空仓库。');
  if (pending && (pending.remote !== remote || pending.branch !== branch)) {
    throw new Error('请继续或放弃待完成的 Git 迁移后，再更改目标。');
  }
  const auth = resolveAuth(remote, enteredAuth, pending?.auth);
  const key = store.key;
  const header = store.envelope.header;
  const controller = syncTask = new AbortController();
  try {
    return await useRepository(remote, branch, controller.signal, async (destination) => {
      const refs = await destination.refs();
      let commit, records, syncKey;
      if (pending && destination.advertisedCommit(refs) === pending.commit) {
        const tip = await destination.fetch();
        if (tip?.commit !== pending.commit || tip.parent !== null) throw new Error('新仓库刚有更新，请核对目标仓库。');
        commit = tip.commit;
        syncKey = pending.syncKey;
        const legacyKey = syncKey ? vault.gitKey(syncKey) : undefined;
        try { records = snapshotAt(tip, key, header.id, legacyKey); } finally { legacyKey?.fill(0); }
      } else {
        if (refs) throw new Error('目标仓库必须为空，请创建不含分支或标签的新仓库。');
        const staged = await useRepository(prior.remote, prior.branch ?? defaultBranch, controller.signal, async (source) => {
          const tip = await source.fetch();
          if (!tip) throw new Error('旧同步分支已删除。');
          if (!await source.descendant(prior.commit, tip.commit)) throw new Error('旧同步分支的历史已重写，迁移已暂停。');
          const sourceSecret = enteredKey?.trim() || prior.syncKey;
          const sourceKey = sourceSecret && vault.isProtectedGitEnvelope(tip.envelope) ? vault.gitKey(sourceSecret) : undefined;
          let theirs;
          try { theirs = snapshotAt(tip, key, header.id, sourceKey); } finally { sourceKey?.fill(0); }
          unchangedVault(key);
          const ours = snapshot();
          const migration = { remote, branch };
          const decision = pendingConflict?.ticket === ticket && pendingConflict?.commit === tip.commit
            && sameRecord(pendingConflict.migration, migration) && sameRecord(pendingConflict.local, ours) ? choices : undefined;
          const { records, conflicts } = mergeSnapshots(prior.base, ours, theirs, decision);
          if (conflicts.length) {
            const conflictTicket = randomUUID();
            pendingConflict = { ticket: conflictTicket, commit: tip.commit, local: ours, migration };
            return { ticket: conflictTicket, conflicts: conflicts.map((item) => ({ id: item.id, local: summarized(item.local), remote: summarized(item.remote) })) };
          }
          const envelope = vault.encodeVault(key, header, 'portable', { hosts: records, parentCommit: null });
          const commit = await destination.createCommit(envelope);
          if (source.advertisedCommit(await source.refs()) !== tip.commit) throw new Error('旧仓库刚有更新，请重试迁移。');
          if (await destination.refs()) throw new Error('目标仓库已出现提交，请更换空仓库。');
          unchangedVault(key);
          const latest = snapshot();
          const keepNewer = Object.fromEntries(ours.concat(latest).map((row) => [row.id, 'local']));
          const local = mergeSnapshots(ours, latest, records, keepNewer).records;
          const data = applySnapshot(store.data, local, { ...prior, commit: tip.commit, base: theirs });
          store.update({ ...data, gitMigration: { remote, branch, auth, commit } });
          await destination.pushCommit(commit, true);
          return { commit, records };
        }, prior.auth);
        if (staged.conflicts) return staged;
        ({ commit, records } = staged);
      }
      unchangedVault(key);
      const sync = { remote, branch, syncKey, auth, commit, base: records, lastSynced: Date.now() };
      store.update({ ...store.data, sync, gitMigration: undefined });
      pendingConflict = undefined;
      return { state: vaultState(), pending: !sameRecord(snapshot(), records) };
    }, auth);
  } finally { syncTask = undefined; }
}

function registerVaultHandlers() {
  handle('vault:state', vaultState);
  listen('vault:activity', () => { lastActivity = Date.now(); });
  handle('vault:recovery-code', vault.recoveryCode);
  handle('vault:copy-recovery', (code) => {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('恢复密钥格式无效。');
    clipboard.writeText(code);
  });
  handle('vault:enable', async ({ password, recovery }) => {
    if (store.envelope) throw new Error('保险库已启用。');
    const { key, header } = await vault.createVault(password, recovery);
    try {
      if (store.envelope) throw new Error('保险库已启用。');
      store.installVault(key, header, store.data);
    } catch (error) { key.fill(0); throw error; }
    return vaultState();
  });
  handle('vault:lock', lockVault);
  handle('vault:set-auto-lock', (minutes) => {
    if (!store.key) throw new Error('请先启用并解锁保险库。');
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      throw new Error('自动锁定时间须为 1–1440 分钟，或关闭自动锁定。');
    }
    store.update({ ...store.data, lockSettings: { ...store.data.lockSettings, autoLockMinutes: minutes } });
    return vaultState();
  });
  handle('vault:unlock', async ({ secret, useRecovery }) => {
    if (store.data || !store.envelope) return vaultState();
    const envelope = store.envelope;
    const { key, data } = await vault.unlockVault(envelope, secret, useRecovery === true);
    if (store.data || store.envelope !== envelope) { key.fill(0); return vaultState(); }
    store.key = key;
    store.data = data;
    lastActivity = Date.now();
    return vaultState();
  });
  handle('vault:export', async () => {
    const key = store.key;
    if (!key) throw new Error('请先启用保险库。');
    const { filePath } = await dialog.showSaveDialog(window, { title: '导出加密备份', defaultPath: 'termlume-vault.json' });
    if (!filePath) return false;
    unchangedVault(key);
    const document = vault.encodeVault(key, store.envelope.header, 'portable', { hosts: snapshot() });
    await fs.promises.writeFile(filePath, JSON.stringify(document), { flag: 'wx', mode: 0o600 });
    return true;
  });
  handle('vault:restore-file', async ({ secret, useRecovery }) => {
    const original = requireEmptyProfile();
    const { filePaths } = await dialog.showOpenDialog(window, { title: '选择加密备份', properties: ['openFile'] });
    if (!filePaths[0]) return null;
    const stat = await fs.promises.stat(filePaths[0]);
    if (!stat.isFile() || stat.size > vault.maxDocumentSize) throw new Error('保险库备份大小无效。');
    return restoreEnvelope(JSON.parse(await fs.promises.readFile(filePaths[0], 'utf8')), secret, useRecovery === true, original);
  });
  handle('vault:restore-git', async ({ address, branch: requestedBranch, auth: enteredAuth, syncKey, secret, useRecovery }) => {
    const original = requireEmptyProfile();
    const remote = remoteURL(address);
    const branch = branchName(requestedBranch);
    const auth = resolveAuth(remote, enteredAuth);
    return useRepository(remote, branch, undefined, async ({ fetch }) => {
      const tip = await fetch();
      if (!tip) throw new Error('所选分支尚无备份。');
      const enteredKey = vault.isProtectedGitEnvelope(tip.envelope) ? syncKey?.trim() : undefined;
      const gitKey = enteredKey ? vault.gitKey(enteredKey) : undefined;
      try {
        const envelope = vault.openGitEnvelope(tip.envelope, gitKey);
        return restoreEnvelope(envelope, secret, useRecovery === true, original, {
          remote, branch, auth, syncKey: enteredKey || undefined, commit: tip.commit, parent: tip.parent, lastSynced: Date.now()
        });
      } finally { gitKey?.fill(0); }
    }, auth);
  });
  handle('vault:sync', synchronize);
  handle('vault:migrate-git', migrateGit);
}

function registerHandlers() {
  registerVaultHandlers();
  handle('keys:agent', () => agentKeys(process.env.SSH_AUTH_SOCK));
  handle('keys:scan', async (directory = defaultKeyDirectory) => {
    if (!keyDirectories.has(directory)) throw new Error('请先选择密钥目录。');
    return { directory, keys: await scanKeys(directory) };
  });
  handle('keys:directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SSH 密钥目录', defaultPath: defaultKeyDirectory, properties: ['openDirectory', 'showHiddenFiles', 'createDirectory'] });
    const directory = result.filePaths[0];
    if (directory) keyDirectories.add(directory);
    return directory;
  });
  handle('keys:generate', async ({ directory, name, passphrase }) => {
    if (!keyDirectories.has(directory)) throw new Error('请先选择密钥目录。');
    if (directory === defaultKeyDirectory) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    return generateKey(directory, name, passphrase);
  });
  handle('keys:copy', (publicKey) => {
    if (typeof publicKey !== 'string' || !/^[\w@.-]+ [A-Za-z0-9+/=]+(?: [^\r\n\x00]*)?$/.test(publicKey) || publicKey.length > 32768) throw new Error('公钥格式无效。');
    clipboard.writeText(publicKey);
  });
  handle('hosts:list', () => store.data.hosts);
  handle('hosts:recent', () => store.data.recent || {});
  handle('hosts:touch', (id) => { store.host(id); store.update({ ...store.data, recent: { ...store.data.recent, [id]: Date.now() } }); });
  handle('hosts:save', (host) => store.save(host));
  handle('hosts:delete', (id) => store.remove(id));
  handle('hosts:forget', (id) => store.forget(id));
  handle('hosts:has-password', (id) => {
    const host = store.host(id);
    return Boolean(store.passwordFor(host) || store.portablePasswordFor(host));
  });
  handle('hosts:clear-password', (id) => store.clearPassword(id));
  handle('hosts:remove-group', (group) => store.removeGroup(checkedText(group, '分组')));
  handle('hosts:import-preview', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 OpenSSH 配置', defaultPath: path.join(defaultKeyDirectory, 'config'), properties: ['openFile', 'showHiddenFiles'] });
    const file = result.filePaths[0];
    if (!file) return null;
    const handle = await fs.promises.open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('请选择不超过 1 MiB 的 OpenSSH 配置文件。');
      return importSSHConfig(await handle.readFile('utf8'), os.homedir());
    } finally { await handle.close(); }
  });
  handle('hosts:import', ({ rows, keepDuplicates }) => store.import(rows, keepDuplicates === true));
  handle('hosts:key-picker', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SSH 私钥', properties: ['openFile', 'showHiddenFiles'] });
    return result.filePaths[0];
  });

  handle('ssh:connect', ({ id, expected, secret, dimensions, useSaved, remember, sharePassword }) => {
    checkId(id);
    const host = store.host(expected?.id);
    if (host.jumpHostId) throw new Error('跳板连接需使用 macOS 应用。');
    if (['address', 'port', 'username', 'auth', 'keyPath', 'jumpHostId'].some((field) => host[field] !== expected[field])) {
      throw new Error('主机配置已变更，请从主机列表新建会话。');
    }
    if (typeof secret !== 'string' || secret.length > 4096) throw new Error('SSH 凭据无效。');
    if (host.auth !== 'password') return ssh.connect(id, host, secret, dimensions);
    if (useSaved === true) {
      return ssh.connect(id, host, '', dimensions, { getSavedPassword: () => savedPassword(host) });
    }
    if (!secret) throw new Error('请输入 SSH 密码。');
    const onAuthenticated = remember === true ? rememberPassword(id, host, secret, sharePassword === true) : undefined;
    return ssh.connect(id, host, secret, dimensions, { onAuthenticated });
  });
  handle('ssh:trust', ({ id, accepted }) => ssh.trust(id, accepted === true));
  handle('ssh:close', async (id) => { await transfers.cancelSession(id); ssh.disconnect(id); });
  listen('ssh:input', ({ id, data }) => ssh.input(id, data));
  listen('ssh:resize', ({ id, size }) => ssh.resize(id, size));
  listen('ssh:ack', (id) => ssh.acknowledge(id));
  handle('ssh:directory', (id) => ssh.directory(id));

  handle('commands:preview', commandFor);
  handle('commands:start', ({ id, sessionId, request }) => ssh.command(checkId(id), sessionId, request));
  handle('commands:stop', (id) => ssh.stop(id));
  handle('commands:close', (id) => ssh.closeCommand(id));

  handle('files:list', ({ id, directory }) => ssh.list(id, directory));
  handle('files:inspect', ({ id, path }) => ssh.inspect(id, path));
  handle('files:mkdir', ({ id, directory, name }) => ssh.mkdir(id, directory, name));
  handle('files:create-file', ({ id, directory, name }) => ssh.createFile(id, directory, name));
  handle('files:history', () => transferHistory());
  handle('files:remove-history', (value) => {
    const id = value === null ? null : checkId(value);
    const removed = [];
    transferHistory((records) => records.filter((record) => {
      if (record.direction !== 'down' || (id !== null && id !== record.id)) return true;
      removed.push(record.id);
      return false;
    }));
    return removed;
  });
  listen('files:capture-drop', ({ ticket, paths }) => {
    if (Array.isArray(paths) && paths.length > 0 && paths.length <= 100 &&
        paths.every((entry) => typeof entry === 'string' && path.isAbsolute(entry))) {
      droppedFiles = { ticket, paths, expires: Date.now() + 5 * 60_000 };
    }
  });
  handle('files:prepare', async ({ id, direction, directory, names, dropTicket }) => {
    const session = ssh.connected(id);
    if (direction !== 'up' && (direction !== 'down' || !Array.isArray(names) || names.length < 1 || names.length > 100)) {
      throw new Error('每次可选择 1 至 100 个普通文件。');
    }
    const upload = direction === 'up';
    let paths;
    if (dropTicket) {
      if (!upload || droppedFiles?.ticket !== dropTicket || droppedFiles.expires < Date.now()) {
        throw new Error('拖入的文件已失效，请重新拖入。');
      }
      paths = droppedFiles.paths;
      droppedFiles = undefined;
    } else {
      const selected = await dialog.showOpenDialog(window, {
        title: upload ? '选择要上传的文件' : '选择下载目录',
        properties: upload ? ['openFile', 'multiSelections'] : ['openDirectory', 'createDirectory']
      });
      if (selected.canceled) return null;
      paths = selected.filePaths;
    }
    if (ssh.connected(id) !== session) throw new Error('SSH 会话已变化，请重新选择文件。');
    if (paths.length > 100) throw new Error('每次可选择最多 100 个普通文件。');
    const files = await transfers.prepare(id, direction, directory, upload ? paths : names, paths[0]);
    const ticket = randomUUID();
    for (const [key, pending] of tickets) if (pending.expires < Date.now()) tickets.delete(key);
    tickets.set(ticket, { files, expires: Date.now() + 5 * 60_000 });
    return { ticket, files: files.map(({ target, exists, canReplace }) => ({ target, exists, canReplace })) };
  });
  handle('files:enqueue', ({ ticket, policy }) => {
    const pending = tickets.get(ticket);
    tickets.delete(ticket);
    if (!pending || pending.expires < Date.now()) throw new Error('传输确认已过期，请重新选择文件。');
    if (!['skip', 'replace', 'keep'].includes(policy)) throw new Error('请选择同名文件处理方式。');
    transfers.enqueue(pending.files, policy);
  });
  handle('files:discard', (ticket) => { tickets.delete(ticket); });
  handle('files:cancel', (id) => transfers.cancel(id));
  handle('files:retry', (id) => transfers.retry(id));
}

async function launch() {
  protocol.handle('termlume', async (request) => {
    const url = new URL(request.url);
    const resource = url.host === 'workspace' && resources.get(url.pathname);
    if (!resource || request.method !== 'GET') return new Response('Not found', { status: 404 });
    const [file, type] = resource;
    return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': `${type}; charset=utf-8` } });
  });
  store = new HostStore(app.getPath('userData'));
  ssh = new WorkspaceSSH(store, emit);
  transfers = new Transfers(ssh, publishTransfer);
  registerHandlers();
  setInterval(() => {
    const minutes = autoLockMinutes();
    if (store.key && minutes !== null && Date.now() - lastActivity >= minutes * 60_000) lockVault();
  }, 5_000).unref();
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox('Termlume 无法启动', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
