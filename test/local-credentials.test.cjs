const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const credentials = require('../src/local-credentials.cjs');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('portable credentials persist encrypted and bind endpoint and profile', (t) => {
  const dir = profile(t);
  const record = credentials.encrypt(dir, 'host/fingerprint', 'secret 测试');
  assert(!record.includes('secret'));
  assert.equal(credentials.decrypt(dir, 'host/fingerprint', record), 'secret 测试');
  assert.notEqual(credentials.encrypt(dir, 'host/fingerprint', 'secret 测试'), record);
  assert.throws(() => credentials.decrypt(dir, 'another endpoint', record));
  const other = profile(t);
  fs.copyFileSync(path.join(dir, 'credentials.key'), path.join(other, 'credentials.key'));
  assert.throws(() => credentials.decrypt(other, 'host/fingerprint', record));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'credentials.key')).mode & 0o077, 0);
});

test('damaged credentials and missing keys fail without replacing stored data', (t) => {
  const dir = profile(t);
  const record = credentials.encrypt(dir, 'target', 'password');
  const [prefix, encoded] = record.split(':');
  const damaged = Buffer.from(encoded, 'base64');
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => credentials.decrypt(dir, 'target', prefix + ':' + damaged.toString('base64')));
  const file = path.join(dir, 'credentials.key');
  const key = fs.readFileSync(file);
  fs.rmSync(file);
  assert.throws(() => credentials.decrypt(dir, 'target', record));
  assert(!fs.existsSync(file));
  fs.writeFileSync(file, Buffer.alloc(32));
  assert.throws(() => credentials.decrypt(dir, 'target', record));
  fs.writeFileSync(file, Buffer.alloc(1));
  assert.throws(() => credentials.encrypt(dir, 'target', 'new secret'));
  assert.equal(fs.statSync(file).size, 1);
  fs.writeFileSync(file, key);
  assert.equal(credentials.decrypt(dir, 'target', record), 'password');
});

test('legacy OS-encrypted records require reentry and never create a key', (t) => {
  const dir = profile(t);
  assert.throws(() => credentials.decrypt(dir, 'target', Buffer.from('old OS record').toString('base64')));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('runtime sources contain no OS password-store access, including migration', () => {
  for (const dir of ['src', 'src-tauri/src']) {
    for (const file of fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true })) {
      if (!/\.(?:rs|swift|cjs)$/.test(file)) continue;
      const source = fs.readFileSync(path.join(__dirname, '..', dir, file), 'utf8');
      assert.doesNotMatch(source, /safeStorage|generic_password|SecItem(?:CopyMatching|Add|Update|Delete)|credential_helper|legacy_startup_key_read/, file);
    }
  }
  for (const file of ['src/git-vault.cjs', 'src-tauri/src/platform.rs']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /UseKeychain=no -o AddKeysToAgent=no/);
  }
});
