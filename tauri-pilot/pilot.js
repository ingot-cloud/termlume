'use strict';

const { invoke, Channel } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const terminal = new Terminal({
  fontFamily: 'SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  scrollback: 6000,
  cursorBlink: true,
  disableStdin: true,
  theme: { background: '#11161f', foreground: '#e3ebf5', cursor: '#a6ceff', selectionBackground: '#365579' }
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open($('terminal'));

let generation = 0;
let ready = false;
let inputQueue = Promise.resolve();
function setConnectionState(state, message) {
  ready = state === 'ready';
  terminal.options.disableStdin = !ready;
  $('connection-status').textContent = message;
  $('connect').disabled = state !== 'idle';
  $('disconnect').disabled = !ready;
  for (const button of document.querySelectorAll('#terminal-keys button')) button.disabled = !ready;
}
setConnectionState('idle', '未连接');

function sendInput(data) {
  if (!ready) return;
  const current = generation;
  inputQueue = inputQueue.then(async () => {
    if (ready && current === generation) await invoke('ssh_input', { data });
  }).catch((error) => {
    if (current === generation) $('connection-status').textContent = String(error);
  });
}
terminal.onData(sendInput);
terminal.onResize((size) => {
  if (ready) invoke('ssh_resize', { size }).catch(() => {});
});

let fitFrame;
function refit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => fit.fit());
}
new ResizeObserver(refit).observe($('terminal'));
window.visualViewport?.addEventListener('resize', refit);

$('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = ++generation;
  const connection = {
    host: $('host').value,
    port: Number($('port').value),
    user: $('user').value,
    password: $('password').value,
    fingerprint: $('fingerprint').value,
    size: { cols: terminal.cols, rows: terminal.rows }
  };
  $('password').value = '';
  terminal.reset();
  setConnectionState('connecting', '正在连接…');

  let ended = false;
  const events = new Channel();
  events.onmessage = (message) => {
    if (current !== generation) return;
    if (message.type === 'output') {
      terminal.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
    } else if (message.type === 'closed') {
      ended = true;
      setConnectionState('idle', '连接已断开');
    }
  };
  try {
    await invoke('ssh_connect', { connection, events });
    if (ended || current !== generation) return;
    setConnectionState('ready', '已连接');
    $('connection').open = false;
    refit();
    terminal.focus();
  } catch (error) {
    if (current === generation) setConnectionState('idle', String(error));
  }
});

$('disconnect').addEventListener('click', async () => {
  ++generation;
  setConnectionState('connecting', '正在断开…');
  try {
    await invoke('ssh_close');
    setConnectionState('idle', '已断开');
    $('connection').open = true;
  } catch (error) {
    setConnectionState('ready', String(error));
  }
});

const keys = { escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
$('terminal-keys').addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});
$('terminal-keys').addEventListener('click', (event) => {
  const key = event.target.closest('button')?.dataset.key;
  if (key) sendInput(keys[key]);
});

invoke('desktop_tools').then((available) => { $('desktop-tools').hidden = !available; });
$('transfer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
  const upload = event.submitter?.value === 'upload';
  const result = $('transfer-result');
  buttons.forEach((button) => { button.disabled = true; });
  result.textContent = '等待选择文件…';
  try {
    const bytes = await invoke('sftp_copy', { remote: $('remote').value.trim(), upload });
    result.textContent = bytes === null ? '已取消' : `${upload ? '上传' : '下载'}完成，共 ${bytes.toLocaleString()} 字节`;
  } catch (error) {
    result.textContent = String(error);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});

$('vault-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('verify-vault');
  const result = $('vault-result');
  const secret = $('vault-secret').value;
  $('vault-secret').value = '';
  button.disabled = true;
  result.textContent = '等待选择备份…';
  try {
    const count = await invoke('vault_inspect', { secret, useRecovery: $('recovery').checked });
    result.textContent = count === null ? '已取消' : `备份可解锁，含 ${count} 台主机`;
  } catch (error) {
    result.textContent = String(error);
  } finally {
    button.disabled = false;
  }
});
