// Portable storage for the legacy Electron entry point. No OS credential APIs.
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const prefix = 'termlume-credential-v1:';

function deviceKey(directory, create) {
  const file = path.join(directory, 'credentials.key');
  if (create) {
    const candidate = randomBytes(32);
    try {
      fs.writeFileSync(file, candidate, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally { candidate.fill(0); }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size !== 32) throw new Error('本机凭据密钥格式无效。');
  const key = fs.readFileSync(file);
  if (key.length !== 32) { key.fill(0); throw new Error('本机凭据密钥格式无效。'); }
  return key;
}

function context(directory, target) {
  return Buffer.from(JSON.stringify([prefix, fs.realpathSync(directory), target]));
}

function encrypt(directory, target, password) {
  if (typeof password !== 'string' || !password || password.length > 4096) throw new Error('密码格式无效。');
  const key = deviceKey(directory, true);
  const plain = Buffer.from(password);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(context(directory, target));
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64');
  } finally { key.fill(0); plain.fill(0); }
}

function decrypt(directory, target, record) {
  // OS-encrypted legacy records are never read or migrated implicitly.
  if (typeof record !== 'string' || !record.startsWith(prefix) || record.length > 24000) {
    throw new Error('请重新输入并保存密码。');
  }
  const sealed = Buffer.from(record.slice(prefix.length), 'base64');
  if (sealed.length < 29) throw new Error('已保存的凭据无效。');
  const key = deviceKey(directory, false);
  let plain;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    cipher.setAAD(context(directory, target));
    cipher.setAuthTag(sealed.subarray(12, 28));
    plain = cipher.update(sealed.subarray(28));
    const final = cipher.final();
    return plain.toString('utf8') + final.toString('utf8');
  } finally { key.fill(0); plain?.fill(0); }
}

module.exports = { encrypt, decrypt };
