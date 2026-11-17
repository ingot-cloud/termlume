// Creates an offline preview of the real UI with fictional data and browser smoke checks.
const fs = require('node:fs');
const path = require('node:path');
const bundleFileEditor = require('./bundle-file-editor.cjs');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const script = source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`;
const sources = {
  '/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js',
  '/fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js',
  '/dropdown.js':'src/ui/dropdown.js',
  '/overlays.js':'src/ui/overlays.js',
  '/shortcuts.js':'src/ui/shortcuts.js',
  '/terminal-paths.js':'src/ui/terminal-paths.js',
  '/terminal-rendering.js':'src/ui/terminal-rendering.js',
  '/workspace-state.js':'src/ui/workspace-state.js',
  '/host-tree.js':'src/ui/host-tree.js',
  '/command-library.js':'src/ui/command-library.js',
  '/server-info.js':'src/ui/server-info.js',
  '/renderer.js':'src/ui/renderer.js'
};
let html = read('src/ui/index.html').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
html = html.replace(/<script defer src="([^"]+)"><\/script>/g, (_, source) => source === '/renderer.js'
  ? script(read('scripts/fixtures/workspace-preview.js').replace('/* COMMAND_DEFAULTS */ []', read('src/command-defaults.json'))) + script(bundleFileEditor()) + script(read(sources[source]))
  : script(read(sources[source])));
// Scripts run after the complete document so the fixture uses the same DOM as production.
const scripts = html.match(/<script>[\s\S]*?<\/script>/g).join('\n');
html = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace('</body>', () => scripts + script(read('scripts/fixtures/workspace-smoke.js')) + '</body>');
html = html.replace('<link rel="stylesheet" href="/xterm.css">', `<style>${read('node_modules/@xterm/xterm/css/xterm.css')}</style>`).replace('<link rel="stylesheet" href="/style.css">', `<style>${read('src/ui/style.css')}</style>`);
fs.mkdirSync(path.join(root, 'dist', 'ux-review'), {recursive:true});
const output = path.join(root, 'dist', 'ux-review', 'workspace.html');
fs.writeFileSync(output, html);
console.log(`Offline UI review: ${output}`);
