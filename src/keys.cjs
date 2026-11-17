const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash, createPrivateKey } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { createConnection } = require('node:net');
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

async function generateKey(directory, name, passphrase, type = 'ed25519', bits) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$/u.test(name) || name.endsWith('.pub')) throw new Error('请输入有效的密钥文件名。');
  if (typeof passphrase !== 'string' || /[\x00\r\n]/.test(passphrase) || passphrase.length > 1024) throw new Error('私钥口令格式无效。');
  const keyFile = path.join(directory, name);
  const options = { comment: name };
  if (type === 'rsa' && (bits === undefined || [2048, 3072, 4096].includes(bits))) options.bits = bits ?? 3072;
  else if (type === 'ecdsa' && (bits === undefined || [256, 384, 521].includes(bits))) options.bits = bits ?? 256;
  else if (type !== 'ed25519' || bits !== undefined) throw new Error('密钥类型或位数无效。');
  if (passphrase) Object.assign(options, { passphrase, cipher: 'aes256-ctr' });
  const pair = await generatePair(type, options);
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

async function addAgentKey(socket, file, passphrase) {
  if (!socket) throw new Error('找不到本机 SSH Agent，请先启动 Agent。');
  if (typeof passphrase !== 'string' || passphrase.length > 1024 || /[\x00\r\n]/.test(passphrase)) throw new Error('私钥口令格式无效。');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data, packet, jwk;
  const sensitive = [];
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('私钥文件无效。');
    data = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(data);
    const parsed = utils.parseKey(data.subarray(0, bytesRead), passphrase || undefined);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key instanceof Error || !key?.isPrivateKey()) throw new Error('无法读取或解锁私钥，请检查文件与口令。');
    jwk = createPrivateKey(key.getPrivatePEM()).export({ format: 'jwk' });
    // SSH_AGENTC_ADD_IDENTITY, using the standard SSH string/mpint encodings.
    const string = value => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const out = Buffer.alloc(4 + bytes.length); out.writeUInt32BE(bytes.length); bytes.copy(out, 4);
      sensitive.push(bytes, out); return out;
    };
    const number = value => {
      let bytes = Buffer.from(value, 'base64url'); sensitive.push(bytes);
      while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
      if (bytes[0] & 0x80) { bytes = Buffer.concat([Buffer.from([0]), bytes]); sensitive.push(bytes); }
      return string(bytes);
    };
    const fields = [Buffer.from([17]), string(key.type)];
    if (jwk.kty === 'RSA') fields.push(...['n', 'e', 'd', 'qi', 'p', 'q'].map(field => number(jwk[field])));
    else if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
      const publicKey = Buffer.from(jwk.x, 'base64url'), seed = Buffer.from(jwk.d, 'base64url');
      sensitive.push(publicKey, seed);
      fields.push(string(publicKey), string(Buffer.concat([seed, publicKey])));
    } else if (jwk.kty === 'EC') {
      const curve = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[jwk.crv];
      if (!curve) throw new Error('此私钥类型暂不支持加入 Agent。');
      fields.push(string(curve), string(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), number(jwk.d));
    } else throw new Error('此私钥类型暂不支持加入 Agent。');
    fields.push(string(key.comment || path.basename(file)));
    const payload = Buffer.concat(fields); sensitive.push(payload);
    packet = string(payload);
    await new Promise((resolve, reject) => {
      const stream = createConnection(socket), reply = Buffer.alloc(5);
      let received = 0, settled = false;
      const finish = failure => {
        if (settled) return; settled = true; clearTimeout(timer); stream.destroy();
        if (failure) reject(new Error(failure)); else resolve();
      };
      const timer = setTimeout(() => finish('SSH Agent 加载密钥超时。'), 5000);
      stream.once('connect', () => stream.write(packet));
      stream.once('error', () => finish('无法连接本机 SSH Agent。'));
      stream.once('close', () => finish('SSH Agent 连接已关闭。'));
      stream.on('data', chunk => {
        received += chunk.copy(reply, received, 0, reply.length - received);
        if (received === reply.length) finish(reply.readUInt32BE(0) === 1 && reply[4] === 6 ? undefined : 'SSH Agent 拒绝加载密钥，请检查 Agent 状态或解锁后重试。');
      });
    });
    return { fingerprint: keyInfo(key, file).fingerprint };
  } finally {
    data?.fill(0); packet?.fill(0); sensitive.forEach(buffer => buffer.fill(0));
    if (jwk) for (const field of Object.keys(jwk)) jwk[field] = '';
    await handle.close();
  }
}

async function createKey(directory, name, privateText, publicText = '', passphrase = '') {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$/u.test(name) || name.endsWith('.pub')) throw new Error('请输入有效的密钥文件名。');
  if (typeof privateText !== 'string' || Buffer.byteLength(privateText) > 256 * 1024 || privateText.includes('\0') || typeof publicText !== 'string' || publicText.length > 32768 || typeof passphrase !== 'string' || passphrase.length > 4096) throw new Error('密钥内容或口令格式无效。');
  const data = Buffer.from(privateText.trim().replace(/\r\n/g, '\n') + '\n');
  const handles = [];
  let complete = false;
  try {
    const parsed = utils.parseKey(data, passphrase || undefined);
    const key = Array.isArray(parsed) ? parsed.length === 1 && parsed[0] : parsed;
    if (!key || key instanceof Error || !key.isPrivateKey()) throw new Error('无法读取私钥，请检查内容；加密私钥需要填写正确口令。');
    const file = path.join(directory, name), info = keyInfo(key, file);
    if (publicText.trim()) {
      const publicKey = utils.parseKey(publicText.trim());
      if (publicKey instanceof Error || Array.isArray(publicKey) || publicKey.isPrivateKey()) throw new Error('公钥格式无效，请填写 OpenSSH 公钥。');
      if (!publicKey.getPublicSSH().equals(key.getPublicSSH())) throw new Error('公钥与私钥不匹配。');
    }
    for (const [target, mode] of [[file, 0o600], [file+'.pub', 0o644]]) handles.push({ file: target, handle: await fs.open(target, 'wx', mode) });
    await handles[0].handle.writeFile(data);await handles[1].handle.writeFile(info.publicKey+'\n');
    for (const entry of handles) await entry.handle.sync();
    complete = true;
    return { ...info, encrypted: Boolean((await inspect(file))?.encrypted) };
  } catch (failure) {
    if (failure.code === 'EEXIST') throw new Error('已有同名私钥或公钥，请换一个名称。');
    throw failure;
  } finally {
    data.fill(0);
    for (const entry of handles) await entry.handle.close();
    if (!complete) for (const entry of handles) await fs.unlink(entry.file);
  }
}

module.exports = { scanKeys, generateKey, agentKeys, addAgentKey, createKey };
