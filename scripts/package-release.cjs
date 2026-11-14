const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { releaseVersion } = require('./release-version.cjs');
const root = path.resolve(__dirname, '..');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });

function specification(platform, version) {
  const label = { 'macos-arm64': 'macOS-arm64', 'windows-x64': 'Windows-x64' }[platform];
  if (!label) throw new Error(`Unsupported release platform: ${platform}`);
  const stem = `Termlume-${version}-${label}`;
  return { platform, stem, target: platform === 'macos-arm64' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc',
    archives: [`${stem}-offline.zip`, ...(platform === 'windows-x64' ? [`${stem}-setup.exe`] : [])],
    metadata: `${stem}.build.json`, sums: `${stem}.sha256` };
}

function filesIn(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative)).sort().flatMap(name => {
    const next = path.posix.join(relative, name);
    return fs.lstatSync(path.join(directory, next)).isDirectory() ? filesIn(directory, next) : [next];
  });
}

function bundleManifest(directory) {
  return Object.fromEntries(filesIn(directory).map(name => {
    const file = path.join(directory, name);
    return [name, fs.lstatSync(file).isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : digest(file)];
  }));
}

function packageMac(bundle, archive, temporary, version) {
  const app = path.join(bundle, 'macos/Termlume.app');
  const audit = require('./verify-macos-bundle.cjs').verify(app);
  const info = path.join(app, 'Contents/Info.plist');
  const actual = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info]).trim();
  if (actual !== version && !(version.includes('-') && actual === version.split('-')[0])) throw new Error(`Built App version ${actual} does not match ${version}`);
  const architectures = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS/termlume')]).trim();
  if (architectures !== 'arm64') throw new Error(`Expected an arm64 App, got ${architectures}`);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const extracted = path.join(temporary, 'unpacked');
  run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
  const restored = path.join(extracted, 'Termlume.app');
  if (JSON.stringify(bundleManifest(app)) !== JSON.stringify(bundleManifest(restored))) throw new Error('Archived macOS App differs from the signed build');
  require('./verify-macos-bundle.cjs').verify(restored);
  if (!(fs.statSync(path.join(restored, 'Contents/MacOS/termlume')).mode & 0o111)) throw new Error('ZIP lost executable permissions');
  return { ...audit, app: 'Termlume.app', architecture: architectures, archiveRoundTripVerified: true,
    signing: 'ad-hoc', notarized: false };
}

function packageWindows(bundle, installer, archive, temporary, version) {
  const nsis = path.join(bundle, 'nsis');
  const installers = fs.readdirSync(nsis).filter(name => name.endsWith('.exe'));
  if (installers.length !== 1) throw new Error(`Expected exactly one NSIS installer, found ${installers.length}`);
  if (!installers[0].includes(`_${version}_`)) throw new Error('NSIS installer filename does not match the release version');
  fs.copyFileSync(path.join(nsis, installers[0]), installer);
  const extracted = path.join(temporary, 'unpacked');
  run('7z', ['x', installer, `-o${extracted}`, '-y']);
  const files = filesIn(extracted);
  const webview = require('./webview2.lock.json');
  const runtime = files.filter(name => /webview2.*\.exe$/i.test(name));
  if (runtime.length !== 1) throw new Error('NSIS must embed exactly one complete WebView2 installer');
  require('./prepare-windows-tools.cjs').verifyArchive(path.join(extracted, runtime[0]), webview);
  const audit = require('./verify-windows-tools.cjs').audit(path.join(extracted, 'tools/windows'));
  const executable = path.join(extracted, 'termlume.exe');
  const imports = require('./verify-windows-tools.cjs').imports(executable);
  if (imports.some(name => /^(?:vcruntime|msvcp|concrt)\d/i.test(name))) throw new Error('App requires a separately installed VC++ runtime');
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'test-windows-bundled-tools.ps1'), '-InstallDir', extracted]);
  const contents = path.join(temporary, 'zip');
  fs.mkdirSync(contents);
  fs.copyFileSync(installer, path.join(contents, path.basename(installer)));
  fs.writeFileSync(path.join(contents, 'README.txt'),
    'Termlume Windows x64\r\nRun the included setup.exe to install.\r\nGit, OpenSSH and the complete WebView2 offline installer are embedded.\r\nNo downloads are needed for installation or local workspace use.\r\nSSH/SFTP and remote Git require access to your servers.\r\n');
  run('7z', ['a', '-tzip', archive, '.'], { cwd: contents });
  run('7z', ['t', archive]);
  return { ...audit, architecture: 'x64', webview2Sha256: webview.sha256,
    embeddedOfflineInstallerVerified: true, bundledToolsExecuted: true, applicationImports: imports, signing: 'unsigned' };
}

function packageRelease(platform, { bundleDirectory, outputDirectory = path.join(root, 'dist/release') } = {}) {
  const version = require(path.join(root, 'package.json')).version;
  const tag = process.env.RELEASE_TAG || `v${version}`;
  if (releaseVersion(tag) !== version) throw new Error('Run release-version.cjs before packaging a different release tag');
  const spec = specification(platform, version);
  if ((platform === 'macos-arm64' && (process.platform !== 'darwin' || process.arch !== 'arm64'))
    || (platform === 'windows-x64' && (process.platform !== 'win32' || process.arch !== 'x64'))) throw new Error('Package on the matching native platform');
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  if (process.env.RELEASE_COMMIT && process.env.RELEASE_COMMIT !== commit) throw new Error('Checkout differs from the release commit');
  const bundle = path.resolve(bundleDirectory || process.env.RELEASE_BUNDLE_DIR
    || path.join(root, 'src-tauri/target', spec.target, 'release/bundle'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-release-'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  try {
    const archive = path.join(temporary, spec.archives[0]);
    const audit = platform === 'macos-arm64' ? packageMac(bundle, archive, temporary, version)
      : packageWindows(bundle, path.join(temporary, spec.archives[1]), archive, temporary, version);
    const files = Object.fromEntries(spec.archives.map(name => [name, {
      sha256: digest(path.join(temporary, name)), size: fs.statSync(path.join(temporary, name)).size
    }]));
    const report = { schema: 1, platform, target: spec.target, version, tag, commit,
      builtAt: new Date().toISOString(), rust: run('rustc', ['--version']).trim(), node: process.version, audit, files };
    fs.writeFileSync(path.join(temporary, spec.metadata), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(temporary, spec.sums), spec.archives.map(name => `${files[name].sha256}  ${name}\n`).join(''));
    for (const name of [...spec.archives, spec.metadata, spec.sums]) fs.copyFileSync(path.join(temporary, name), path.join(outputDirectory, name));
    console.log(`Verified release assets: ${spec.archives.join(', ')}`);
    return report;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function verifyAssets(directory, tag, expectedCommit = process.env.RELEASE_COMMIT) {
  const version = releaseVersion(tag);
  const all = [], commits = new Set();
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const spec = specification(platform, version);
    const report = JSON.parse(fs.readFileSync(path.join(directory, spec.metadata), 'utf8'));
    if (report.schema !== 1 || report.version !== version || report.tag !== tag || report.platform !== platform
      || report.target !== spec.target || !/^[0-9a-f]{40}$/.test(report.commit)
      || (expectedCommit && report.commit !== expectedCommit)) throw new Error(`Release metadata mismatch: ${spec.metadata}`);
    commits.add(report.commit);
    if (JSON.stringify(Object.keys(report.files).sort()) !== JSON.stringify([...spec.archives].sort())) throw new Error(`Unexpected asset set: ${spec.metadata}`);
    for (const name of spec.archives) {
      const file = path.join(directory, name), entry = report.files[name];
      if (fs.statSync(file).size !== entry.size || digest(file) !== entry.sha256) throw new Error(`Release asset checksum mismatch: ${name}`);
    }
    const checksums = spec.archives.map(name => `${report.files[name].sha256}  ${name}\n`).join('');
    if (fs.readFileSync(path.join(directory, spec.sums), 'utf8') !== checksums) throw new Error(`Checksum list mismatch: ${spec.sums}`);
    all.push(...spec.archives, spec.metadata, spec.sums);
  }
  if (commits.size !== 1) throw new Error('Platform builds do not belong to the same commit');
  const actual = fs.readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...all].sort())) throw new Error('Unexpected or incomplete release directory');
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), [...all].sort().map(name => `${digest(path.join(directory, name))}  ${name}\n`).join(''));
  return all;
}

module.exports = { specification, packageRelease, verifyAssets, bundleManifest };
if (require.main === module) {
  try {
    if (process.argv[2] === 'verify') console.log(`Verified ${verifyAssets(path.join(root, 'dist/release'), process.argv[3]).length} assets; SHA256SUMS ready`);
    else packageRelease(process.argv[2]);
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
