const test = require('node:test');
const assert = require('node:assert/strict');
const { render, sorted, parameters } = require('../src/ui/command-library.js');
const defaults = require('../src/command-defaults.json');

test('command ordering preserves ties and does not mutate saved records', () => {
  const commands = [{id:'a',order:20},{id:'b',order:0,pinned:true},{id:'c',order:20}];
  assert.deepEqual(sorted(commands).map(s=>s.id), ['b','a','c']);
  assert.deepEqual(commands.map(s=>s.id), ['a','b','c']);
});

test('editable command parameters remain single quoted arguments and are replaced once', () => {
  assert.deepEqual(parameters('tail -n {{lines}} {{path}}; echo {{path}}'), ['lines','path']);
  assert.equal(render('tail -n {{lines}} {{path}}', {lines:12,path:"/tmp/中文 ' {{service}}.log"}), "tail -n 12 '/tmp/中文 '\\'' {{service}}.log'");
  assert.equal(render('journalctl --unit={{service}}', {service:'nginx.service'}), "journalctl --unit='nginx.service'");
  assert.equal(render("docker ps --format '{{.Names}}'"), "docker ps --format '{{.Names}}'");
  for (const lines of [0,10001,1.5,'1; id']) assert.throws(()=>render('{{lines}}',{lines}), /行数/);
  assert.throws(()=>render('{{path}}',{path:'relative'}), /绝对路径/);
  assert.throws(()=>render('{{service}}',{service:'nginx; id'}), /服务名/);
});

test('all built-in command templates can be edited and rendered with host parameters', () => {
  assert.equal(new Set(defaults.map(s=>s.id)).size, 4);
  assert(defaults.some(s=>s.pinned));
  for(const snippet of defaults) {
    assert(!render(snippet.command,{path:'/var/log/测试.log',service:'sshd.service',lines:100}).includes('{{'));
  }
});
