const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('Windows installation embeds the complete offline WebView2 installer', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.windows.conf.json'), 'utf8'));
  assert.deepEqual(config.bundle.windows.webviewInstallMode, { type: 'offlineInstaller', silent: true });
  assert.equal(config.bundle.windows.minimumWebview2Version, undefined, 'Do not add a minimum-version branch that invokes the online Edge updater');
  const installer = require('../scripts/webview2.lock.json');
  assert(installer.size > 100 * 1024 * 1024, 'A bootstrapper is not an offline runtime installer');
  assert.equal(installer.architecture, 'x64');
  assert.equal(new URL(installer.url).hostname, 'msedge.sf.dl.delivery.mp.microsoft.com');
});

test('production frontend has no remotely loaded scripts, styles or fonts', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.build.devUrl, undefined);
  const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
  for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)/g)) {
    assert(!/^(?:https?:)?\/\//i.test(match[1]), match[1]);
  }
  const css = fs.readFileSync(path.join(root, 'src/ui/style.css'), 'utf8');
  assert.doesNotMatch(css, /(?:url\(\s*["']?|@import\s+["'])(?:https?:)?\/\//i);
});
