const { execFileSync } = require('node:child_process');
const path = require('node:path');

async function main() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || '';
  if (process.env.TAURI_ENV_PLATFORM === 'windows' || target.includes('windows') || process.platform === 'win32') {
    if (target && target !== 'x86_64-pc-windows-msvc') throw new Error(`Windows bundled tools do not match ${target}`);
    await require('./prepare-windows-tools.cjs').prepare();
    await require('./prepare-webview2.cjs').prepare();
  } else if (process.env.TAURI_ENV_PLATFORM === 'macos' || target.includes('apple-darwin') || process.platform === 'darwin') {
    await require('./prepare-macos-tools.cjs').prepare();
  }
  execFileSync(process.execPath, [path.join(__dirname, 'tauri-assets.cjs')], { stdio: 'inherit' });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
