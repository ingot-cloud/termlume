const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyArchive, prepare } = require('../scripts/prepare-windows-tools.cjs');

test('Windows tool archives reject changed bytes even when size matches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-tool-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.zip');
  fs.writeFileSync(file, 'original');
  const spec = { archive: 'fixture.zip', size: 8, sha256: crypto.createHash('sha256').update('original').digest('hex') };
  verifyArchive(file, spec);
  fs.writeFileSync(file, 'modified');
  assert.throws(() => verifyArchive(file, spec), /SHA-256/);
});

test('offline preparation does not replace the previous runtime on missing archives', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlume-tool-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'vendor/windows');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'keep.txt'), 'old runtime');
  await assert.rejects(prepare({ cache: path.join(dir, 'empty-cache'), output, offline: true }), /Missing cached runtime/);
  assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'old runtime');
  assert.deepEqual(fs.readdirSync(path.dirname(output)), ['windows']);
});
