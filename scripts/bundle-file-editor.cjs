const { join } = require('node:path');
const { buildSync } = require('esbuild');

function bundle(entry, globalName) {
  return buildSync({
    entryPoints: [join(__dirname, '../src/ui', entry)], globalName,
    bundle: true, minify: true, loader: { '.wasm': 'binary' }, target: 'safari15', write: false
  }).outputFiles[0].text;
}

exports.editor = () => bundle('file-editor.js', 'TermlumeFileEditor');
exports.formatter = () => {
  const worker = bundle('file-formatter.js');
  return 'window.termlumeFormatterURL = URL.createObjectURL(new Blob([' + JSON.stringify(worker) + '], {type:"text/javascript"}));';
};
