'use strict';

(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const request = (name, value) => invoke('workspace_request', { name, value: value ?? null });
  const bind = (names) => Object.fromEntries(Object.entries(names).map(([key, name]) =>
    [key, (value) => request(name, value)]));
  const notify = (name) => (value) => { void request(name, value).catch(() => {}); };
  const terminalQueues = new Map();
  const sendTerminal = (name) => (value) => {
    const queue = terminalQueues.get(value.id);
    if (!queue) return;
    queue.pending = queue.pending.then(() => {
      if (terminalQueues.get(value.id) === queue) return request(name, value);
    }).catch(() => {});
  };
  window.termlume = {
    updates: Object.fromEntries(['status','check','download','cancel','install'].map(action =>
      [action, () => invoke('update_request', { action })])),
    chrome: {
      startDragging: () => appWindow.startDragging(),
      async toggleMaximize() {
        if (!(await appWindow.isFullscreen())) await appWindow.toggleMaximize();
      }
    },
    vault: { ...bind({ state: 'vault:state', recoveryCode: 'vault:recovery-code', copyRecovery: 'vault:copy-recovery', enable: 'vault:enable', changePassword: 'vault:change-password', disable: 'vault:disable', setGitSettings: 'vault:set-git-settings', lock: 'vault:lock', unlock: 'vault:unlock', touchIdAvailable: 'vault:touch-id-available', setTouchId: 'vault:set-touch-id', setStartupUnlockRequired: 'vault:set-startup-unlock', setAutoLockMinutes: 'vault:set-auto-lock', export: 'vault:export', restoreFile: 'vault:restore-file', restoreGit: 'vault:restore-git', sync: 'vault:sync', migrateGit: 'vault:migrate-git' }), activity: notify('vault:activity') },
    trust:bind({list:'trust:list',forget:'trust:forget',importPreview:'trust:import-preview',import:'trust:import'}),
    preferences:bind({get:'preferences:get',fonts:'preferences:fonts',save:'preferences:save',saveView:'preferences:view'}),
    logs:bind({list:'logs:list',start:'logs:start',stop:'logs:stop',read:'logs:read',remove:'logs:delete',export:'logs:export'}),
    history:bind({list:'history:list',clear:'history:clear'}),
    layouts:bind({list:'layouts:list',save:'layouts:save',remove:'layouts:delete'}),
    snippets:bind({list:'snippets:list',save:'snippets:save',remove:'snippets:delete',reorder:'snippets:reorder',run:'snippets:run'}),
    groups: bind({list:'groups:list',save:'groups:save',remove:'groups:delete'}),
    identities: bind({ list:'identities:list', save:'identities:save', remove:'identities:delete' }),
    keys: bind({ scan: 'keys:scan', agent: 'keys:agent', addAgent: 'keys:add-agent', directory: 'keys:directory', generate: 'keys:generate', create: 'keys:create', importFile: 'keys:import-file', copy: 'keys:copy' }),
    hosts: bind({ reorder: 'hosts:reorder', list: 'hosts:list', recent: 'hosts:recent', touch: 'hosts:touch', save: 'hosts:save', remove: 'hosts:delete', forget: 'hosts:forget', pickKey: 'hosts:key-picker', hasPassword: 'hosts:has-password', hasKeyPassphrase: 'hosts:has-key-passphrase', revealKeyPassphrase: 'hosts:reveal-key-passphrase', revealPassword: 'hosts:reveal-password', clearPassword: 'hosts:clear-password', removeGroup: 'hosts:remove-group', csvPreview:'hosts:csv-preview', csvExport:'hosts:csv-export', importPreview: 'hosts:import-preview', import: 'hosts:import' }),
    ssh: {
      jumpHosts: true,
      connect(value) {
        terminalQueues.set(value.id, { pending: Promise.resolve() });
        return request('ssh:connect', value);
      },
      trust: (value) => request('ssh:trust', value),
      close(id) {
        terminalQueues.delete(id);
        return request('ssh:close', id);
      },
      input: sendTerminal('ssh:input'),
      resize: sendTerminal('ssh:resize'), ack: notify('ssh:ack'), directory: (id) => request('ssh:directory', id),
      serverInfo: (id) => request('ssh:server-info', id)
    },
    editors:bind({list:'editors:list',open:'editors:open',prepare:'editors:prepare',close:'editors:close'}),
    forwards: bind({ list: 'forwards:list', save: 'forwards:save', remove: 'forwards:delete', start: 'forwards:start', stop: 'forwards:stop' }),
    commands: bind({ preview: 'commands:preview', start: 'commands:start', stop: 'commands:stop', close: 'commands:close' }),
    files: {
      mutations: true, directoryUploads:true,
      ...bind({ readText: 'files:read-text', saveText: 'files:save-text' }),
      ...bind({ mutationPreview:'files:mutation-preview',rename:'files:rename',remove:'files:remove', list: 'files:list', inspect: 'files:inspect', mkdir: 'files:mkdir', createFile: 'files:create-file', history: 'files:history', removeHistory: 'files:remove-history', prepare: 'files:prepare', enqueue: 'files:enqueue', discard: 'files:discard', cancel: 'files:cancel', retry: 'files:retry' }),
      directoryDownloads: /Mac|Linux|Win/.test(navigator.platform)
    },
    onEvent(listener) {
      const events = new Channel();
      events.onmessage = (event) => {
        if (event.type === 'output') event.bytes = Uint8Array.from(atob(event.bytes), (byte) => byte.charCodeAt(0));
        if (event.type === 'session' && event.status === 'closed') terminalQueues.delete(event.id);
        if (event.type === 'file-drag' && event.position) {
          // Wry supplies AppKit points on macOS, even though Tauri labels the payload physical.
          const scale = navigator.platform.startsWith('Mac') ? 1 : devicePixelRatio;
          event.position = { x: event.position.x / scale, y: event.position.y / scale };
        }
        listener(event);
      };
      return invoke('workspace_subscribe', { events });
    }
  };
})();
