const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyArchive } = require('./prepare-windows-tools.cjs');
const lock = require('./macos-tools.lock.json');
const root = path.resolve(__dirname, '..');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lockHash = () => digest(path.join(__dirname, 'macos-tools.lock.json'));

function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.lockSha256 !== lockHash() || manifest.target !== lock.target) throw new Error('Mac Git build does not match pinned source/recipe');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (digest(path.join(directory, name)) !== expected) throw new Error(`Mac Git changed: ${name}`);
  }
  const binary = path.join(directory, 'bin/git');
  const libraries = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1).filter(line => line.trim());
  if (libraries.some(line => !/^\s+\/(?:usr\/lib\/|System\/Library\/)/.test(line))) throw new Error('Mac Git has an external library dependency');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary]);
  return manifest;
}

async function prepare() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This Mac Git recipe targets Apple Silicon');
  const output = path.join(root, 'src-tauri/vendor/macos');
  try { return verify(output); } catch { /* Prepare generated runtime. */ }
  const cache = process.env.TERMLUME_MACOS_TOOLS_CACHE || path.join(root, 'dist/macos-tools-cache');
  const bundle = path.join(cache, 'bundle');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    const manifest = verify(bundle);
    fs.rmSync(output, { recursive: true, force: true });
    fs.cpSync(bundle, output, { recursive: true });
    return manifest;
  } catch { /* Build only on the developer machine, never on app startup. */ }
  const archive = path.join(cache, lock.archive);
  if (!fs.existsSync(archive)) {
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Git source: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== lock.size || crypto.createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('Mac Git source checksum mismatch');
    fs.writeFileSync(archive, bytes, { flag: 'wx' });
  }
  verifyArchive(archive, lock);
  const work = fs.mkdtempSync(path.join(cache, '.git-build-'));
  try {
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', work]);
    const source = path.join(work, `git-${lock.gitVersion}`);
    const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    execFileSync('/usr/bin/make', lock.makeArguments, { cwd: source, env, stdio: 'inherit' });
    const staging = path.join(work, 'bundle');
    fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
    const binary = path.join(staging, 'bin/git');
    fs.copyFileSync(path.join(source, 'git'), binary); fs.chmodSync(binary, 0o755);
    execFileSync('/usr/bin/strip', ['-x', binary]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'app.termlume.git', binary]);
    fs.copyFileSync(path.join(source, 'COPYING'), path.join(staging, 'COPYING'));
    fs.writeFileSync(path.join(staging, 'SOURCE.txt'), `Git ${lock.gitVersion}\nSource: ${lock.url}\nSHA-256: ${lock.sha256}\nThis client serves Termlume SSH vault synchronization; HTTPS uses built-in libgit2.\n`);
    const manifest = { version: 1, target: lock.target, gitVersion: lock.gitVersion, lockSha256: lockHash(), source: lock, files: {} };
    for (const name of ['bin/git', 'COPYING', 'SOURCE.txt']) manifest.files[name] = digest(path.join(staging, name));
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    verify(staging);
    fs.rmSync(bundle, { recursive: true, force: true }); fs.cpSync(staging, bundle, { recursive: true });
    fs.rmSync(output, { recursive: true, force: true }); fs.cpSync(staging, output, { recursive: true });
    console.log(`Mac Git ${lock.gitVersion} ready with system libraries only`);
    return manifest;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { prepare, verify };
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
