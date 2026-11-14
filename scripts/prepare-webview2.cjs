const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const lock = require('./webview2.lock.json');
const { verifyArchive } = require('./prepare-windows-tools.cjs');

function installerPath() {
  const base = process.env.TERMLUME_WEBVIEW2_CACHE || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Caches/tauri')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'tauri')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tauri'));
  return path.join(base, lock.architecture, lock.cacheGuid, lock.archive);
}
async function prepare() {
  const file = installerPath();
  if (fs.existsSync(file)) { verifyArchive(file, lock); return file; }
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
  return file;
}
module.exports = { prepare, installerPath };
if (require.main === module) prepare().then(file => console.log(`Verified offline WebView2: ${file}`)).catch(error => { console.error(error); process.exitCode = 1; });
