const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { stage } = require('../scripts/prepare-webview2.cjs');
const { verifyArchive } = require('../scripts/prepare-windows-tools.cjs');
const { findWebView2Installer } = require('../scripts/package-release.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-webview2-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'official.exe');
  fs.writeFileSync(source, 'pinned offline fixture');
  const spec = { archive: 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe', size: fs.statSync(source).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
  const output = path.join(directory, '锁定 版本 $cache');
  return { directory, source, spec, output };
}

test('WebView2 staging points NSIS at the exact verified file, independently of the latest-runtime redirect', t => {
  const { source, spec, output } = fixture(t);
  const destination = stage(source, output, spec);
  verifyArchive(destination, spec);
  const include = fs.readFileSync(path.join(output, 'installer.nsh'), 'utf8');
  assert(include.includes(`!define TERMLUME_WEBVIEW2_INSTALLER "\${__FILEDIR__}\\${spec.archive}"`));
  assert(include.includes(spec.sha256));
  assert.doesNotMatch(include, /https?:|go\.microsoft/);
});
test('WebView2 staging repairs modified generated files while keeping the pinned source authoritative', t => {
  const { source, spec, output } = fixture(t);
  const destination = stage(source, output, spec);
  fs.writeFileSync(destination, 'corrupted');
  fs.writeFileSync(path.join(output, 'installer.nsh'), 'stale path');
  stage(source, output, spec);
  verifyArchive(destination, spec);
  assert(fs.readFileSync(path.join(output, 'installer.nsh'), 'utf8').includes(spec.sha256));
});
test('a changed cached WebView2 file is rejected before replacing an existing verified installation source', t => {
  const { source, spec, output } = fixture(t);
  const destination = stage(source, output, spec);
  const before = fs.readFileSync(path.join(output, 'installer.nsh'), 'utf8');
  fs.writeFileSync(source, 'untrusted replacement');
  assert.throws(() => stage(source, output, spec), /SHA-256\/size mismatch.*expected.*got/);
  verifyArchive(destination, spec);
  assert.equal(fs.readFileSync(path.join(output, 'installer.nsh'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(output).sort(), [spec.archive, 'installer.nsh'].sort());
});
test('pinned WebView2 manifests cannot inject paths or preprocessor commands', t => {
  const { source, spec, output } = fixture(t);
  for (const archive of ['../evil.exe','a/b.exe','a\\b.exe','a"b.exe','a\nb.exe','${TEMP}.exe']) assert.throws(() => stage(source, output, {...spec,archive}), /Invalid pinned WebView2 manifest/);
});
test('NSIS audit identifies the actual runtime filename and rejects ambiguous embedded installers', () => {
  const runtime = '$PLUGINSDIR/MicrosoftEdgeWebView2RuntimeInstaller.exe';
  assert.equal(findWebView2Installer(['tools/webview2/termlume.exe',runtime,'other.exe']),runtime);
  assert.throws(() => findWebView2Installer(['tools/webview2/termlume.exe']),/exactly one/);
  assert.throws(() => findWebView2Installer([runtime,'backup/MicrosoftEdgeWebView2RuntimeInstallerX64.exe']),/exactly one/);
});
