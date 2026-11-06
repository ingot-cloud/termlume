const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name) => (value) => ipcRenderer.invoke(name, value);
const send = (name) => (value) => ipcRenderer.send(name, value);

contextBridge.exposeInMainWorld('termlume', {
  vault: { state: invoke('vault:state'), activity: send('vault:activity'), recoveryCode: invoke('vault:recovery-code'), copyRecovery: invoke('vault:copy-recovery'), enable: invoke('vault:enable'), lock: invoke('vault:lock'), unlock: invoke('vault:unlock'), export: invoke('vault:export'), restoreFile: invoke('vault:restore-file'), restoreGit: invoke('vault:restore-git'), sync: invoke('vault:sync') },
  keys: { scan: invoke('keys:scan'), agent: invoke('keys:agent'), directory: invoke('keys:directory'), generate: invoke('keys:generate'), copy: invoke('keys:copy') },
  hosts: { list: invoke('hosts:list'), recent: invoke('hosts:recent'), touch: invoke('hosts:touch'), save: invoke('hosts:save'), remove: invoke('hosts:delete'), forget: invoke('hosts:forget'), pickKey: invoke('hosts:key-picker'), hasPassword: invoke('hosts:has-password'), clearPassword: invoke('hosts:clear-password'), removeGroup: invoke('hosts:remove-group'), importPreview: invoke('hosts:import-preview'), import: invoke('hosts:import') },
  ssh: { connect: invoke('ssh:connect'), trust: invoke('ssh:trust'), close: invoke('ssh:close'), input: send('ssh:input'), resize: send('ssh:resize'), ack: send('ssh:ack') },
  commands: { preview: invoke('commands:preview'), start: invoke('commands:start'), stop: invoke('commands:stop'), close: invoke('commands:close') },
  files: { list: invoke('files:list'), mkdir: invoke('files:mkdir'), prepare: invoke('files:prepare'), enqueue: invoke('files:enqueue'), discard: invoke('files:discard'), cancel: invoke('files:cancel'), retry: invoke('files:retry') },
  onEvent: (listener) => { ipcRenderer.on('workspace:event', (_event, payload) => listener(payload)); }
});
