const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {verify,names,manifest} = require('../scripts/updater-release.cjs');
const {verifyAssets} = require('../scripts/package-release.cjs');

function signer() {
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'),id=crypto.randomBytes(8);
  const key=Buffer.concat([Buffer.from('Ed'),id,publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
  const encodedKey=Buffer.from('untrusted comment: fixture public key\n'+key.toString('base64')+'\n').toString('base64');
  return {key:encodedKey,sign(data,version) {
    const comment=`timestamp:1700000000\tfile:fixture\tversion:${version}`;
    const signature=crypto.sign(null,crypto.createHash('blake2b512').update(data).digest(),privateKey);
    const block=Buffer.concat([Buffer.from('ED'),id,signature]);
    const global=crypto.sign(null,Buffer.concat([signature,Buffer.from(comment)]),privateKey);
    return Buffer.from(['untrusted comment: fixture signature',block.toString('base64'),'trusted comment: '+comment,global.toString('base64'),''].join('\n')).toString('base64');
  }};
}
test('release signing verifies both data and the signed version with the pinned public key',()=>{
  const source=Buffer.from('signed update content'),s=signer(),sig=s.sign(source,'1.2.3');
  assert.equal(verify(source,sig,'1.2.3',s.key),true);
  assert.throws(()=>verify(Buffer.from('tampered'),sig,'1.2.3',s.key),/verification failed/);
  assert.throws(()=>verify(source,sig,'9.9.9',s.key),/version mismatch/);
  assert.throws(()=>verify(source,sig,'1.2.3',signer().key),/key mismatch/);
  const edited=Buffer.from(sig,'base64').toString().replace('version:1.2.3','version:9.9.9');
  assert.throws(()=>verify(source,Buffer.from(edited).toString('base64'),'9.9.9',s.key),/verification failed/);
  assert.throws(()=>verify(source,'not a signature','1.2.3',s.key),/encoding/);
});
test('updater manifests advertise both verified native targets and enter the checksum list',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'termlume-update-manifest-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const s=signer(),version='1.2.3',commit='a'.repeat(40);
  for(const platform of ['macos-arm64','windows-x64']) {
    const spec=names(platform,version),label=platform==='macos-arm64'?'macOS-arm64':'Windows-x64',data=Buffer.from(platform);
    fs.writeFileSync(path.join(directory,spec.archive),data);
    fs.writeFileSync(path.join(directory,spec.signature),s.sign(data,version));
    fs.writeFileSync(path.join(directory,`Termlume-${version}-${label}.build.json`),JSON.stringify({version,tag:'v1.2.3',commit}));
  }
  fs.writeFileSync(path.join(directory,'SHA256SUMS'),'existing checksum\n');
  const document=manifest(directory,'v1.2.3',commit,{body:'Release notes',publishedAt:'2026-11-14T00:00:00Z'},s.key);
  assert.deepEqual(Object.keys(document.platforms).sort(),['darwin-aarch64','windows-x86_64']);
  assert.equal(document.platforms['darwin-aarch64'].url,'https://github.com/ingot-cloud/termlume/releases/download/v1.2.3/Termlume-1.2.3-macOS-arm64.app.tar.gz');
  assert(document.platforms['windows-x86_64'].url.endsWith('-setup.exe'));
  assert.equal(document.notes,'Release notes');
  assert(fs.readFileSync(path.join(directory,'SHA256SUMS'),'utf8').includes(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'latest.json'))).digest('hex')+'  latest.json'));
  assert.throws(()=>manifest(directory,'v1.2.3','b'.repeat(40),{},s.key),/commit\/version mismatch/);
});
test('release publishing cannot silently omit updater artifacts when the signing policy is required',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'termlume-update-policy-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,'Termlume-1.2.3-macOS-arm64.build.json'),JSON.stringify({updater:false}));
  assert.throws(()=>verifyAssets(directory,'v1.2.3','a'.repeat(40),true),/Missing signed updater artifacts/);
});
