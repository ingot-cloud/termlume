#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/prepare-macos-tools.cjs
export TERMLUME_TEST_FIXTURE
TERMLUME_TEST_FIXTURE=$(mktemp -d /tmp/termlume-tests.XXXXXX)
fixture=$TERMLUME_TEST_FIXTURE
pids=()
cleanup() {
  if [ -n "${pids[0]:-}" ]; then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/remote" "$fixture/local"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/jump-host"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
ssh-keygen -q -t rsa -b 2048 -N 'fixture key passphrase' -f "$fixture/client-rsa"
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture/https.key" -out "$fixture/https.pem" -days 1 -subj '/CN=127.0.0.1' 2>/dev/null
/usr/bin/openssl x509 -in "$fixture/https.pem" -outform DER -out "$fixture/https.der"
cat "$fixture/client.pub" "$fixture/client-rsa.pub" > "$fixture/authorized_keys"
port=$(node -e '
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
')
printf '%s\n' "$port" > "$fixture/openssh-port"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cut -d ' ' -f 1,2 "$fixture/host.pub")" > "$fixture/known_hosts"
cat > "$fixture/sshd_config" <<CONFIG
ListenAddress 127.0.0.1
Port $port
HostKey $fixture/host
AuthorizedKeysFile $fixture/authorized_keys
StrictModes no
UsePAM no
AcceptEnv LC_CTYPE
SetEnv LANG=C
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $(id -un)
PidFile $fixture/sshd.pid
Subsystem sftp /usr/libexec/sftp-server
CONFIG
/usr/bin/git init --bare --quiet "$fixture/repo.git"
/usr/bin/git init --bare --quiet "$fixture/legacy-migrate.git"
/usr/bin/git init --bare --quiet "$fixture/migrated.git"
printf 'Termlume 日志回归\nsecond line\n' > "$fixture/remote/sample log.txt"
/usr/sbin/sshd -D -e -f "$fixture/sshd_config" > "$fixture/sshd.log" 2>&1 &
pids+=("$!")
export SSH_AUTH_SOCK="$fixture/agent.sock"
/usr/bin/ssh-agent -D -a "$SSH_AUTH_SOCK" > "$fixture/agent.log" 2>&1 &
pids+=("$!")
node - "$fixture" <<'NODE' &
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { connect, createServer: createTcpServer } = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { createServer } = require('node:https');
const { join } = require('node:path');
const { Server } = require('ssh2');
const vault = require('./src/vault.cjs');
const { useRepository } = require('./src/git-vault.cjs');
const fixture = process.argv[2];
(async () => {
  const recovery = Buffer.alloc(32, 17).toString('base64url');
  const { key, header } = await vault.createVault('fixture passphrase 测试', recovery);
  const host = { id: '550e8400-e29b-41d4-a716-446655440000', name: '旧主机',
    address: 'example.com', port: 22, auth: 'password', username: 'fixture' };
  writeFileSync(join(fixture, 'legacy.json'), JSON.stringify(vault.encodeVault(key, header, 'local',
    { hosts: [host], fingerprints: [], localPasswords: { [host.id]: 'Electron safeStorage fixture' } })));
  const legacyRepo = join(fixture, 'legacy-migrate.git');
  const [base, latest] = await useRepository(legacyRepo, 'termlume-vault', undefined, async ({ fetch, push }) => {
    const first = await push(vault.encodeVault(key, header, 'portable', { hosts: [host], parentCommit: null }));
    await fetch();
    const second = await push(vault.encodeVault(key, header, 'portable', {
      hosts: [{ ...host, note: '旧仓库的更新' }], parentCommit: first
    }), first);
    return [first, second];
  });
  execFileSync('/usr/bin/git', ['--git-dir', legacyRepo, 'update-ref', 'refs/heads/termlume-vault', base, latest]);
  writeFileSync(join(fixture, 'legacy-migration-refs.json'), JSON.stringify({ base, latest }));
  await useRepository(legacyRepo, 'legacy/protected', undefined, async ({ push }) => {
    const legacyKey = Buffer.alloc(32, 23);
    await push(vault.protectGitEnvelope(vault.encodeVault(key, header, 'portable', {
      hosts: [host], parentCommit: null
    }), legacyKey));
    legacyKey.fill(0);
  });
  key.fill(0);
  const gitServer = createServer({ key: readFileSync(join(fixture, 'https.key')), cert: readFileSync(join(fixture, 'https.pem')) }, (req, res) => {
    const url = new URL(req.url, 'https://127.0.0.1');
    if (!/^\/(repo|legacy-migrate|migrated)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)) {
      res.writeHead(404).end(); return;
    }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:test-repository-token').toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Termlume fixture"' }).end(); return;
    }
    const child = spawn('/usr/bin/git', ['http-backend'], { env: {
      PATH: '/usr/bin:/bin', GIT_PROJECT_ROOT: fixture, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'fixture',
      REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: req.headers['content-length'] || ''
    }});
    const output = [];
    child.stdout.on('data', (data) => output.push(data));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    req.pipe(child.stdin);
    child.on('close', () => {
      const response = Buffer.concat(output);
      const boundary = response.indexOf('\r\n\r\n');
      if (boundary < 0) { res.writeHead(500).end(); return; }
      for (const line of response.subarray(0, boundary).toString().split('\r\n')) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const [name, value] = [line.slice(0, separator), line.slice(separator + 1).trim()];
        if (name === 'Status') res.statusCode = Number(value.split(' ')[0]);
        else res.setHeader(name, value);
      }
      res.end(response.subarray(boundary + 4));
    });
  });
  gitServer.listen(0, '127.0.0.1', () => writeFileSync(join(fixture, 'https-port'), String(gitServer.address().port)));
  const server = new Server({ hostKeys: [readFileSync(join(fixture, 'host'))] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') appendFileSync(join(fixture, 'password-attempts'), 'attempt\n');
      if (ctx.method === 'password' && ctx.username === 'pilot' && ctx.password === 'pilot-local-only') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (confirm) => confirm());
      session.on('shell', (open) => open().write('test shell\r\n'));
    }));
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(join(fixture, 'password-server.json'), JSON.stringify(server.address())));
  const echo = createTcpServer((socket) => { socket.on('error', () => {}); socket.pipe(socket); });
  echo.listen(0, '127.0.0.1', () => writeFileSync(join(fixture, 'echo-port'), String(echo.address().port)));
  const jumpClients = new Set();
  const jump = new Server({ hostKeys: [readFileSync(join(fixture, 'jump-host'))] }, (client) => {
    jumpClients.add(client);
    client.on('error', () => {});
    client.on('close', () => jumpClients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') appendFileSync(join(fixture, 'jump-password-attempts'), 'attempt\n');
      if (ctx.method === 'password' && ctx.username === 'jump' && ctx.password === 'jump-only-secret') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      appendFileSync(join(fixture, 'jump-forwards'), info.destIP + ':' + info.destPort + '\n');
      const port = info.destIP === 'target.internal.test' ? Number(readFileSync(join(fixture, 'openssh-port'), 'utf8'))
        : info.destIP === 'password.internal.test' ? server.address().port : 0;
      if (!port || port !== info.destPort) { reject(); return; }
      const socket = connect(port, '127.0.0.1', () => {
        const stream = accept();
        if (!stream) { socket.destroy(); return; }
        stream.on('error', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
        stream.on('close', () => socket.destroy());
      });
      socket.on('error', () => reject());
      client.once('close', () => socket.destroy());
    }));
  });
  jump.listen(0, '127.0.0.1', () => writeFileSync(join(fixture, 'jump-server.json'), JSON.stringify(jump.address())));
  setInterval(() => {
    if (existsSync(join(fixture, 'jump-disconnect'))) for (const client of jumpClients) client.end();
  }, 50);
})().catch((err) => { console.error(err); process.exit(1); });
NODE
pids+=("$!")
for attempt in {1..100}; do
  if [ -S "$SSH_AUTH_SOCK" ] && [ -s "$fixture/password-server.json" ] && [ -s "$fixture/jump-server.json" ] && [ -s "$fixture/echo-port" ] && [ -s "$fixture/https-port" ] && /usr/bin/grep -q 'Server listening' "$fixture/sshd.log"; then break; fi
  sleep 0.05
done
/usr/bin/ssh-add "$fixture/client"
/usr/bin/ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$fixture/known_hosts" -p "$port" "$(id -un)@127.0.0.1" true
npm run tauri:assets
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored --test-threads=1
