const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { generateKey, scanKeys, agentKeys, addAgentKey, createKey } = require('../src/keys.cjs');
const { branchName, mergeSnapshots, remoteURL, resolveAuth, useRepository } = require('../src/git-vault.cjs');
const { importSSHConfig } = require('../src/ssh-config.cjs');
const { createVault, decodeVault, encodeVault, gitKey, openGitEnvelope, protectGitEnvelope, recoveryCode, unlockVault } = require('../src/vault.cjs');

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

test('key generation supports RSA sizes and ECDSA curves and rejects incompatible sizes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-key-types-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [type, bits, prefix] of [['rsa', 3072, 'ssh-rsa'], ['ecdsa', 256, 'ecdsa-sha2-nistp256'], ['ecdsa', 384, 'ecdsa-sha2-nistp384'], ['ecdsa', 521, 'ecdsa-sha2-nistp521']]) {
    const key = await generateKey(directory, `${type}-${bits}`, '', type, bits);
    assert.equal(key.type, prefix);
    assert.match(key.publicKey, new RegExp(`^${prefix} `));
    assert.equal((await scanKeys(directory)).find(k => k.path === key.path).fingerprint, key.fingerprint);
    if (type === 'rsa') {
      const blob = Buffer.from(key.publicKey.split(' ')[1], 'base64');
      let offset = 0;
      for (let field = 0; field < 2; field++) offset += 4 + blob.readUInt32BE(offset);
      assert.equal(blob.readUInt32BE(offset), bits / 8 + 1);
    }
  }
  for (const [type, bits] of [['dsa', 1024], ['rsa', 1024], ['rsa', 8192], ['ecdsa', 3072], ['ed25519', 256]]) {
    await assert.rejects(generateKey(directory, 'invalid', '', type, bits), /类型或位数无效/);
  }
  assert.equal((await fs.readdir(directory)).includes('invalid'), false);
});

test('encrypted private keys can be loaded into an isolated Agent without saving the passphrase', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-key-agent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socket = path.join(directory, 'agent.sock');
  const agent = execFileSync('/usr/bin/ssh-agent', ['-s', '-a', socket], { encoding: 'utf8' });
  const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent)[1]);
  t.after(() => { try { process.kill(pid); } catch {} });
  const key = await generateKey(directory, 'fixture', 'disposable passphrase');
  const before = await fs.readFile(key.path);
  await assert.rejects(addAgentKey(socket, key.path, 'incorrect'), /解锁私钥/);
  assert.equal((await agentKeys(socket)).keys.length, 0);
  assert.equal((await addAgentKey(socket, key.path, 'disposable passphrase')).fingerprint, key.fingerprint);
  assert.equal((await agentKeys(socket)).keys[0].fingerprint, key.fingerprint);
  assert.deepEqual(await fs.readFile(key.path), before);
  for (const [type, bits] of [['rsa', 2048], ['ecdsa', 521]]) {
    const other = await generateKey(directory, type, '', type, bits);
    await addAgentKey(socket, other.path, '');
    assert((await agentKeys(socket)).keys.some(identity => identity.fingerprint === other.fingerprint));
  }
  await assert.rejects(addAgentKey(socket, `${key.path}.pub`, ''), /私钥/);
  await assert.rejects(addAgentKey(undefined, key.path, ''), /启动 Agent/);
});

test('private key creation validates pairs, preserves encrypted bytes and never replaces existing files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-create-key-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = await generateKey(directory, 'source', 'fixture passphrase');
  const privateKey = await fs.readFile(source.path, 'utf8');
  const saved = await createKey(directory, 'created', privateKey, source.publicKey, 'fixture passphrase');
  assert.equal(saved.fingerprint, source.fingerprint);assert.equal(saved.encrypted, true);
  assert.equal(await fs.readFile(saved.path, 'utf8'), privateKey);
  assert.equal((await createKey(directory, 'derived', privateKey, '', 'fixture passphrase')).fingerprint, source.fingerprint);
  await assert.rejects(createKey(directory, 'created', privateKey, '', 'fixture passphrase'), /同名/);
  const other = await generateKey(directory, 'other', '');
  await assert.rejects(createKey(directory, 'bad', privateKey, other.publicKey, 'fixture passphrase'), /不匹配/);
  await assert.rejects(createKey(directory, 'bad', privateKey, '', 'wrong'), /口令/);
  await assert.rejects(createKey(directory, '../escape', privateKey), /文件名/);
  await assert.rejects(createKey(directory, 'bad', 'not a key'), /私钥/);
  await fs.writeFile(path.join(directory, 'conflict.pub'), 'preserved');
  await assert.rejects(createKey(directory, 'conflict', privateKey, '', 'fixture passphrase'), /同名/);
  assert.equal(await fs.readFile(path.join(directory, 'conflict.pub'), 'utf8'), 'preserved');
  await assert.rejects(fs.stat(path.join(directory, 'conflict')), {code:'ENOENT'});
});

test('portable vaults reject invalid credentials and altered ciphertext', async () => {
  const recovery = recoveryCode();
  const password = 'vault123';
  await assert.rejects(createVault('vault12', recovery), /至少需要 8 个字符/);
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

test('a custom Git branch keeps the password envelope behind a separate key', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-sync-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--bare', '--quiet', directory]);
  const password = 'fixture password for Git';
  const { key, header } = await createVault(password, recoveryCode());
  const syncKey = gitKey(recoveryCode());
  const wrongKey = gitKey(recoveryCode());
  t.after(() => { key.fill(0); syncKey.fill(0); wrongKey.fill(0); });
  const data = { hosts: [{ address: 'private.example.test', password: 'server password' }], parentCommit: null };
  const legacy = encodeVault(key, header, 'portable', data);
  assert.deepEqual(openGitEnvelope(legacy), legacy);

  const branch = branchName('vault/personal');
  const commit = await useRepository(directory, branch, undefined, ({ push }) =>
    push(protectGitEnvelope(legacy, syncKey)));
  const tip = await useRepository(directory, branch, undefined, ({ fetch }) => fetch());
  assert.equal(tip.commit, commit);
  assert.equal(tip.envelope.header, undefined);
  assert.doesNotMatch(JSON.stringify(tip.envelope), /private\.example\.test|server password/);
  assert.throws(() => openGitEnvelope(tip.envelope), /同步密钥/);
  assert.throws(() => openGitEnvelope(tip.envelope, wrongKey), /同步密钥/);
  const inner = openGitEnvelope(tip.envelope, syncKey);
  await assert.rejects(unlockVault(inner, 'wrong password'), /无法解锁/);
  const restored = await unlockVault(inner, password);
  assert.deepEqual(restored.data, data);
  restored.key.fill(0);

  await useRepository(directory, branch, undefined, async ({ createCommit, pushCommit }) => {
    const candidate = await createCommit(protectGitEnvelope(legacy, syncKey));
    await assert.rejects(pushCommit(candidate, true));
  });
  assert.equal(execFileSync('/usr/bin/git', ['--git-dir', directory, 'rev-list', '--parents', `refs/heads/${branch}`], {
    encoding: 'utf8'
  }).trim(), commit);

  const empty = await useRepository(directory, branchName(), undefined, ({ fetch }) => fetch());
  assert.equal(empty, null);
  assert.throws(() => branchName('@{-1}'), /分支名称/);
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
  assert.throws(() => remoteURL('ext::sh -c unwanted'), /仓库地址/);
});

test('HTTPS Git accepts separate credentials and rejects embedded tokens and insecure URLs', () => {
  const remote = remoteURL('https://git.example.test/team/vault.git');
  assert.equal(remote, 'https://git.example.test/team/vault.git');
  assert.deepEqual(resolveAuth(remote, { username: 'fixture', token: ' token ' }), { username: 'fixture', token: 'token' });
  assert.throws(() => resolveAuth(remote), /Token/);
  assert.throws(() => remoteURL('https://fixture:secret@git.example.test/team/vault.git'), /仓库地址/);
  assert.throws(() => remoteURL('http://git.example.test/team/vault.git'), /仓库地址/);
});

test('OpenSSH import flags routes that cannot be replayed and excludes negated aliases', () => {
  const config = 'Host server\n HostName 192.0.2.5\n User ops\n Port 2222\nHost tunnel\n User ops\n ProxyJump gateway\nHost excluded !excluded\n User ops\n';
  const { rows, warnings } = importSSHConfig(config, '/tmp');
  assert.deepEqual(rows.map(({ name, issue }) => [name, issue]), [['server', ''], ['tunnel', '需要跳板机或代理']]);
  assert.equal(rows[0].port, 2222);
  assert.equal(warnings.length, 1);
});
