const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const create = require('../src/ui/shortcuts.js');
const event = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

test('Windows uses Ctrl and macOS uses Command for app shortcuts and hints', () => {
  for (const [platform, modifier, rejected] of [['Win32', 'ctrlKey', 'metaKey'], ['MacIntel', 'metaKey', 'ctrlKey']]) {
    const keyboard = create(platform);
    for (const [key, action] of Object.entries({ t: 'new-tab', w: 'close-tab', k: 'search', j: 'sessions',
      b: 'navigation', e: 'files', f: 'find', '1': 'tab-1', '9': 'tab-9', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset' })) {
      assert.equal(keyboard.action(event(key, { [modifier]: true })), action);
      assert.equal(keyboard.action(event(key, { [rejected]: true })), undefined);
    }
    assert.equal(keyboard.label('S'), platform === 'Win32' ? 'Ctrl+S' : '⌘S');
    assert.equal(keyboard.aria('K'), platform === 'Win32' ? 'Control+K' : 'Meta+K');
    assert.equal(keyboard.action(event('+', { [modifier]: true, shiftKey: true })), 'zoom-in');
    assert.equal(keyboard.action(event('{', { [modifier]: true, shiftKey: true, code: 'BracketLeft' })), 'previous-tab');
  }
  assert.equal(create('Win32').action(event('Tab', { ctrlKey: true })), 'next-tab');
  assert.equal(create('Win32').action(event('Tab', { ctrlKey: true, shiftKey: true })), 'previous-tab');
});

test('IME, AltGr, extra modifiers and unassigned shortcuts do not trigger app actions', () => {
  const keyboard = create('Win32');
  for (const modifiers of [{ isComposing: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) {
    assert.equal(keyboard.action(event('t', { ctrlKey: true, ...modifiers })), undefined);
  }
  assert.equal(keyboard.action(event('s', { ctrlKey: true })), undefined);
});

test('terminal routing keeps shell controls, native copy/paste and app actions separate', () => {
  const keyboard = create('Win32');
  for (const key of ['c', 'd', 'a', 'l', 'r', 'z']) {
    assert.equal(keyboard.terminalKey(event(key, { ctrlKey: true }), false), true, key);
  }
  assert.equal(keyboard.terminalKey(event('c', { ctrlKey: true }), true), false);
  assert.equal(keyboard.terminalKey(event('v', { ctrlKey: true }), false), false);
  assert.equal(keyboard.terminalKey(event('v', { ctrlKey: true, shiftKey: true }), false), false);
  for (const key of ['k', 't', 'w', 'f', 'e', '1', '=', '-']) {
    assert.equal(keyboard.terminalKey(event(key, { ctrlKey: true }), false), false, key);
  }
  assert.equal(keyboard.terminalKey(event('k', { ctrlKey: true, altKey: true }), false), true);
  assert.equal(create('MacIntel').terminalKey(event('c', { ctrlKey: true }), true), true);
});

test('terminal path links require the platform modifier before opening a remote path', () => {
  const source = fs.readFileSync(require.resolve('../src/ui/terminal-paths.js'), 'utf8');
  for (const platform of ['Win32', 'MacIntel']) {
    const window = { keyboardShortcuts: create(platform) };
    vm.runInNewContext(source, { window, TextEncoder });
    const text = '/etc/test.json';
    let provider;
    const opened = [];
    const terminal = {
      buffer: { active: { type: 'normal', getNullCell() {}, getLine: row => row === 0 ? {
        length: text.length, isWrapped: false,
        getCell: index => ({ getWidth: () => 1, getChars: () => text[index] })
      } : undefined }, onBufferChange() {} },
      modes: { mouseTrackingMode: 'none' }, parser: { registerOscHandler() {} },
      registerLinkProvider: value => { provider = value; }
    };
    window.terminalPaths.observe(terminal, path => opened.push(path), () => {}, () => true);
    let link;
    provider.provideLinks(1, links => { [link] = links; });
    link.activate(event('', { button: 0 }));
    assert.equal(opened.length, 0);
    link.activate(event('', { button: 0, [platform === 'Win32' ? 'ctrlKey' : 'metaKey']: true }));
    assert.deepEqual(opened, [text]);
  }
});
