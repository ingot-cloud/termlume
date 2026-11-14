const fs = require('node:fs');
const path = require('node:path');

function releaseVersion(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag || '');
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)
    || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Release 标签必须为 vMAJOR.MINOR.PATCH 或 vMAJOR.MINOR.PATCH-beta.1，每段版本号不超过 65535。');
  }
  return tag.slice(1);
}

function replaceOne(source, expression, replacement, name) {
  const matches = [...source.matchAll(new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : expression.flags + 'g'))];
  if (matches.length !== 1) throw new Error(`Cannot locate a unique Termlume version in ${name}`);
  return source.replace(expression, replacement);
}

function setVersion(root, tag) {
  const version = releaseVersion(tag);
  const updates = new Map();
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const value = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    value.version = version;
    if (file === 'package-lock.json') {
      if (!value.packages?.['']) throw new Error('Missing root package in package-lock.json');
      value.packages[''].version = version;
    }
    updates.set(file, JSON.stringify(value, null, 2) + '\n');
  }
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const packageSection = /(^\[package\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  updates.set('src-tauri/Cargo.toml', replaceOne(cargo, packageSection, (_all, header, body) => {
    if (!/^name\s*=\s*"termlume"\s*$/m.test(body)) throw new Error('Unexpected Cargo package name');
    return header + replaceOne(body, /^version\s*=\s*"[^"\r\n]+"/m, `version = "${version}"`, 'Cargo.toml');
  }, 'Cargo.toml'));
  const lock = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  updates.set('src-tauri/Cargo.lock', replaceOne(lock,
    /(^\[\[package\]\]\r?\nname = "termlume"\r?\n)version = "[^"\r\n]+"/m,
    `$1version = "${version}"`, 'Cargo.lock'));
  // Parse/validate every file before writing any of them.
  for (const [file, value] of updates) fs.writeFileSync(path.join(root, file), value);
  return version;
}

module.exports = { releaseVersion, setVersion };
if (require.main === module) {
  try {
    const tag = process.argv[2];
    const version = setVersion(path.resolve(__dirname, '..'), tag);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`);
    console.log(`Release ${tag}: Node, Tauri and Cargo versions set to ${version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
