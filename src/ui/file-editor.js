import { basicSetup } from 'codemirror';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { html, xml } from '@codemirror/legacy-modes/mode/xml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { go } from '@codemirror/legacy-modes/mode/go';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { diff } from '@codemirror/legacy-modes/mode/diff';

const formats = [
  ['Shell', shell, /(?:\.(?:sh|bash|zsh|bashrc|bash_profile|zshrc|profile))$/],
  ['JavaScript', javascript, /\.(?:js|mjs|cjs|jsx)$/],
  ['TypeScript', typescript, /\.(?:ts|mts|cts|tsx)$/],
  ['JSON', json, /\.(?:json|jsonc|jsonl|ndjson)$/],
  ['Python', python, /\.(?:py|pyw)$/],
  ['YAML', yaml, /\.(?:ya?ml)$/],
  ['TOML', toml, /\.toml$/],
  ['Nginx', nginx, /(?:^nginx\.conf$|\/nginx\/.*\.conf$)/],
  ['配置', properties, /(?:^\.env(?:\.|$)|\.(?:ini|cfg|conf|properties|service|timer|socket)$)/],
  ['HTML', html, /\.html?$/],
  ['XML', xml, /\.(?:xml|svg|plist)$/],
  ['CSS', css, /\.css$/],
  ['SQL', standardSQL, /\.sql$/],
  ['Dockerfile', dockerFile, /^(?:dockerfile|containerfile)(?:\.|$)/],
  ['C', c, /\.[ch]$/],
  ['C++', cpp, /\.(?:cc|cpp|cxx|hpp)$/],
  ['Java', java, /\.java$/],
  ['Rust', rust, /\.rs$/],
  ['Go', go, /\.go$/],
  ['Ruby', ruby, /(?:^gemfile$|^rakefile$|\.rb$)/],
  ['Diff', diff, /\.(?:diff|patch)$/]
];

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--editor-keyword)' },
  { tag: [tags.string, tags.regexp, tags.inserted], color: 'var(--editor-string)' },
  { tag: [tags.number, tags.bool, tags.atom, tags.deleted], color: 'var(--editor-number)' },
  { tag: [tags.propertyName, tags.typeName, tags.tagName, tags.function(tags.variableName)], color: 'var(--editor-name)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' }
]);

export function moveAndResize(dialog, heading, grip) {
  const events = new AbortController();
  const options = { signal: events.signal };
  const styles = getComputedStyle(dialog);
  const gap = parseFloat(styles.getPropertyValue('--file-editor-gap'));
  const topEdge = parseFloat(styles.getPropertyValue('--titlebar-height')) + gap;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  let placement, gesture;

  function place({ left, top, width, height }) {
    const maxWidth = innerWidth - 2 * gap;
    const maxHeight = innerHeight - topEdge - gap;
    width = clamp(width, Math.min(360, maxWidth), maxWidth);
    height = clamp(height, Math.min(240, maxHeight), maxHeight);
    left = clamp(left, gap, innerWidth - gap - width);
    top = clamp(top, topEdge, innerHeight - gap - height);
    placement = { left, top, width, height };
    for (const [key, value] of Object.entries(placement)) {
      dialog.style.setProperty(`--file-editor-${key}`, `${value}px`);
    }
    dialog.classList.add('file-editor-positioned');
  }

  for (const handle of [heading, grip]) {
    handle.addEventListener('pointerdown', event => {
      if (gesture || !event.isPrimary || event.button !== 0 ||
          event.target.closest('button') || dialog.classList.contains('file-editor-expanded')) return;
      event.preventDefault();
      gesture = { id: event.pointerId, resize: handle === grip, x: event.clientX, y: event.clientY,
        bounds: dialog.getBoundingClientRect() };
      handle.setPointerCapture(event.pointerId);
    }, options);
  }

  window.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    if (!(event.buttons & 1) || dialog.classList.contains('file-editor-expanded')) {
      gesture = undefined;
      return;
    }
    const { left, top, width, height } = gesture.bounds;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.resize) {
      place({ left, top, width: Math.min(width + dx, innerWidth - gap - left),
        height: Math.min(height + dy, innerHeight - gap - top) });
    } else place({ left: left + dx, top: top + dy, width, height });
  }, options);
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, event => {
    if (gesture?.id === event.pointerId) gesture = undefined;
  }, options);
  window.addEventListener('blur', () => { gesture = undefined; }, options);
  window.addEventListener('resize', () => { if (placement) place(placement); }, options);
  return () => {
    events.abort();
    dialog.classList.remove('file-editor-positioned');
    for (const key of ['left', 'top', 'width', 'height']) dialog.style.removeProperty(`--file-editor-${key}`);
  };
}

export function open(parent, path, text, onChange, onSave, dark) {
  const fullPath = path.toLowerCase();
  const name = fullPath.split('/').at(-1);
  const [format, parser] = formats.find(([, , pattern]) => pattern.test(name) || pattern.test(fullPath)) || ['纯文本'];
  const lineBreaks = text.match(/\r\n|\r|\n/g);
  const separator = lineBreaks?.[0];
  const editor = new EditorView({
    parent,
    doc: text,
    extensions: [
      basicSetup,
      ...(parser ? [StreamLanguage.define(parser)] : []),
      ...(separator && lineBreaks.every(ending => ending === separator) ? [EditorState.lineSeparator.of(separator)] : []),
      EditorView.theme({}, { dark }),
      syntaxHighlighting(highlighting),
      EditorView.contentAttributes.of({ 'aria-label': '远端文件内容', spellcheck: 'false' }),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(); }),
      EditorView.domEventHandlers({
        keydown(event) {
          if (!event.isComposing && !event.shiftKey && window.keyboardShortcuts.primary(event) && event.key.toLowerCase() === 's') {
            onSave();
            return true;
          }
          return false;
        }
      })
    ]
  });
  return { editor, format };
}
