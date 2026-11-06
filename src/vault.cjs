const { randomBytes, randomUUID } = require('node:crypto');
const sodium = require('libsodium-wrappers-sumo');

const format = 'termlume-vault';
const maxDocumentSize = 8 * 1024 * 1024;
const scopes = ['local', 'portable'];
const wrapContext = (id, slot) => `termlume:v1:${id}:${slot}`;
const dataContext = (header, scope) => JSON.stringify([
  format, 1, scope, header.id, header.salt, header.password.nonce, header.password.ciphertext,
  header.recovery.nonce, header.recovery.ciphertext
]);

function encode(value) { return Buffer.from(value).toString('base64url'); }

function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('保险库编码无效。');
  const decoded = Buffer.from(value, 'base64url');
  if (encode(decoded) !== value || (size !== undefined && decoded.length !== size)) throw new Error('保险库编码无效。');
  return decoded;
}

function seal(key, data, context) {
  const nonce = randomBytes(24);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(data, context, null, nonce, key);
  return { nonce: encode(nonce), ciphertext: encode(ciphertext) };
}

function open(key, box, context) {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(box.ciphertext), context, decode(box.nonce, 24), key);
}

function passwordKey(password, salt) {
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('保险库主密码格式无效。');
  return sodium.crypto_pwhash(32, password, salt, 3, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
}

function isVault(value) { return value?.format === format; }

function validateEnvelope(envelope, scope) {
  if (!isVault(envelope) || envelope.version !== 1 || !scopes.includes(envelope.scope) || (scope && envelope.scope !== scope)
    || typeof envelope.header?.id !== 'string' || !/^[\da-f-]{36}$/.test(envelope.header.id)) throw new Error('保险库格式或版本无效。');
  decode(envelope.header.salt, 16);
  for (const box of [envelope.header.password, envelope.header.recovery, envelope.payload]) {
    decode(box?.nonce, 24);
    if (typeof box.ciphertext !== 'string' || box.ciphertext.length > maxDocumentSize) throw new Error('保险库数据大小无效。');
  }
  return envelope;
}

function recoveryCode() { return encode(randomBytes(32)); }

async function createVault(password, recovery) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('主密码至少需要 12 个字符。');
  await sodium.ready;
  const id = randomUUID();
  const salt = randomBytes(16);
  const recoveryKey = decode(recovery, 32);
  let derived;
  let key;
  try {
    derived = passwordKey(password, salt);
    key = randomBytes(32);
    const header = { id, salt: encode(salt), password: seal(derived, key, wrapContext(id, 'password')), recovery: seal(recoveryKey, key, wrapContext(id, 'recovery')) };
    return { key, header };
  } catch (error) {
    key?.fill(0);
    throw error;
  } finally {
    recoveryKey.fill(0);
    derived?.fill(0);
  }
}

function encodeVault(key, header, scope, value) {
  const data = JSON.stringify(value);
  const bytes = Buffer.byteLength(data);
  if (bytes > 5 * 1024 * 1024) throw new Error('保险库数据超过大小上限。');
  return { format, version: 1, scope, header, payload: seal(key, data, dataContext(header, scope)) };
}

function decodeVault(key, envelope, scope) {
  validateEnvelope(envelope, scope);
  const decrypted = open(key, envelope.payload, dataContext(envelope.header, envelope.scope));
  try { return JSON.parse(Buffer.from(decrypted).toString('utf8')); }
  finally { decrypted.fill(0); }
}

async function unlockVault(envelope, secret, useRecovery = false) {
  validateEnvelope(envelope);
  await sodium.ready;
  const { header } = envelope;
  const slot = useRecovery ? 'recovery' : 'password';
  let wrappingKey;
  let key;
  try {
    wrappingKey = useRecovery ? decode(secret?.trim(), 32) : passwordKey(secret, decode(header.salt, 16));
    key = open(wrappingKey, header[slot], wrapContext(header.id, slot));
    const data = decodeVault(key, envelope);
    return { key, data };
  } catch {
    key?.fill(0);
    throw new Error('无法解锁保险库，请核对密码或恢复密钥。');
  } finally { wrappingKey?.fill(0); }
}

module.exports = { isVault, validateEnvelope, recoveryCode, createVault, encodeVault, decodeVault, unlockVault, maxDocumentSize };
