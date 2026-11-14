const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function verify(app) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const dependencies = {};
  for (const relative of ['Contents/MacOS/termlume', 'Contents/Resources/tools/macos/bin/git']) {
    const file = path.join(app, relative);
    const linked = execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8' }).split('\n').slice(1).filter(line => line.trim()).map(line => line.trim().split(' (')[0]);
    if (linked.some(name => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'))) {
      throw new Error(`${relative} requires non-system libraries: ${linked.join(', ')}`);
    }
    dependencies[relative] = linked;
  }
  const directory = path.join(app, 'Contents/Resources/tools/macos');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const [name, sha] of Object.entries(manifest.files)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    if (actual !== sha) throw new Error(`Mac resource checksum mismatch: ${name}`);
  }
  return { app, signatureVerified: true, systemLibrariesOnly: true, dependencies, gitVersion: manifest.gitVersion };
}
module.exports = { verify };
if (require.main === module) {
  try { console.log(JSON.stringify(verify(path.resolve(process.argv[2] || '/Applications/Termlume.app')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
