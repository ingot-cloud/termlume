const assert = require('node:assert/strict');
const test = require('node:test');
const createRendering = require('../src/ui/terminal-rendering.js');

test('a resize cannot overtake an unparsed SSH frame or a following frame', async () => {
  const parsed = [];
  const callbacks = [];
  let rows = 30;
  const rendering = createRendering({
    write(data, done) { callbacks.push(() => { parsed.push([data, rows]); done(); }); }
  }, () => { rows = 28; });
  rendering.write('old Vim frame');
  const fitted = rendering.fit();
  rendering.write('resized Vim frame');
  assert.equal(rows, 30);
  callbacks.shift()();
  await fitted;
  callbacks.shift()();
  assert.deepEqual(parsed, [['old Vim frame', 30], ['resized Vim frame', 28]]);
});

test('closing a terminal releases queued output acknowledgements and pending fits', async () => {
  let finishWrite;
  let acknowledgements = 0;
  let fits = 0;
  const rendering = createRendering({ write(_data, done) { finishWrite = done; } }, () => fits++);
  rendering.write('pending', () => acknowledgements++);
  const fitted = rendering.fit();
  rendering.write('queued', () => acknowledgements++);
  rendering.dispose();
  await fitted;
  finishWrite();
  assert.equal(acknowledgements, 2);
  assert.equal(fits, 0);
});
