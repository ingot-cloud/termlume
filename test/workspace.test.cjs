const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateKey, scanKeys } = require('../src/keys.cjs');
const { mergeSnapshots, remoteURL } = require('../src/git-vault.cjs');
const { importSSHConfig } = require('../src/ssh-config.cjs');
const { createVault, decodeVault, encodeVault, recoveryCode, unlockVault } = require('../src/vault.cjs');

test('encrypted OpenSSH keys can be found and existing files survive generation conflicts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-keys-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const created = await generateKey(directory, 'fixture', 'test key passphrase');
  const privateFile = await fs.readFile(created.path);
  assert.equal((await fs.stat(created.path)).mode & 0o777, 0o600);
  assert.match(privateFile.toString('utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  await assert.rejects(generateKey(directory, 'fixture', ''), /同名/);
  assert.deepEqual(await fs.readFile(created.path), privateFile);
  assert.equal((await scanKeys(directory)).length, 1);
  await fs.unlink(`${created.path}.pub`);
  const [key] = await scanKeys(directory);
  assert.equal(key.fingerprint, created.fingerprint);
  assert.equal(key.encrypted, true);
  assert.match(key.publicKey, /^ssh-ed25519 /);
  assert.equal('privateKey' in key, false);
});

test('portable vaults reject invalid credentials and altered ciphertext', async () => {
  const recovery = recoveryCode();
  const password = 'temporary vault test password';
  const { key, header } = await createVault(password, recovery);
  const data = { hosts: [{ name: 'private name', password: 'private password' }] };
  try {
    const backup = encodeVault(key, header, 'portable', data);
    assert.doesNotMatch(JSON.stringify(backup), /private name|private password/);
    for (const [secret, mode] of [[password, false], [recovery, true]]) {
      const restored = await unlockVault(backup, secret, mode);
      assert.deepEqual(restored.data, data);
      restored.key.fill(0);
    }
    await assert.rejects(unlockVault(backup, 'wrong'), /无法解锁/);
    const box = backup.payload;
    const tampered = { ...backup, payload: { ...box, ciphertext: (box.ciphertext[0] === 'A' ? 'B' : 'A') + box.ciphertext.slice(1) } };
    await assert.rejects(unlockVault(tampered, recovery, true), /无法解锁/);
    assert.throws(() => decodeVault(key, { ...backup, scope: 'local' }, 'local'));
  } finally { key.fill(0); }
});

test('three-way merge keeps independent changes and explicitly resolves delete versus edit', () => {
  const a = { id: 'a', name: 'A' };
  const b = { id: 'b', name: 'B' };
  const editedA = { ...a, name: 'Edited A' };
  const editedB = { ...b, name: 'Edited B' };
  const base = [a, b];
  assert.deepEqual(mergeSnapshots(base, [editedA, b], [a, editedB]).records, [editedA, editedB]);
  const conflict = mergeSnapshots(base, [b], [editedA, b]);
  assert.deepEqual(conflict.conflicts, [{ id: a.id, local: undefined, remote: editedA }]);
  assert.deepEqual(mergeSnapshots(base, [b], [editedA, b], { a: 'local' }).records, [b]);
  assert.deepEqual(mergeSnapshots(base, [b], [editedA, b], { a: 'remote' }).records, [editedA, b]);
  assert.throws(() => remoteURL('ext::sh -c unwanted'), /SSH 地址/);
});

test('OpenSSH import flags routes that cannot be replayed and excludes negated aliases', () => {
  const config = 'Host server\n HostName 192.0.2.5\n User ops\n Port 2222\nHost tunnel\n User ops\n ProxyJump gateway\nHost excluded !excluded\n User ops\n';
  const { rows, warnings } = importSSHConfig(config, '/tmp');
  assert.deepEqual(rows.map(({ name, issue }) => [name, issue]), [['server', ''], ['tunnel', '需要跳板机或代理']]);
  assert.equal(rows[0].port, 2222);
  assert.equal(warnings.length, 1);
});
