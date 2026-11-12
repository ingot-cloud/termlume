const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (name) => (value) => ipcRenderer.invoke(name, value);
const send = (name) => (value) => ipcRenderer.send(name, value);

function observeFileDrag(listener) {
  const fileEvent = (event) => event.isTrusted && event.dataTransfer?.types.includes('Files');
  const emit = (event, phase, count, ticket) => {
    event.preventDefault();
    listener({ type: 'file-drag', phase, position: { x: event.clientX, y: event.clientY }, count, ticket });
  };
  window.addEventListener('dragenter', (event) => {
    if (fileEvent(event)) emit(event, 'enter', event.dataTransfer.items.length || 1);
  });
  window.addEventListener('dragover', (event) => { if (fileEvent(event)) emit(event, 'over'); });
  window.addEventListener('dragleave', (event) => {
    if (fileEvent(event) && !event.relatedTarget) emit(event, 'leave');
  });
  window.addEventListener('drop', (event) => {
    if (!fileEvent(event)) return;
    const paths = Array.from(event.dataTransfer.files, (file) => webUtils.getPathForFile(file)).filter(Boolean);
    const ticket = crypto.randomUUID();
    if (paths.length && paths.length <= 100) ipcRenderer.send('files:capture-drop', { ticket, paths });
    emit(event, 'drop', paths.length, ticket);
  });
}

contextBridge.exposeInMainWorld('termlume', {
  vault: { state: invoke('vault:state'), activity: send('vault:activity'), recoveryCode: invoke('vault:recovery-code'), copyRecovery: invoke('vault:copy-recovery'), enable: invoke('vault:enable'), lock: invoke('vault:lock'), unlock: invoke('vault:unlock'), setAutoLockMinutes: invoke('vault:set-auto-lock'), export: invoke('vault:export'), restoreFile: invoke('vault:restore-file'), restoreGit: invoke('vault:restore-git'), sync: invoke('vault:sync'), migrateGit: invoke('vault:migrate-git') },
  keys: { scan: invoke('keys:scan'), agent: invoke('keys:agent'), directory: invoke('keys:directory'), generate: invoke('keys:generate'), copy: invoke('keys:copy') },
  hosts: { list: invoke('hosts:list'), recent: invoke('hosts:recent'), touch: invoke('hosts:touch'), save: invoke('hosts:save'), remove: invoke('hosts:delete'), forget: invoke('hosts:forget'), pickKey: invoke('hosts:key-picker'), hasPassword: invoke('hosts:has-password'), clearPassword: invoke('hosts:clear-password'), removeGroup: invoke('hosts:remove-group'), importPreview: invoke('hosts:import-preview'), import: invoke('hosts:import') },
  ssh: { connect: invoke('ssh:connect'), trust: invoke('ssh:trust'), close: invoke('ssh:close'), input: send('ssh:input'), resize: send('ssh:resize'), ack: send('ssh:ack'), directory: invoke('ssh:directory'), serverInfo: invoke('ssh:server-info') },
  commands: { preview: invoke('commands:preview'), start: invoke('commands:start'), stop: invoke('commands:stop'), close: invoke('commands:close') },
  files: { list: invoke('files:list'), inspect: invoke('files:inspect'), mkdir: invoke('files:mkdir'), createFile: invoke('files:create-file'), history: invoke('files:history'), removeHistory: invoke('files:remove-history'), prepare: invoke('files:prepare'), enqueue: invoke('files:enqueue'), discard: invoke('files:discard'), cancel: invoke('files:cancel'), retry: invoke('files:retry') },
  onEvent: (listener) => {
    ipcRenderer.on('workspace:event', (_event, payload) => listener(payload));
    observeFileDrag(listener);
  }
});
