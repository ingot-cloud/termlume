const { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const bundleFileEditor = require('./bundle-file-editor.cjs');

const root = join(__dirname, '..');
const output = join(root, 'dist', 'tauri-ui');
const assets = {
  'style.css': 'src/ui/style.css',
  'workspace-state.js':'src/ui/workspace-state.js',
  'renderer.js': 'src/ui/renderer.js',
  'dropdown.js': 'src/ui/dropdown.js',
  'overlays.js': 'src/ui/overlays.js',
  'terminal-paths.js': 'src/ui/terminal-paths.js',
  'bridge.js': 'src/ui/tauri-bridge.js',
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js'
};

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const [file, source] of Object.entries(assets)) {
  copyFileSync(join(root, source), join(output, file));
}
writeFileSync(join(output, 'file-editor.js'), bundleFileEditor());
const html = readFileSync(join(root, 'src/ui/index.html'), 'utf8')
  .replace(/^[ \t]*<meta http-equiv="Content-Security-Policy".*\n/m, '')
  .replace('<script defer src="/renderer.js">', '<script defer src="/bridge.js"></script>\n  <script defer src="/file-editor.js"></script>\n  <script defer src="/renderer.js">');
writeFileSync(join(output, 'index.html'), html);
