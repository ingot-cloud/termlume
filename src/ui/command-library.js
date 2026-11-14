(function (root, factory) {
  const library = factory();
  if (typeof module === 'object' && module.exports) module.exports = library;
  else root.commandLibrary = library;
})(typeof window === 'object' ? window : globalThis, () => {
  const parameters = command => [...new Set([...command.matchAll(/\{\{(path|service|lines)\}\}/g)].map(match => match[1]))];
  const sorted = snippets => snippets.map((snippet, index) => ({ snippet, index }))
    .sort((a, b) => (a.snippet.order || 0) - (b.snippet.order || 0) || a.index - b.index).map(entry => entry.snippet);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  function render(command, values = {}) {
    return command.replace(/\{\{(path|service|lines)\}\}/g, (_, key) => {
      const value = String(values[key] ?? '');
      if (key === 'lines') {
        const lines = Number(value);
        if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error('行数须在 1 至 10000 之间。');
        return String(lines);
      }
      if (key === 'path') {
        if (!value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('请输入有效的日志文件绝对路径。');
      } else if (!/^[\w][\w.@-]{0,255}$/.test(value)) throw new Error('请输入明确的 systemd 服务名。');
      return quote(value);
    });
  }
  return { parameters, sorted, render };
});
