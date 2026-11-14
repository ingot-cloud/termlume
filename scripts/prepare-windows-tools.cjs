const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const lock = require('./windows-tools.lock.json');
const root = path.resolve(__dirname, '..');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verifyArchive(file, spec) {
  if (fs.statSync(file).size !== spec.size || digest(file) !== spec.sha256) {
    throw new Error(`${spec.archive}: official archive SHA-256/size mismatch`);
  }
}

function filesIn(directory, relative = '') {
  const files = {};
  for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
    const next = path.posix.join(relative, name);
    const file = path.join(directory, next);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected runtime symlink: ${next}`);
    if (stat.isDirectory()) Object.assign(files, filesIn(directory, next));
    else if (stat.isFile() && next !== 'manifest.json') files[next] = { size: stat.size, sha256: digest(file) };
    else if (!stat.isFile()) throw new Error(`Unexpected runtime entry: ${next}`);
  }
  return files;
}

function verifyRuntime(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.target !== lock.target || manifest.lockSha256 !== digest(path.join(__dirname, 'windows-tools.lock.json'))
    || JSON.stringify(manifest.files) !== JSON.stringify(filesIn(directory))) throw new Error('Bundled Windows runtime is incomplete or changed');
  for (const spec of lock.packages) {
    for (const file of spec.required) {
      if (!manifest.files[`${spec.id}/${file}`]) throw new Error(`Missing bundled tool: ${spec.id}/${file}`);
    }
  }
  return manifest;
}

function extract(archive, destination) {
  // Archives have already been pinned and checked against official SHA-256.
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TERMLUME_TOOL_ARCHIVE, $env:TERMLUME_TOOL_DEST)'],
    { env: { ...process.env, TERMLUME_TOOL_ARCHIVE: archive, TERMLUME_TOOL_DEST: destination }, stdio: 'pipe' });
  } else {
    const names = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    if (names.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('Invalid runtime archive paths');
    execFileSync('/usr/bin/unzip', ['-q', archive, '-d', destination], { stdio: 'pipe' });
  }
}

async function prepare({ cache = process.env.TERMLUME_WINDOWS_TOOLS_CACHE || path.join(root, 'dist/windows-tools-cache'),
  output = path.join(root, 'src-tauri/vendor/windows'), offline = false } = {}) {
  try { return verifyRuntime(output); } catch { /* Recreate only generated runtime assets. */ }
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.windows-tools-'));
  try {
    for (const spec of lock.packages) {
      const archive = path.join(cache, spec.archive);
      if (!fs.existsSync(archive)) {
        if (offline) throw new Error(`Missing cached runtime: ${spec.archive}`);
        console.log(`Downloading official ${spec.id} ${spec.version}…`);
        const response = await fetch(spec.url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`${spec.archive}: HTTP ${response.status}`);
        const temporary = archive + `.${crypto.randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
          verifyArchive(temporary, spec);
          fs.renameSync(temporary, archive);
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      verifyArchive(archive, spec);
      const unpacked = path.join(staging, `unpack-${spec.id}`);
      extract(archive, unpacked);
      const target = path.join(staging, spec.id);
      if (spec.files) {
        fs.mkdirSync(target);
        for (const file of spec.files) fs.copyFileSync(path.join(unpacked, spec.stripPrefix || '', file), path.join(target, file));
        fs.rmSync(unpacked, { recursive: true });
      } else fs.renameSync(unpacked, target);
      for (const file of spec.required) {
        if (!fs.statSync(path.join(target, file)).isFile()) throw new Error(`Missing ${spec.id}/${file}`);
      }
    }
    fs.writeFileSync(path.join(staging, 'THIRD-PARTY-NOTICES.txt'), lock.packages.map(spec =>
      `${spec.id} ${spec.version}\nOfficial binary: ${spec.url}\nSHA-256: ${spec.sha256}\nSources and release: ${spec.source}\nLicenses and notices are preserved in ${spec.id}/.\n`).join('\n'));
    const manifest = { version: 1, target: lock.target, lockSha256: digest(path.join(__dirname, 'windows-tools.lock.json')),
      packages: lock.packages, files: filesIn(staging) };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    verifyRuntime(staging);
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(staging, output);
    console.log(`Windows tools ready: ${Object.keys(manifest.files).length} verified files`);
    return manifest;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { prepare, verifyArchive, verifyRuntime };
if (require.main === module) {
  (process.argv.includes('--verify') ? Promise.resolve().then(() => verifyRuntime(path.join(root, 'src-tauri/vendor/windows')))
    : prepare({ offline: process.argv.includes('--offline') }))
    .then(manifest => console.log(`Verified Windows tools: ${manifest.target}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
