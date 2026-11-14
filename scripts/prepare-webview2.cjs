const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const lock = require('./webview2.lock.json');
const { verifyArchive } = require('./prepare-windows-tools.cjs');
const root = path.resolve(__dirname, '..');

function stage(file, output = path.join(root, 'src-tauri/vendor/webview2'), spec = lock) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.exe$/.test(spec.archive) || !/^[a-f0-9]{64}$/i.test(spec.sha256)) throw new Error('Invalid pinned WebView2 manifest');
  verifyArchive(file, spec);
  fs.mkdirSync(output, { recursive: true });
  const destination = path.join(output, spec.archive);
  try { verifyArchive(destination, spec); }
  catch {
    const temporary = destination + `.${crypto.randomUUID()}.tmp`;
    try {
      fs.copyFileSync(file, temporary);
      verifyArchive(temporary, spec);
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  // Capture the include's own directory at preprocessing time. No workspace path
  // is inserted into NSIS source text, and macro expansion keeps it stable.
  // NSIS on Windows requires backslashes when splitting compiler file paths.
  const include = `; Generated from scripts/webview2.lock.json. Do not edit.\n!define TERMLUME_WEBVIEW2_INSTALLER "\${__FILEDIR__}\\${spec.archive}"\n!define TERMLUME_WEBVIEW2_SHA256 "${spec.sha256}"\n`;
  fs.writeFileSync(path.join(output, 'installer.nsh'), include);
  return destination;
}

function installerPath() {
  const base = process.env.TERMLUME_WEBVIEW2_CACHE || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Caches/tauri')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'tauri')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tauri'));
  return path.join(base, lock.architecture, lock.cacheGuid, lock.archive);
}
async function prepare() {
  const file = installerPath();
  if (fs.existsSync(file)) return stage(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + `.${crypto.randomUUID()}.tmp`;
  try {
    console.log('Preparing complete WebView2 offline installer…');
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`WebView2: HTTP ${response.status}`);
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    verifyArchive(temporary, lock);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return stage(file);
}
module.exports = { prepare, installerPath, stage };
if (require.main === module) prepare().then(file => console.log(`Verified offline WebView2: ${file}`)).catch(error => { console.error(error); process.exitCode = 1; });
