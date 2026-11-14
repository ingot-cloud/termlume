(function(root, create) {
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.keyboardShortcuts = create(root.navigator.platform);
})(typeof window !== 'undefined' ? window : globalThis, (platform = '') => {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  const modifier = isMac ? '⌘' : 'Ctrl';
  const primary = event => Boolean(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey;
  const label = (key, shift = false) => isMac ? `${modifier}${shift ? '⇧' : ''}${key}` : `${modifier}+${shift ? 'Shift+' : ''}${key}`;
  const aria = (key, shift = false) => `${isMac ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`;
  function action(event) {
    if (event.defaultPrevented || event.isComposing || !primary(event)) return;
    const key = event.key.toLowerCase();
    if (!isMac && key === 'tab') return event.shiftKey ? 'previous-tab' : 'next-tab';
    if (event.shiftKey && ['BracketLeft', 'BracketRight'].includes(event.code)) {
      return event.code === 'BracketLeft' ? 'previous-tab' : 'next-tab';
    }
    if (['+', '='].includes(key)) return 'zoom-in';
    if (event.shiftKey) return;
    if (/^[1-9]$/.test(key)) return `tab-${key}`;
    return { b: 'navigation', e: 'files', t: 'new-tab', w: 'close-tab', k: 'search',
      j: 'sessions', f: 'find', '-': 'zoom-out', '0': 'zoom-reset' }[key];
  }
  function terminalKey(event, hasSelection) {
    if (isMac) return !event.metaKey;
    if (event.isComposing) return true;
    // Let the webview produce native copy/paste events. Unselected Ctrl+C and
    // other shell controls still reach xterm; app shortcuts must never reach SSH.
    if (primary(event) && (event.key.toLowerCase() === 'v' ||
        (event.key.toLowerCase() === 'c' && hasSelection && !event.shiftKey))) return false;
    return !action(event);
  }
  function hints(document) {
    for (const element of document.querySelectorAll('[data-shortcut]')) {
      const key = element.dataset.shortcut;
      if (element.tagName === 'KBD') element.textContent = label(key);
      else {
        element.title = `${element.getAttribute('aria-label')} (${label(key)})`;
        element.setAttribute('aria-keyshortcuts', aria(key));
      }
    }
  }
  return { isMac, modifier, primary, label, aria, action, terminalKey, hints };
});
