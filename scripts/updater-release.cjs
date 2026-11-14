const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { releaseVersion } = require('./release-version.cjs');
const root = path.resolve(__dirname, '..');
const publicKey = () => JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).plugins.updater.pubkey;

function decode(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error('Invalid updater signature encoding');
  return Buffer.from(value.trim(), 'base64');
}

// The updater uses the same Minisign envelope. Verify with Node's Ed25519
// implementation as well, before a release can advertise these artifacts.
function verify(data, encodedSignature, version, encodedKey = publicKey()) {
  const keyLines = decode(encodedKey).toString('utf8').trim().split(/\r?\n/);
  const lines = decode(encodedSignature).toString('utf8').trim().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid Minisign envelope');
  const key = decode(keyLines[1]), signature = decode(lines[1]), global = decode(lines[3]);
  if (key.length !== 42 || key.subarray(0,2).toString() !== 'Ed' || signature.length !== 74 || global.length !== 64 || !key.subarray(2,10).equals(signature.subarray(2,10))) throw new Error('Updater signature key mismatch');
  const comment = lines[2].slice('trusted comment: '.length);
  if (!comment.split('\t').includes(`version:${version}`)) throw new Error('Updater signature version mismatch');
  const algorithm = signature.subarray(0,2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Unsupported updater signature algorithm');
  const spki = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),format:'der',type:'spki' });
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null,message,spki,signature.subarray(10)) || !crypto.verify(null,Buffer.concat([signature.subarray(10),Buffer.from(comment)]),spki,global)) throw new Error('Updater signature verification failed');
  return true;
}

function names(platform, version) {
  const stem = `Termlume-${version}-${platform === 'macos-arm64' ? 'macOS-arm64' : 'Windows-x64'}`;
  const archive = platform === 'macos-arm64' ? `${stem}.app.tar.gz` : `${stem}-setup.exe`;
  return { archive, signature: `${archive}.sig`, target: platform === 'macos-arm64' ? 'darwin-aarch64' : 'windows-x86_64' };
}

function sign(file, version) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('Missing TAURI_SIGNING_PRIVATE_KEY GitHub Actions secret');
  try {
    execFileSync(process.execPath,[path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),'signer','sign','--app-version',version,file],{stdio:'pipe'});
  } catch { throw new Error('Updater signing failed; check the signing key and password configuration'); }
  verify(fs.readFileSync(file),fs.readFileSync(file+'.sig','utf8'),version);
}

function prepare(platform, bundle, output, version) {
  const spec = names(platform, version);
  fs.mkdirSync(output,{recursive:true});
  const file = path.join(output,spec.archive);
  if (platform === 'macos-arm64') {
    execFileSync('/usr/bin/tar',['-czf',file,'-C',path.join(bundle,'macos'),'Termlume.app'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    const restored = fs.mkdtempSync(path.join(output,'updater-audit-'));
    try {
      execFileSync('/usr/bin/tar',['-xzf',file,'-C',restored]);
      const {bundleManifest} = require('./package-release.cjs');
      if (JSON.stringify(bundleManifest(path.join(bundle,'macos/Termlume.app'))) !== JSON.stringify(bundleManifest(path.join(restored,'Termlume.app')))) throw new Error('Updater tar archive differs from the signed App');
      require('./verify-macos-bundle.cjs').verify(path.join(restored,'Termlume.app'));
    } finally {fs.rmSync(restored,{recursive:true,force:true});}
  } else if (!fs.existsSync(file)) throw new Error('Windows offline installer must be audited before signing');
  sign(file,version);
  return platform === 'macos-arm64' ? [spec.archive,spec.signature] : [spec.signature];
}

function manifest(directory, tag, commit, release, key = publicKey()) {
  const version = releaseVersion(tag), platforms = {};
  for (const platform of ['macos-arm64','windows-x64']) {
    const spec=names(platform,version);
    const label=platform==='macos-arm64'?'macOS-arm64':'Windows-x64';
    const report=JSON.parse(fs.readFileSync(path.join(directory,`Termlume-${version}-${label}.build.json`)));
    if (report.tag!==tag || report.commit!==commit || report.version!==version) throw new Error('Updater release commit/version mismatch');
    const signature=fs.readFileSync(path.join(directory,spec.signature),'utf8').trim();
    verify(fs.readFileSync(path.join(directory,spec.archive)),signature,version,key);
    platforms[spec.target]={signature,url:`https://github.com/ingot-cloud/termlume/releases/download/${tag}/${spec.archive}`};
  }
  const document={version,notes:release.body||'',pub_date:release.publishedAt||new Date().toISOString(),platforms};
  fs.writeFileSync(path.join(directory,'latest.json'),JSON.stringify(document,null,2)+'\n');
  const sums=path.join(directory,'SHA256SUMS');
  const previous=fs.readFileSync(sums,'utf8').split('\n').filter(line=>line && !line.endsWith('  latest.json'));
  fs.writeFileSync(sums,previous.join('\n')+'\n'+crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'latest.json'))).digest('hex')+'  latest.json\n');
  return document;
}
module.exports={verify,names,sign,prepare,manifest};
if(require.main===module) {
  try {
    const [action,tag,commit,metadata]=process.argv.slice(2);
    if(action==='manifest') manifest(path.join(root,'dist/release'),tag,commit,JSON.parse(fs.readFileSync(metadata)));
    else if(action==='check-key') {
      if(!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('Configure TAURI_SIGNING_PRIVATE_KEY in repository Actions secrets before publishing');
      const temporary=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'termlume-updater-key-check-'));
      try {
        const file=path.join(temporary,'challenge');
        fs.writeFileSync(file,crypto.randomBytes(32));
        sign(file,require(path.join(root,'package.json')).version);
      } finally {fs.rmSync(temporary,{recursive:true,force:true});}
    } else throw new Error('Invalid updater release command');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
