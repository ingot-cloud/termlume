const { join } = require('node:path');
const { buildSync } = require('esbuild');

module.exports = () => buildSync({
  entryPoints: [join(__dirname, '../src/ui/file-editor.js')],
  globalName: 'TermlumeFileEditor',
  bundle: true,
  minify: true,
  target: 'safari15',
  write: false
}).outputFiles[0].text;
