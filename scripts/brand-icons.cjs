// Render the vector master with Tauri's bundled SVG renderer; keep only desktop assets.
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'termlume-brand-'));
try {
  execFileSync(process.execPath, [
    join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon',
    join(root, 'assets/brand/app-icon.svg'), '--output', temporary
  ], { stdio: 'inherit' });
  for (const file of ['icon.png', 'icon.icns', 'icon.ico']) {
    copyFileSync(join(temporary, file), join(root, 'src-tauri/icons', file));
  }
  execFileSync(process.execPath, [
    join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon',
    join(root, 'assets/brand/app-icon.svg'), '--output', temporary, '--png', '1024'
  ], { stdio: 'inherit' });
  copyFileSync(join(temporary, '1024x1024.png'), join(root, 'assets/brand/app-icon.png'));
  copyFileSync(join(root, 'assets/brand/app-icon.svg'), join(root, 'tauri-pilot/icon.svg'));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
