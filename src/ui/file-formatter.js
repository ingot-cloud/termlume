// Runs in an isolated local worker. Only the explicitly saved document reaches SFTP.
import { formatWithCursor } from 'prettier/standalone';
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as typescript from 'prettier/plugins/typescript';
import * as html from 'prettier/plugins/html';
import * as postcss from 'prettier/plugins/postcss';
import * as yaml from 'prettier/plugins/yaml';
import * as markdown from 'prettier/plugins/markdown';
import * as graphql from 'prettier/plugins/graphql';

const plugins = [babel, estree, typescript, html, postcss, yaml, markdown, graphql];

self.onmessage = async ({ data: { text, parser, path, cursor } }) => {
  try {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = text.slice(bom.length);
    let formatted, cursorOffset;
    if (parser === 'sql' || parser.startsWith('sql:')) {
      const { format } = await import('sql-formatter');
      formatted = format(source, { language: parser.split(':')[1] || 'sql' }) + (source.endsWith('\n') ? '\n' : '');
    } else if (parser === 'python') {
      const ruff = await import('@wasm-fmt/ruff_fmt/web');
      ruff.initSync((await import('@wasm-fmt/ruff_fmt/wasm')).default);
      formatted = ruff.format(source, path);
    } else if (parser === 'toml') {
      const { parse } = await import('smol-toml');
      parse(source);
      const taplo = await import('@wasm-fmt/taplo_fmt/web');
      taplo.initSync((await import('@wasm-fmt/taplo_fmt/wasm')).default);
      formatted = taplo.format(source);
    } else if (parser === 'shell') {
      const { default: sh } = await import('mvdan-sh');
      const posix = /^#![^\n]*[ /](?:da)?sh(?:\s|$)/.test(source);
      const syntax = sh.syntax;
      const tree = syntax.NewParser(syntax.KeepComments(true), syntax.Variant(posix ? syntax.LangPOSIX : syntax.LangBash)).Parse(source, path);
      formatted = syntax.NewPrinter(syntax.Indent(2)).Print(tree);
    } else {
      if (parser === 'json') JSON.parse(source);
      const activePlugins = parser === 'xml' ? [(await import('@prettier/plugin-xml')).default] : plugins;
      ({ formatted, cursorOffset } = await formatWithCursor(source, { parser: parser === 'json' ? 'json-stringify' : parser, filepath: path, plugins: activePlugins,
        tabWidth: 2, endOfLine: 'lf', cursorOffset: Math.max(0, cursor - bom.length) }));
    }
    self.postMessage({ formatted: bom + formatted, cursor: Math.min(bom.length + formatted.length, cursorOffset == null ? cursor : cursorOffset + bom.length) });
  } catch (error) {
    self.postMessage({ error: String(error?.message || error).split('\n')[0].slice(0, 240) });
  }
};
