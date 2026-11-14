'use strict';

(() => {
  const absolute = (path) => typeof path === 'string' && path.startsWith('/') &&
    new TextEncoder().encode(path).length <= 4096 && !/[\p{Cc}]/u.test(path);

  function resolve(value, directory) {
    if (absolute(value)) return value;
    if (!value || value.startsWith('~') || !directory) return undefined;
    const path = `${directory.replace(/\/$/, '')}/${value}`;
    return absolute(path) ? path : undefined;
  }

  function directoryFromUri(value) {
    try {
      const uri = new URL(value);
      if (uri.protocol === 'file:' && !uri.search && !uri.hash) return decodeURIComponent(uri.pathname);
    } catch { /* Ignore malformed reports. */ }
  }

  // A wrapped line can span several physical rows. Map string offsets back to
  // xterm cells so paths following wide CJK characters are still clickable.
  function linksForRow(buffer, row, directory) {
    let first = row;
    let last = row;
    while (buffer.getLine(first)?.isWrapped && row - first < 15) first--;
    while (buffer.getLine(last + 1)?.isWrapped && last - first < 15) last++;
    if (buffer.getLine(first)?.isWrapped || buffer.getLine(last + 1)?.isWrapped) return [];
    let text = '';
    const points = [];
    const cell = buffer.getNullCell();
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) return [];
      for (let x = 0; x < line.length; x++) {
        const data = line.getCell(x, cell);
        if (!data?.getWidth()) continue;
        const chars = data.getChars();
        if (!chars && x === line.length - 1 && y < last && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2) continue;
        const point = { x: x + 1, y: y + 1, width: data.getWidth() };
        for (let i = 0; i < (chars.length || 1); i++) points.push(point);
        text += chars || ' ';
      }
    }

    const links = [];
    const lineText = text.trim();
    const addLink = (value, index) => {
      const start = points[index];
      const end = points[index + value.length - 1];
      if (row + 1 < start.y || row + 1 > end.y) return;
      const path = resolve(value, directory(first));
      links.push({ path, text: value, range: { start, end: { x: end.x + end.width - 1, y: end.y } } });
    };
    // Long listings separate the filename from the timestamp with a single space.
    const listing = /^\s*([bcdlps-])[rwxstST-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+(?:\S+\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+/u.exec(text);
    if (listing) {
      const tail = text.slice(listing[0].length).trimEnd();
      const name = listing[1] === 'l' ? tail.split(' -> ', 1)[0] : tail;
      if (/^[\p{L}\p{N}_. /-]+$/u.test(name)) {
        addLink(name, listing[0].length);
        return links;
      }
    }
    for (const match of text.matchAll(/"([^"]+)"|'([^']+)'|[^\s"'`()[\]{}<>=]+/gu)) {
      const quoted = match[1] !== undefined || match[2] !== undefined;
      const value = match[1] ?? match[2] ?? match[0];
      if (value.startsWith('//') || (!quoted && /[:\\]/.test(value))) continue;
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + match[0].length);
      const column = /\s{2,}$/.test(before) || /^\s{2,}\S/.test(after);
      const simpleName = (lineText === match[0] || column) && /^[\p{L}\p{N}_. -]+$/u.test(value);
      if (!value.includes('/') && !simpleName && !/^[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_-]{1,16}$/u.test(value)) continue;
      addLink(value, match.index + Number(quoted));
    }
    return links;
  }

  function observe(terminal, activate, onDirectory, isReady) {
    const directories = [];
    let reported;
    let freshDirectory = false;
    let prompt;
    let hasInput = false;
    const ordinaryBuffer = () => terminal.buffer.active.type === 'normal' && terminal.modes.mouseTrackingMode === 'none';

    function report(value) {
      if (!isReady() || !ordinaryBuffer()) return;
      const path = absolute(value) ? value : undefined;
      const { baseY, cursorY } = terminal.buffer.active;
      const previous = directories.at(-1);
      if (previous?.marker.line !== baseY + cursorY || previous.path !== path) {
        const marker = terminal.registerMarker();
        const entry = { path, marker };
        directories.push(entry);
        marker.onDispose(() => {
          const index = directories.indexOf(entry);
          if (index >= 0) directories.splice(index, 1);
        });
        if (directories.length > 256) directories[0].marker.dispose();
      }
      freshDirectory = Boolean(path);
      if (reported !== path) {
        reported = path;
        onDirectory();
      }
    }

    terminal.parser.registerOscHandler(7, (data) => {
      report(directoryFromUri(data));
      return true;
    });
    terminal.parser.registerOscHandler(1337, (data) => {
      if (!data.startsWith('CurrentDir=')) return false;
      report(data.slice('CurrentDir='.length));
      return true;
    });
    terminal.parser.registerOscHandler(133, (data) => {
      const code = data.split(';', 1)[0];
      if (code === 'B' && freshDirectory && !hasInput && isReady() && ordinaryBuffer()) {
        const { baseY, cursorX, cursorY } = terminal.buffer.active;
        prompt = { line: baseY + cursorY, column: cursorX };
      } else if (['A', 'C', 'D'].includes(code)) prompt = undefined;
      return false;
    });
    terminal.buffer.onBufferChange(() => {
      prompt = undefined;
      freshDirectory = false;
    });

    function provideLinks(line, callback) {
      if (!ordinaryBuffer()) { callback(undefined); return; }
      const links = linksForRow(terminal.buffer.active, line - 1, (row) => {
        const index = directories.findLastIndex(({ marker }) => marker.line <= row);
        if (index < 0) return undefined;
        const { path, marker } = directories[index];
        const next = directories[index + 1];
        // A command can both change directory and print names. Only resolve
        // relative output when the reports surrounding that output agree.
        if (next ? next.path === path : freshDirectory && row === marker.line) return path;
      });
      callback(links.map(({ path, text, range }) => ({
        text, range,
        activate: (event) => {
          if (window.keyboardShortcuts.primary(event) && event.button === 0) {
            const last = directories.at(-1);
            activate(path, text, !last || range.start.y - 1 >= last.marker.line);
          }
        }
      })));
    }
    terminal.registerLinkProvider({ provideLinks });

    return {
      get directory() { return reported; },
      get uploadDirectory() { return freshDirectory && ordinaryBuffer() ? reported : undefined; },
      get emptyPrompt() {
        const { baseY, cursorY, cursorX } = terminal.buffer.active;
        return ordinaryBuffer() && prompt?.line === baseY + cursorY && prompt.column === cursorX ? prompt : undefined;
      },
      get visiblePrompt() {
        if (hasInput || !ordinaryBuffer()) return undefined;
        const buffer = terminal.buffer.active;
        const { baseY, cursorY, cursorX } = buffer;
        const line = buffer.getLine(baseY + cursorY);
        const prefix = line?.translateToString(false, 0, cursorX);
        if (!prefix || !/[#$%❯➜]\s*$/u.test(prefix) || line.translateToString(true, cursorX)) return undefined;
        return `${baseY + cursorY}:${cursorX}:${prefix}`;
      },
      invalidate(data = '') {
        prompt = undefined;
        if (data) hasInput = !/[\r\n\x03]$/.test(data);
        if (/[\p{Cc}]/u.test(data)) freshDirectory = false;
      },
      reset() {
        for (const { marker } of directories.slice()) marker.dispose();
        prompt = reported = undefined;
        freshDirectory = hasInput = false;
      }
    };
  }

  window.terminalPaths = { absolute, resolve, observe };
})();
