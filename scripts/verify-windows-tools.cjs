const fs = require('node:fs');
const path = require('node:path');
const { verifyRuntime } = require('./prepare-windows-tools.cjs');
const lock = require('./windows-tools.lock.json');

function imports(file) {
  const bytes = fs.readFileSync(file);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('binary', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664
    || bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error(`Not an x64 Windows PE: ${file}`);
  const count = bytes.readUInt16LE(pe + 6);
  const sections = pe + 24 + bytes.readUInt16LE(pe + 20);
  const offset = rva => {
    for (let n = 0; n < count; n++) {
      const start = sections + n * 40;
      const address = bytes.readUInt32LE(start + 12);
      if (rva >= address && rva < address + Math.max(bytes.readUInt32LE(start + 8), bytes.readUInt32LE(start + 16))) {
        return rva - address + bytes.readUInt32LE(start + 20);
      }
    }
    throw new Error(`Invalid PE section: ${file}`);
  };
  const table = bytes.readUInt32LE(pe + 24 + 112 + 8);
  if (!table) return [];
  const result = [];
  for (let entry = offset(table); bytes.readUInt32LE(entry + 12); entry += 20) {
    const name = offset(bytes.readUInt32LE(entry + 12));
    result.push(bytes.toString('ascii', name, bytes.indexOf(0, name)).toLowerCase());
  }
  return result;
}

function audit(directory) {
  const manifest = verifyRuntime(directory);
  // Windows 10/11 system components, not separately installed redistributables.
  const system = new Set(('advapi32 bcrypt bcryptprimitives cabinet cfgmgr32 comctl32 comdlg32 credui crypt32 cryptbase cryptsp dbghelp dnsapi dwmapi gdi32 hid imagehlp imm32 iphlpapi kernel32 mpr msimg32 msvcrt ncrypt netapi32 normaliz ntdll ole32 oleaut32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 userenv usp10 uxtheme version winhttp wininet winmm winspool wintrust wldap32 ws2_32 wtsapi32 ucrtbase').split(' ').map(name => name + '.dll'));
  const files = Object.keys(manifest.files);
  // MinGit also includes optional credential-manager/.NET GUI components.
  // Check the dependency graph of the tools Termlume actually invokes.
  const entries = [...new Set([
    ...lock.packages.flatMap(spec => spec.required.filter(file => /\.(exe|dll)$/i.test(file)).map(file => `${spec.id}/${file}`)),
    ...files.filter(file => file.startsWith('openssh/') && /\.(exe|dll)$/i.test(file))
  ])];
  const lower = new Set(files.map(file => file.toLowerCase()));
  const dependencies = {};
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (dependencies[file]) continue;
    const names = imports(path.join(directory, file));
    dependencies[file] = names;
    for (const name of names) {
      if (system.has(name) || /^(?:api|ext)-ms-win-/.test(name)) continue;
      const locations = [path.posix.dirname(file), ...lock.layout.path];
      const dependency = locations.map(dir => path.posix.join(dir, name).toLowerCase()).find(file => lower.has(file));
      if (!dependency) throw new Error(`${file} requires an unbundled DLL: ${name}`);
      queue.push(files.find(file => file.toLowerCase() === dependency));
    }
  }
  return { target: lock.target, packages: lock.packages.map(({ id, version, sha256 }) => ({ id, version, sha256 })),
    fileCount: files.length, entryPoints: entries, binaryCount: Object.keys(dependencies).length, unpackedBytes: Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0),
    dependencyClosureVerified: true, dependencies };
}

module.exports = { audit, imports };
if (require.main === module) {
  try {
    const report = audit(path.resolve(__dirname, '../src-tauri/vendor/windows'));
    fs.mkdirSync(path.resolve(__dirname, '../dist'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../dist/windows-tools-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Windows tools: ${report.fileCount} files, ${report.binaryCount} x64 binaries; DLL dependency closure passed`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
