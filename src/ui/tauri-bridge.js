'use strict';

(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const request = (name, value) => invoke('workspace_request', { name, value: value ?? null });
  const bind = (names) => Object.fromEntries(Object.entries(names).map(([key, name]) =>
    [key, (value) => request(name, value)]));
  const notify = (name) => (value) => { void request(name, value).catch(() => {}); };
  const inputs = new Map();
  window.termlume = {
    chrome: {
      startDragging: () => appWindow.startDragging(),
      async toggleMaximize() {
        if (!(await appWindow.isFullscreen())) await appWindow.toggleMaximize();
      }
    },
    vault: { ...bind({ state: 'vault:state', recoveryCode: 'vault:recovery-code', copyRecovery: 'vault:copy-recovery', enable: 'vault:enable', lock: 'vault:lock', unlock: 'vault:unlock', touchIdAvailable: 'vault:touch-id-available', setTouchId: 'vault:set-touch-id', setStartupUnlockRequired: 'vault:set-startup-unlock', setAutoLockMinutes: 'vault:set-auto-lock', export: 'vault:export', restoreFile: 'vault:restore-file', restoreGit: 'vault:restore-git', sync: 'vault:sync', migrateGit: 'vault:migrate-git' }), activity: notify('vault:activity') },
    keys: bind({ scan: 'keys:scan', agent: 'keys:agent', directory: 'keys:directory', generate: 'keys:generate', copy: 'keys:copy' }),
    hosts: bind({ list: 'hosts:list', recent: 'hosts:recent', touch: 'hosts:touch', save: 'hosts:save', remove: 'hosts:delete', forget: 'hosts:forget', pickKey: 'hosts:key-picker', hasPassword: 'hosts:has-password', revealPassword: 'hosts:reveal-password', clearPassword: 'hosts:clear-password', removeGroup: 'hosts:remove-group', importPreview: 'hosts:import-preview', import: 'hosts:import' }),
    ssh: {
      jumpHosts: true,
      connect(value) {
        inputs.set(value.id, { pending: Promise.resolve() });
        return request('ssh:connect', value);
      },
      trust: (value) => request('ssh:trust', value),
      close(id) {
        inputs.delete(id);
        return request('ssh:close', id);
      },
      input(value) {
        const queue = inputs.get(value.id);
        if (!queue) return;
        queue.pending = queue.pending.then(() => {
          if (inputs.get(value.id) === queue) return request('ssh:input', value);
        }).catch(() => {});
      },
      resize: notify('ssh:resize'), ack: notify('ssh:ack'), directory: (id) => request('ssh:directory', id)
    },
    commands: bind({ preview: 'commands:preview', start: 'commands:start', stop: 'commands:stop', close: 'commands:close' }),
    files: {
      ...bind({ list: 'files:list', inspect: 'files:inspect', mkdir: 'files:mkdir', createFile: 'files:create-file', history: 'files:history', removeHistory: 'files:remove-history', prepare: 'files:prepare', enqueue: 'files:enqueue', discard: 'files:discard', cancel: 'files:cancel', retry: 'files:retry' }),
      directoryDownloads: /Mac|Linux/.test(navigator.platform)
    },
    onEvent(listener) {
      const events = new Channel();
      events.onmessage = (event) => {
        if (event.type === 'output') event.bytes = Uint8Array.from(atob(event.bytes), (byte) => byte.charCodeAt(0));
        if (event.type === 'session' && event.status === 'closed') inputs.delete(event.id);
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
