import { basicSetup } from 'codemirror';
import { HighlightStyle, LanguageDescription, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView, goToNextChunk } from '@codemirror/merge';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { invertedEffects, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { closeSearchPanel, getSearchQuery, openSearchPanel, search, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { fileSearchPanel } from './file-search-panel.js';
import { properties } from '@codemirror/legacy-modes/mode/properties';
const log = {
  name: 'log',
  token(stream) {
    if (stream.match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/)) return 'number';
    if (stream.match(/^(?:error|fatal|critical|panic|emerg|alert)\b/i)) return 'invalid';
    if (stream.match(/^(?:warn|warning)\b/i)) return 'keyword';
    if (stream.match(/^(?:info|notice|debug|trace)\b/i)) return 'atom';
    stream.match(/^\w+|^[^\w]+/);
    return null;
  }
};

const sshConfig = {
  name: 'ssh-config',
  token(stream) {
    if (stream.sol() && stream.match(/^\s*[A-Za-z][\w-]*/)) return 'property';
    if (stream.eat('#')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^"(?:\\.|[^"\\])*"?/)) return 'string';
    if (stream.match(/^\d+\b/)) return 'number';
    stream.match(/^[^\s#"]+/) || stream.next();
    return null;
  }
};

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--editor-keyword)' },
  { tag: [tags.string, tags.quote, tags.regexp, tags.inserted], color: 'var(--editor-string)' },
  { tag: [tags.number, tags.bool, tags.atom, tags.deleted], color: 'var(--editor-number)' },
  { tag: [tags.propertyName, tags.typeName, tags.tagName, tags.attributeName, tags.heading, tags.definition(tags.variableName),
    tags.standard(tags.variableName), tags.special(tags.variableName), tags.function(tags.variableName)], color: 'var(--editor-name)' },
  { tag: tags.invalid, color: 'var(--danger)', fontWeight: '600' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' }
]);

const plain = '纯文本';
const makefile = {
  name: 'makefile',
  token(stream) {
    if (stream.match(/^#.*$/)) return 'comment';
    if (stream.match(/^\$\([^)]+\)|^\$[\w@<^?*]/)) return 'variableName.special';
    if (stream.match(/^[\w.%-]+(?=\s*(?:[:+?]?=|:))/)) return 'variableName.definition';
    if (stream.match(/^(?:include|ifdef|ifndef|ifeq|ifneq|else|endif|define|endef)\b/)) return 'keyword';
    stream.match(/^[^#$\s]+|^\s+/) || stream.next();
    return null;
  }
};

const configCode = {
  name: 'config-code',
  startState: () => ({ end: '', style: '' }),
  token(stream, state) {
    if (!state.end) {
      if (stream.match(/^(?:#|\/\/).*$/)) return 'comment';
      if (stream.match('/*')) { state.end = '*/'; state.style = 'comment'; }
      else if (stream.match('"""')) { state.end = '"""'; state.style = 'string'; }
      else if (stream.match(/^"(?:\\.|[^"\\])*"?/)) return 'string';
      else if (stream.match(/^(?:true|false|null)\b/)) return 'atom';
      else if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number';
      else if (stream.match(/^(?:resource|provider|variable|locals|output|module|terraform|data|query|mutation|fragment|schema|type|interface|input|enum|scalar|subscription|on)\b/)) return 'keyword';
      else if (stream.match(/^[\w-]+(?=\s*[=:])/)) return 'property';
      else { stream.match(/^[\w-]+|^\s+/) || stream.next(); return null; }
    }
    const style = state.style;
    if (stream.skipTo(state.end[0])) {
      if (stream.match(state.end)) state.end = '';
      else stream.next();
    } else stream.skipToEnd();
    return style;
  }
};

const csv = {
  name: 'csv',
  startState: () => ({ quoted: false }),
  token(stream, state) {
    if (!state.quoted && stream.match(/^[,\t]/)) return 'keyword';
    if (!state.quoted && !stream.eat('"')) {
      stream.match(/^[^,\t]+/);
      return /^-?\d+(\.\d+)?$/.test(stream.current()) ? 'number' : null;
    }
    state.quoted = true;
    while (stream.skipTo('"')) {
      stream.next();
      if (!stream.eat('"')) { state.quoted = false; break; }
    }
    if (state.quoted) stream.skipToEnd();
    return 'string';
  }
};

const custom = { '日志': log, OpenSSH: sshConfig, dotenv: properties, systemd: properties,
  INI: properties, Makefile: makefile, Terraform: configCode, GraphQL: configCode, CSV: csv, TSV: csv,
  'Git Ignore': { token(stream) { const comment = stream.peek() === '#'; stream.skipToEnd(); return comment ? 'comment' : 'string'; } } };
const aliases = { JSONC: 'JSON', JSON5: 'JavaScript', JSONL: 'JSON', MDX: 'Markdown' };
const logFile = /\.log(?:[.-]\d[\d-]*)?$|\/var\/log\/(?:syslog|messages|secure|auth|kern|cron|maillog)(?:\.\d+)?$|(?:^|\/)(?:catalina|nohup)\.out$/i;
export const isLogFile = path => logFile.test(path);
const specialFiles = [
  ['日志', logFile],
  ['OpenSSH', /(?:^|\/)(?:sshd?_config|\.ssh\/config|sshd?_config\.d\/[^/]+\.conf)$/],
  ['Nginx', /(?:^|\/)nginx\.conf$|\/nginx\/(?:.*\.conf|sites-(?:enabled|available)\/[^/]+)$/],
  ['dotenv', /(?:^|\/)\.env(?:\.[^/]*)?$|\.env$/],
  ['systemd', /\.(?:service|timer|socket|target|mount|path|slice|automount|network|netdev|link)$/],
  ['Dockerfile', /(?:^|\/)(?:dockerfile|containerfile)(?:\.[^/]+)?$|\.dockerfile$/],
  ['Makefile', /(?:^|\/)(?:gnu|bsd)?makefile$|\.mk$/],
  ['Shell', /(?:^|\/)\.(?:bashrc|bash_profile|bash_logout|zshrc|zprofile|zshenv|profile)$|\.(?:zsh|bats)$/],
  ['YAML', /(?:^|\/)(?:kustomization|\.clang-format|\.clang-tidy|\.yamllint)$/],
  ['JSONC', /(?:^|\/)(?:[jt]sconfig(?:\.[^/]+)?\.json|\.vscode\/[^/]+\.json)$|\.(?:jsonc|code-workspace)$/],
  ['JSON', /(?:^|\/)(?:\.babelrc|\.prettierrc\.json|composer\.lock)$|\.(?:webmanifest|ipynb)$/],
  ['JSONL', /\.(?:jsonl|ndjson)$/], ['JSON5', /\.json5$/], ['MDX', /\.mdx$/],
  ['XML', /\.(?:plist|xaml|csproj|props|targets|rss|atom|wsdl)$/],
  ['TOML', /(?:^|\/)cargo\.lock$/], ['Terraform', /\.(?:tf|tfvars|hcl)$/],
  ['GraphQL', /\.(?:graphqls?|gql)$/], ['CSV', /\.csv$/], ['TSV', /\.tsv$/],
  ['Git Ignore', /(?:^|\/)\.(?:gitignore|dockerignore|prettierignore|eslintignore)$/],
  ['INI', /(?:^|\/)\.(?:gitconfig|gitmodules|editorconfig|npmrc)$|\.(?:ini|cfg|conf|properties)$/]
];

const formatters = {
  JavaScript: 'babel', JSX: 'babel', TypeScript: 'typescript', TSX: 'typescript',
  JSON: 'json', JSONC: 'jsonc', JSON5: 'json5', 'JSON-LD': 'json', CSS: 'css',
  SCSS: 'scss', LESS: 'less', HTML: 'html', Vue: 'vue', YAML: 'yaml', XML: 'xml',
  Markdown: 'markdown', MDX: 'mdx', GraphQL: 'graphql', SQL: 'sql', Shell: 'shell', Python: 'python', TOML: 'toml',
  PostgreSQL: 'sql:postgresql', MySQL: 'sql:mysql', 'MariaDB SQL': 'sql:mariadb', 'MS SQL': 'sql:transactsql', SQLite: 'sql:sqlite', PLSQL: 'sql:plsql'
};
function detectFormat(path, text) {
  const name = path.split('/').at(-1);
  const special = specialFiles.find(([, pattern]) => pattern.test(path.toLowerCase()));
  if (special) return special[0];
  const known = LanguageDescription.matchFilename(languages, name) || LanguageDescription.matchFilename(languages, name.toLowerCase());
  if (known) return known.name;
  const first = text.slice(0, 512).trimStart().split(/[\r\n]/, 1)[0];
  if (/^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?(?:\S*\/)?)?(?:ba|da|k|z|a)?sh(?:\s|$)/.test(first)) return 'Shell';
  if (/^#!.*\bpython[\d.]*\b/.test(first)) return 'Python';
  if (/^#!.*\b(?:node|deno)\b/.test(first)) return 'JavaScript';
  if (/^#!.*\bruby\b/.test(first)) return 'Ruby';
  if (/^<\?xml\b/i.test(first)) return 'XML';
  if (/^<!doctype html\b/i.test(first)) return 'HTML';
  if (first.startsWith('{') || first.startsWith('[')) {
    try { JSON.parse(text.trimStart()); return 'JSON'; } catch { /* Unknown text. */ }
  }
  return plain;
}

export const formatNames = [...new Set([plain, ...Object.keys(custom), ...Object.keys(aliases), ...languages.map(item => item.name)])]
  .sort((left, right) => left.localeCompare(right));

const phrases = { Find: '查找', Replace: '替换为', next: '下一处', previous: '上一处', all: '全选匹配',
  'match case': '区分大小写', regexp: '正则', 'by word': '全词', replace: '替换', 'replace all': '全部替换',
  close: '关闭查找', 'Go to line': '跳转到行', go: '跳转', 'Fold line': '折叠行', 'Unfold line': '展开行' };

// CodeMirror represents every logical break with one character. In mixed files
// keep a parallel marker per break, so offsets and selections remain native.
const endings = { L: '\n', W: '\r\n', R: '\r' };
const restoreBreaks = StateEffect.define();
const mixedBreaks = StateField.define({
  create: () => '',
  update(markers, tr) {
    for (let i = tr.effects.length - 1; i >= 0; i--) {
      if (tr.effects[i].is(restoreBreaks)) return tr.effects[i].value;
    }
    if (!tr.docChanged) return markers;
    let offset = 0;
    const parts = [];
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const first = tr.startState.doc.lineAt(from).number - 1;
      const last = tr.startState.doc.lineAt(to).number - 1;
      const count = inserted.lines - 1;
      if (last - first === count) return;
      // Reused breaks keep their spelling. New breaks inherit the nearest line.
      const reused = Math.min(last - first, count);
      const adjacent = markers[first + reused] || markers[first + reused - 1] || 'L';
      parts.push(markers.slice(offset, first + reused), adjacent.repeat(count - reused));
      offset = last;
    });
    return parts.length ? parts.join('') + markers.slice(offset) : markers;
  }
});
const trackBreakHistory = invertedEffects.of(tr =>
  tr.docChanged ? [restoreBreaks.of(tr.startState.field(mixedBreaks))] : []);

// Formatters return a complete string. Keep unchanged lines as anchors so an
// insertion near the top cannot shift the original endings of later lines.
function mixedFormatChanges(doc, formatted) {
  const lines = formatted.split('\n');
  const positions = new Map();
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!positions.has(lines[i])) positions.set(lines[i], []);
    positions.get(lines[i]).push(i);
  }
  const changes = [];
  let from = 0, nextLine = 0;
  function replace(to, insert) {
    if (from !== to || insert) changes.push({ from, to, insert: Text.of(insert.split('\n')) });
  }
  for (let i = 1; i < doc.lines; i++) {
    const line = doc.line(i);
    const matches = positions.get(line.text);
    if (!matches) continue;
    while (matches.length && matches.at(-1) < nextLine) matches.pop();
    if (!matches.length) continue;
    const match = matches.pop();
    replace(line.from, match > nextLine ? lines.slice(nextLine, match).join('\n') + '\n' : '');
    from = line.to + 1;
    nextLine = match + 1;
  }
  replace(doc.length, lines.slice(nextLine).join('\n'));
  return changes;
}

export function open(parent, path, text, onChange, dark, onPosition = () => {}, onSearch = () => {}) {
  let format = detectFormat(path, text);
  const otherShell = /^(?:\.z(?:shrc|profile|shenv)|.*\.(?:zsh|ksh))$/i.test(path.split('/').at(-1)) || /^#![^\n]*\b(?:zsh|ksh)\b/.test(text);
  const language = new Compartment();
  const wrapping = new Compartment();
  const lineBreaks = text.match(/\r\n|\r|\n/g);
  const separator = lineBreaks?.[0];
  const mixed = lineBreaks?.some(ending => ending !== separator);
  const breakExtensions = mixed
    ? [mixedBreaks, trackBreakHistory]
    : separator ? [EditorState.lineSeparator.of(separator)] : [];
  const access = new Compartment();
  const permission = writable => [EditorState.readOnly.of(!writable), EditorView.editable.of(writable),
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-readonly': String(!writable) })];
  const extensions = [
      access.of(permission(false)),
      EditorState.transactionFilter.of(tr => tr.docChanged && tr.startState.readOnly ? [] : tr),
      search({ top: true, createPanel: fileSearchPanel }), basicSetup, wrapping.of([]), EditorState.phrases.of(phrases),
      language.of([]),
      breakExtensions,
      EditorView.theme({}, { dark }), syntaxHighlighting(highlighting),
      EditorView.contentAttributes.of({ 'aria-label': '远端文件内容', spellcheck: 'false' }),
      EditorView.updateListener.of(update => {
        if (searchPanelOpen(update.startState) !== searchPanelOpen(update.state)) onSearch(searchPanelOpen(update.state));
        if (update.docChanged) onChange();
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          const line = update.state.doc.lineAt(selection.head);
          onPosition(line.number, selection.head - line.from + 1, selection.to - selection.from);
        }
      })
  ];
  const initialMarkers = mixed ? lineBreaks.map(e => e === '\r\n' ? 'W' : e === '\r' ? 'R' : 'L').join('') : undefined;
  const documentExtensions = markers => mixed ? [extensions, mixedBreaks.init(() => markers)] : extensions;
  const editor = new EditorView({ parent, doc: text, extensions: documentExtensions(initialMarkers) });
  function setFormat(name) {
    format = name;
    const builtin = custom[name];
    const description = LanguageDescription.matchLanguageName(languages, aliases[name] || name, false);
    editor.dispatch({ effects: language.reconfigure(builtin ? StreamLanguage.define(builtin) : description?.support || []) });
    if (!builtin && description && !description.support) {
      description.load().then(support => {
        if (editor.dom.parentNode && format === name) editor.dispatch({ effects: language.reconfigure(support) });
      });
    }
  }
  setFormat(format);
  return {
    editor, setFormat, get format() { return format; },
    get parser() {
      return format === 'Shell' && otherShell ? undefined : formatters[format];
    },
    compare(parent, remoteText, keepCursor = false) {
      const syntax = [language.get(editor.state), syntaxHighlighting(highlighting), EditorView.lineWrapping,
        EditorView.theme({}, { dark }), EditorState.phrases.of(phrases)];
      const comparison = new MergeView({
        parent, gutter: true, diffConfig: { scanLimit: 500, timeout: 120 },
        a: { doc: remoteText, extensions: [syntax, EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '远端最新内容', tabindex: '0' })] },
        b: { doc: editor.state.doc, extensions: [syntax, basicSetup,
          EditorView.contentAttributes.of({ 'aria-label': '我的草稿', spellcheck: 'false' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) editor.dispatch({ changes: update.changes,
              selection: update.state.selection, annotations: Transaction.userEvent.of('input.merge') });
          })] }
      });
      if (keepCursor) comparison.b.dispatch({ selection: editor.state.selection, scrollIntoView: true });
      else if (comparison.chunks.length) goToNextChunk(comparison.b);
      comparison.b.focus();
      return comparison;
    },
    snapshot() { return { doc: editor.state.doc, markers: editor.state.field(mixedBreaks, false) }; },
    matches(saved) { return editor.state.doc.eq(saved.doc) && editor.state.field(mixedBreaks, false) === saved.markers; },
    serialize() {
      if (!mixed) return editor.state.sliceDoc();
      const markers = editor.state.field(mixedBreaks);
      let index = 0;
      return editor.state.doc.toString().replace(/\n/g, () => endings[markers[index++]]);
    },
    get lineEnding() {
      const markers = editor.state.field(mixedBreaks, false);
      if (markers && /[^L]/.test(markers) && /[^W]/.test(markers) && /[^R]/.test(markers)) return '混合换行';
      const ending = mixed ? endings[markers[0]] : separator;
      return ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF';
    },
    writable(enabled) { editor.dispatch({ effects: access.reconfigure(permission(enabled)) }); },
    get canUndo() { return undoDepth(editor.state) > 0; },
    get canRedo() { return redoDepth(editor.state) > 0; },
    undo() { if (undo(editor)) editor.focus(); },
    redo() { if (redo(editor)) editor.focus(); },
    preview({doc, markers}) {
      // Start each editing session with fresh undo history, including after discarding a draft.
      const previous = editor.state;
      const wrap = wrapping.get(previous);
      const snapshot = editor.scrollSnapshot();
      const selection = previous.selection.main;
      const next = EditorState.create({ doc, extensions: documentExtensions(markers), selection: {
        anchor: Math.min(selection.anchor, doc.length), head: Math.min(selection.head, doc.length) } });
      const activeLanguage = language.get(previous);
      editor.setState(next);
      editor.dispatch({ effects: [snapshot, language.reconfigure(activeLanguage), wrapping.reconfigure(wrap),
        setSearchQuery.of(getSearchQuery(previous))] });
      onSearch(false);
      const at = editor.state.selection.main;
      const line = doc.lineAt(at.head);
      onPosition(line.number, at.head - line.from + 1, at.to - at.from);
    },
    search(open) { return (open ? openSearchPanel : closeSearchPanel)(editor); },
    jump(value) {
      const match = /^([+-])?(\d+)?(%)?(?::(\d+))?$/.exec(value.trim());
      if (!match || (!match[2] && !match[4])) return false;
      const doc = editor.state.doc;
      const current = doc.lineAt(editor.state.selection.main.head).number;
      let target = match[2] ? Number(match[2]) : current;
      if (match[3]) target = Math.round(doc.lines * target / 100);
      if (match[1]) target = current + (match[1] === '-' ? -target : target);
      const line = doc.line(Math.max(1, Math.min(target, doc.lines)));
      const anchor = line.from + Math.min(line.length, Math.max(0, Number(match[4] || 1) - 1));
      editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
      return true;
    },
    wrap(enabled) { editor.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }); editor.focus(); },
    applyFormat(formatted, cursor) {
      const changes = mixed ? mixedFormatChanges(editor.state.doc, formatted)
        : { from: 0, to: editor.state.doc.length, insert: Text.of(formatted.split('\n')) };
      editor.dispatch({ changes,
        selection: { anchor: Math.min(cursor, formatted.length) }, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.format')] });
    }
  };
}

let loadingFormatter;
export async function formatDocument(request, signal) {
  if (!window.termlumeFormatterURL) {
    loadingFormatter ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('file-formatter.js', document.baseURI).href;
      script.onload = resolve;
      script.onerror = () => { loadingFormatter = undefined; script.remove(); reject(new Error('无法载入本机格式化工具')); };
      document.head.append(script);
    });
    await loadingFormatter;
  }
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  const worker = new Worker(window.termlumeFormatterURL);
  return new Promise((resolve, reject) => {
    const abort = () => { worker.terminate(); reject(new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    const finish = () => { signal.removeEventListener('abort', abort); worker.terminate(); };
    worker.onmessage = ({ data }) => { finish(); if (data.error) reject(new Error(data.error)); else resolve(data); };
    worker.onerror = event => { finish(); reject(new Error(event.message || '本机格式化工具启动失败')); };
    worker.postMessage(request);
  });
}
