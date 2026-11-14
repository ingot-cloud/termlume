const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseVersion, setVersion } = require('../scripts/release-version.cjs');
const { specification, verifyAssets } = require('../scripts/package-release.cjs');
const root = path.resolve(__dirname, '..');
const sha = contents => crypto.createHash('sha256').update(contents).digest('hex');
const commit = 'a'.repeat(40);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function project(t) {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'src-tauri'));
  for (const file of ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json']) fs.copyFileSync(path.join(root,file),path.join(dir,file));
  return dir;
}
function assets(t, version = '1.2.3-beta.1') {
  const dir = fixture(t);
  for (const platform of ['macos-arm64','windows-x64']) {
    const spec = specification(platform,version), files = {};
    for (const name of spec.archives) {
      const data=Buffer.from(`fixture for ${name}`);fs.writeFileSync(path.join(dir,name),data);
      files[name]={size:data.length,sha256:sha(data)};
    }
    fs.writeFileSync(path.join(dir,spec.metadata),JSON.stringify({schema:1,version,tag:`v${version}`,platform,target:spec.target,commit,files}));
    fs.writeFileSync(path.join(dir,spec.sums),spec.archives.map(name=>`${files[name].sha256}  ${name}\n`).join(''));
  }
  return dir;
}
test('release tags accept canonical stable/prerelease versions and reject unsafe or ambiguous tags', () => {
  for (const tag of ['v0.1.0','v1.2.3','v1.2.3-beta.1','v1.2.3-rc.0']) assert.equal(releaseVersion(tag),tag.slice(1));
  for (const tag of ['1.2.3','v1.2','v01.2.3','v1.2.3-01','v1.2.3+build','v65536.0.0','v1.2.3\n','v1.2.3;echo bad','v1.2.3/branch','']) assert.throws(()=>releaseVersion(tag));
});
test('release versions update Node, Tauri and only the Termlume Cargo package without changing dependencies', t => {
  const dir=project(t), lock=path.join(dir,'src-tauri/Cargo.lock'), original=fs.readFileSync(lock,'utf8');
  const oldVersion=JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).version;
  const before=JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json'))).packages['node_modules/ssh2'];
  assert.equal(setVersion(dir,'v1.2.3-beta.1'),'1.2.3-beta.1');
  for (const name of ['package.json','package-lock.json','src-tauri/tauri.conf.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(dir,name))).version,'1.2.3-beta.1');
  const nodeLock=JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json')));
  assert.equal(nodeLock.packages[''].version,'1.2.3-beta.1');assert.deepEqual(nodeLock.packages['node_modules/ssh2'],before);
  assert.equal(fs.readFileSync(lock,'utf8').replace(/(name = "termlume"\nversion = ")[^"]+/,(_all,start)=>start+oldVersion),original);
  assert.match(fs.readFileSync(path.join(dir,'src-tauri/Cargo.toml'),'utf8'),/^version = "1\.2\.3-beta\.1"$/m);
});
test('incomplete project metadata cannot leave partially updated version files', t => {
  const dir=project(t), pkg=path.join(dir,'package.json'), before=fs.readFileSync(pkg,'utf8');
  fs.writeFileSync(path.join(dir,'src-tauri/Cargo.lock'),'[[package]]\nname = "other"\nversion = "0.1.0"\n');
  assert.throws(()=>setVersion(dir,'v2.0.0'),/unique Termlume version/);assert.equal(fs.readFileSync(pkg,'utf8'),before);
});
test('release upload accepts exactly both platforms from one commit and generates complete checksums', t => {
  const dir=assets(t), files=verifyAssets(dir,'v1.2.3-beta.1',commit);assert.equal(files.length,7);
  const sums=fs.readFileSync(path.join(dir,'SHA256SUMS'),'utf8');assert.equal(sums.trim().split('\n').length,7);
  for (const name of files) assert(sums.includes(`${sha(fs.readFileSync(path.join(dir,name)))}  ${name}\n`));
  assert.deepEqual(verifyAssets(dir,'v1.2.3-beta.1',commit),files);
});
test('release upload rejects corrupted, incomplete, extra or mixed-commit assets', t => {
  const spec=specification('macos-arm64','1.2.3-beta.1');
  const changed=assets(t);fs.writeFileSync(path.join(changed,spec.archives[0]),'corrupted');assert.throws(()=>verifyAssets(changed,'v1.2.3-beta.1',commit),/checksum mismatch/);
  const missing=assets(t);fs.unlinkSync(path.join(missing,spec.metadata));assert.throws(()=>verifyAssets(missing,'v1.2.3-beta.1',commit));
  const extra=assets(t);fs.writeFileSync(path.join(extra,'unrelated-private-file.txt'),'test');assert.throws(()=>verifyAssets(extra,'v1.2.3-beta.1',commit),/Unexpected or incomplete/);
  const mixed=assets(t), metadata=path.join(mixed,spec.metadata), report=JSON.parse(fs.readFileSync(metadata));report.commit='b'.repeat(40);fs.writeFileSync(metadata,JSON.stringify(report));
  assert.throws(()=>verifyAssets(mixed,'v1.2.3-beta.1',commit),/metadata mismatch/);assert.throws(()=>verifyAssets(mixed,'v1.2.3-beta.1'),/same commit/);
});
test('release upload rejects mismatched targets, tags, manifests and checksum lists', t => {
  const spec=specification('windows-x64','1.2.3-beta.1');
  for (const edit of [r=>r.target='wrong',r=>r.tag='v1.2.3',r=>r.files['../secret']={sha256:'',size:0}]) {
    const dir=assets(t), file=path.join(dir,spec.metadata), report=JSON.parse(fs.readFileSync(file));edit(report);fs.writeFileSync(file,JSON.stringify(report));
    assert.throws(()=>verifyAssets(dir,'v1.2.3-beta.1',commit));
  }
  const dir=assets(t);fs.writeFileSync(path.join(dir,spec.sums),'wrong checksum');assert.throws(()=>verifyAssets(dir,'v1.2.3-beta.1',commit),/Checksum list mismatch/);
});
