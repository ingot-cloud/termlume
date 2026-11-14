const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const { Client, Server } = require('ssh2');
const { call, terminalLocale, utf8Locale } = require('../src/ssh.cjs');

test('UTF-8 negotiation selects installed locales and preserves existing UTF-8 defaults', () => {
  assert.equal(utf8Locale('ANSI_X3.4-1968\nC\nC.utf8\nen_US.utf8\nPOSIX\n'), 'C.utf8');
  assert.equal(utf8Locale('US-ASCII\nC\nen_US.UTF-8\nzh_CN.UTF-8\n'), 'en_US.UTF-8');
  assert.equal(utf8Locale('US-ASCII\nC\nzh_CN.utf8\n'), 'zh_CN.utf8');
  for (const output of ['UTF-8\nC\nC.utf8\n', 'US-ASCII\nC\nPOSIX\n', 'US-ASCII\n$(bad).utf8\n', '']) {
    assert.equal(utf8Locale(output), undefined);
  }
});

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
for (const rejectEnv of [false, true]) {
  test(`SSH shell still opens when the server ${rejectEnv ? 'rejects' : 'accepts'} the optional locale`, async t => {
    const requested = [];
    const server = new Server({ hostKeys: [hostKey] }, peer => {
      peer.on('error', () => {});
      t.after(() => peer.end());
      peer.on('authentication', ctx => ctx.accept());
      peer.on('ready', () => peer.on('session', accept => {
        const session = accept();
        session.on('exec', (accept, reject, info) => {
          if (info.command !== 'locale charmap; locale -a') { reject(); return; }
          const stream = accept();
          stream.write('ANSI_X3.4-1968\nC\nC.utf8\nPOSIX\n');
          stream.exit(0); stream.end();
        });
        session.on('pty', accept => accept());
        session.on('env', (accept, reject, info) => {
          requested.push([info.key, info.val]);
          if (rejectEnv) reject?.(); else accept?.();
        });
        session.on('shell', accept => {
          const stream = accept(); stream.write('shell ready\n');
        });
      }));
    });
    t.after(() => server.close());
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = new Client(); t.after(() => client.end());
    client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture' });
    await once(client, 'ready');
    const locale = await terminalLocale(client);
    assert.equal(locale, 'C.utf8');
    const shell = await call(client, 'shell', { term: 'xterm-256color' }, { env: { LC_CTYPE: locale } });
    assert.match((await once(shell, 'data'))[0].toString(), /shell ready/);
    assert.deepEqual(requested, [['LC_CTYPE', 'C.utf8']]);
    shell.close();
  });
}
