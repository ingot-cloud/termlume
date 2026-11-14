const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyArchive } = require('./prepare-windows-tools.cjs');
const lock = require('./webview2.lock.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(script) {
  const directory = path.dirname(script);
  const original = fs.readFileSync(script, 'utf8').replace(/^\uFEFF/, '');
  if (!original.includes('!define INSTALLWEBVIEW2MODE "offlineInstaller"') || !original.includes('!define MINIMUMWEBVIEW2VERSION ""')) {
    throw new Error('Installer must use offline WebView2 without an online minimum-version updater');
  }
  const installer = original.match(/^!define WEBVIEW2INSTALLERPATH "([^"]+)"/m)?.[1];
  if (!installer) throw new Error('Complete embedded WebView2 installer missing');
  verifyArchive(installer, lock);
  // makensis -PPO on this host cannot resolve the additional Tauri plugin.
  // Stub ONLY its runtime local-utility calls in an audit copy. Original
  // installation conditions, downloader commands and shipped script stay intact.
  const local = new Set(['SemverCompare', 'StrReplace', 'FindProcess', 'FindProcessCurrentUser', 'KillProcess', 'KillProcessCurrentUser', 'RunAsUser']);
  const stub = text => text.replace(/^\s*nsis_tauri_utils::(\w+)[^\n]*$/gm, (_, name) => {
    if (!local.has(name)) throw new Error(`Unaudited Tauri plugin call: ${name}`);
    return '  DetailPrint "Local Tauri utility omitted for preprocessing audit"';
  });
  const auditScript = path.join(directory, 'offline-preprocess-audit.nsi');
  const auditUtilities = path.join(directory, 'offline-utils-audit.nsh');
  const before = sha(script);
  let expanded;
  try {
    fs.writeFileSync(auditUtilities, stub(fs.readFileSync(path.join(directory, 'utils.nsh'), 'utf8').replace(/^\uFEFF/, '')));
    fs.writeFileSync(auditScript, stub(original).replace('!include "utils.nsh"', '!include "offline-utils-audit.nsh"'));
    expanded = execFileSync(process.env.TERMLUME_MAKENSIS || '/opt/homebrew/bin/makensis', ['-PPO', path.basename(auditScript)],
      { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } finally {
    fs.rmSync(auditScript, { force: true }); fs.rmSync(auditUtilities, { force: true });
  }
  if (sha(script) !== before) throw new Error('Original installer script changed');
  if (/nsisdl::download|inetc::|go\.microsoft\.com|needsadmin=true/i.test(expanded)) throw new Error('Online dependency path found in active installer');
  if (!expanded.includes('MicrosoftEdgeWebView2RuntimeInstaller.exe')) throw new Error('Offline payload is not in active installer');
  return { installerScriptSha256: before, originalScriptUnchanged: true, activeDownloaderCommands: 0,
    preprocessingLocalPluginStubs: [...local], embeddedWebView2: { ...lock, path: installer },
    preprocessedSha256: crypto.createHash('sha256').update(expanded).digest('hex') };
}
module.exports = { verify };
if (require.main === module) {
  try {
    const report = verify(path.resolve(process.argv[2]));
    fs.mkdirSync(path.resolve(__dirname, '../dist'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../dist/offline-installer-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('PASS: full WebView2 payload verified; active NSIS script has no dependency downloader');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
