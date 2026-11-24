const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

// The desktop worker can instantiate bundled WebAssembly but cannot evaluate JS strings.
const code = buildSync({
  entryPoints: [path.join(__dirname, '../src/ui/file-formatter.js')],
  bundle: true, minify: true, write: false, loader: { '.wasm': 'binary' }, target: 'safari15'
}).outputFiles[0].text;

async function format(parser, text, filename) {
  let result;
  const worker = vm.createContext({
    setTimeout, clearTimeout, TextEncoder, TextDecoder, performance,
    postMessage: data => { result = data; }
  }, { codeGeneration: { strings: false, wasm: true } });
  vm.runInContext('self = globalThis;', worker);
  vm.runInContext(code, worker);
  await worker.onmessage({ data: { text, parser, path: filename, cursor: 1 } });
  return result;
}

const samples = [
  ['json', '\uFEFF{"enabled":true,"port":22}', 'settings.json', /^\uFEFF\{ "enabled": true, "port": 22 \}\n$|^\uFEFF\{\n/],
  ['jsonc', '{\n// port\n"port":22,}', 'tsconfig.json', /\/\/ port/],
  ['json5', '{port:22,}', 'config.json5', /port: 22/],
  ['babel', 'export const n={x:1}', 'index.jsx', /x: 1/],
  ['typescript', 'const view=(x:number)=><div>{x}<\/div>', 'view.tsx', /x: number/],
  ['html', '<main><div>x</div></main>', 'index.html', /<main>/],
  ['vue', '<template><div>{{x}}</div></template>', 'app.vue', /\{\{ x \}\}/],
  ['css', 'p{color:red}', 'style.css', /color: red/],
  ['scss', '$a:red;p{color:$a}', 'style.scss', /color: \$a/],
  ['less', '@a:red;p{color:@a}', 'style.less', /color: @a/],
  ['yaml', 'ports: [80,443]', 'compose.yaml', /80, 443/],
  ['markdown', '# Title\n\n-   one', 'Readme.md', /- one/],
  ['mdx', '# Title\n\n<X a={1+2}/>', 'page.mdx', /1 \+ 2/],
  ['graphql', 'query Q{user{id}}', 'q.graphql', /query Q \{/],
  ['xml', '<a x="a">hi <b/> there</a>', 'test.xml', /hi <b\s*\/> there/],
  ['sql', 'select a,b from users where id=1', 'test.sql', /from\s+users/i],
  ['python', 'x={ "port":22}', 'test.py', /"port": 22/],
  ['toml', '[app]\nport=22', 'config.toml', /port = 22/],
  ['sql:postgresql', 'select a::int from foo', 'schema.sql', /a::int/i],
  ['shell', '#!/bin/sh\n# retain\nif true; then\necho ok\nfi', 'run.sh', /# retain\nif true; then\n  echo ok\nfi/]
];

for (const [parser, input, file, expected] of samples) {
  test('local formatter for ' + file, async () => {
    const result = await format(parser, input, file);
    assert.equal(result.error, undefined);
    assert.match(result.formatted, expected);
    assert.ok(result.cursor >= 0 && result.cursor <= result.formatted.length);
  });
}

for (const [parser, input] of [['json', '{oops'], ['python', 'def f(:'], ['toml', '[missing'], ['shell', 'if true; then']]) {
  test('invalid ' + parser + ' returns an error with no replacement text', async () => {
    const result = await format(parser, input, 'broken');
    assert.ok(result.error);
    assert.equal(result.formatted, undefined);
  });
}
