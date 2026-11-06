const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { commandFor, fileName } = require('../src/ssh.cjs');

test('a log filename with shell metacharacters is passed as one argument', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'termlume-test-'));
  try {
    const argument = path.join(directory, "中文 '; touch injected; #.log");
    writeFileSync(argument, 'selected log\n');
    const command = commandFor({ action: 'tail', argument, lines: 1 });
    assert.equal(execFileSync('/bin/sh', ['-c', command], { cwd: directory, encoding: 'utf8' }), 'selected log\n');
    assert.equal(existsSync(path.join(directory, 'injected')), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('command arguments and remote filenames are bounded', () => {
  assert.throws(() => commandFor({ action: 'journal', argument: 'foo; id' }), /服务名/);
  assert.throws(() => commandFor({ action: 'tail', argument: 'relative.log' }), /绝对路径/);
  assert.throws(() => commandFor({ action: 'follow', argument: '/x', lines: 0 }), /行数/);
  assert.throws(() => fileName('../outside'), /文件名/);
  assert.throws(() => fileName('..'), /文件名/);
});
