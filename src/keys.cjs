const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { OpenSSHAgent, utils } = require('ssh2');

const generatePair = promisify(utils.generateKeyPair);
const ignored = /^(config|known_hosts(?:2|\.old)?|authorized_keys2?)$/;

function keyInfo(key, file) {
  const blob = key.getPublicSSH();
  return {
    name: path.basename(file), path: file, type: key.type, private: key.isPrivateKey(),
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    publicKey: `${key.type} ${blob.toString('base64')}${key.comment ? ` ${key.comment.replace(/[\r\n\x00]/g, ' ')}` : ''}`
  };
}

function publicFromOpenSSH(text) {
  const encoded = /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END OPENSSH PRIVATE KEY-----/.exec(text)?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, 'base64');
  try {
    const magic = 'openssh-key-v1\0';
    if (decoded.toString('ascii', 0, magic.length) !== magic) return undefined;
    let offset = magic.length;
    const take = () => {
      const length = decoded.readUInt32BE(offset);
      offset += 4;
      if (length > decoded.length - offset) throw new Error();
      const field = decoded.subarray(offset, offset + length);
      offset += length;
      return field;
    };
    take(); // cipher
    take(); // KDF
    take(); // KDF options
    if (decoded.readUInt32BE(offset) !== 1) return undefined;
    offset += 4;
    const publicBlob = take();
    const result = utils.parseKey(Buffer.from(publicBlob));
    if (!(result instanceof Error)) return result;
  } catch {
    return undefined;
  } finally {
    decoded.fill(0);
  }
}

async function inspect(file) {
  let handle;
  let data;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    data = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(data);
    const contents = data.subarray(0, bytesRead);
    const result = utils.parseKey(contents);
    const key = Array.isArray(result) ? result[0] : result;
    if (!(key instanceof Error)) return keyInfo(key, file);
    const text = contents.toString('utf8');
    if (/no passphrase given/i.test(key.message)) {
      const publicKey = publicFromOpenSSH(text);
      if (publicKey) return { ...keyInfo(publicKey, file), private: true, encrypted: true };
      return { name: path.basename(file), path: file, private: true, encrypted: true, type: 'SSH' };
    }
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    data?.fill(0);
    await handle?.close();
  }
}

async function scanKeys(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const keys = [];
  for (const entry of entries) {
    if (!entry.isFile() || ignored.test(entry.name) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
    const key = await inspect(path.join(directory, entry.name));
    if (key) keys.push(key);
  }
  const byPath = new Map(keys.map((key) => [key.path, key]));
  return keys.filter((key) => {
    if (key.private || !key.path.endsWith('.pub')) return true;
    const pair = byPath.get(key.path.slice(0, -4));
    return !(pair?.private && pair.fingerprint === key.fingerprint);
  }).sort((a, b) => Number(b.private) - Number(a.private) || a.name.localeCompare(b.name));
}

async function generateKey(directory, name, passphrase) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$/u.test(name) || name.endsWith('.pub')) throw new Error('请输入有效的密钥文件名。');
  if (typeof passphrase !== 'string' || /[\x00\r\n]/.test(passphrase) || passphrase.length > 1024) throw new Error('私钥口令格式无效。');
  const keyFile = path.join(directory, name);
  const options = { comment: name };
  if (passphrase) Object.assign(options, { passphrase, cipher: 'aes256-ctr' });
  const pair = await generatePair('ed25519', options);
  const handles = [];
  let complete = false;
  try {
    for (const [file, mode] of [[keyFile, 0o600], [`${keyFile}.pub`, 0o644]]) {
      handles.push({ file, handle: await fs.open(file, 'wx', mode) });
    }
    await handles[0].handle.writeFile(pair.private.trimEnd() + '\n');
    await handles[1].handle.writeFile(pair.public.trimEnd() + '\n');
    for (const entry of handles) await entry.handle.sync();
    complete = true;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有同名私钥或公钥，请换一个文件名。');
    throw error;
  } finally {
    for (const entry of handles) await entry.handle.close();
    if (!complete) for (const entry of handles) await fs.unlink(entry.file);
  }
  return { ...keyInfo(utils.parseKey(pair.public), keyFile), private: true, encrypted: Boolean(passphrase) };
}

async function agentKeys(socket) {
  if (!socket) return { available: false, keys: [] };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ available: false, keys: [] }), 1500);
    new OpenSSHAgent(socket).getIdentities((error, keys) => {
      clearTimeout(timeout);
      if (error) { resolve({ available: false, keys: [] }); return; }
      resolve({ available: true, keys: keys.map((key, index) => ({ ...keyInfo(key, `Agent 身份 ${index + 1}`), name: key.comment || `Agent 身份 ${index + 1}` })) });
    });
  });
}

module.exports = { scanKeys, generateKey, agentKeys };
