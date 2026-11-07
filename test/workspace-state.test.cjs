const test=require('node:test');const assert=require('node:assert/strict');const state=require('../src/ui/workspace-state.js');
test('reconnecting is bounded and requires credentials that can be used without prompting',()=>{assert.deepEqual([1,2,3,4].map(state.retryDelay),[1000,3000,8000,null]);assert.equal(state.automaticCredential('agent',false),true);assert.equal(state.automaticCredential('password',true),true);assert.equal(state.automaticCredential('password',false),false);assert.equal(state.automaticCredential('key',true),false);});
test('tab moves preserve the original ids, do not mutate the source, and ignore missing targets',()=>{const ids=['a','b','c'];assert.deepEqual(state.reorder(ids,'c','a'),['c','a','b']);assert.deepEqual(ids,['a','b','c']);assert.deepEqual(state.reorder(ids,'missing','a'),ids);assert.deepEqual(state.reorder(ids,'a','a'),ids);});

test('palette searches words across names, targets, tags and command content without changing order', () => {
  const entries = [
    {label:'执行 · 检查磁盘', detail:'API 生产', keywords:'df -h disk ops'},
    {label:'粘贴 · 检查磁盘', detail:'API 预发', keywords:'df -h disk ops'},
    {label:'数据库', detail:'ops@db.example.test', keywords:'备份'}
  ];
  assert.deepEqual(state.filterCommands(entries, 'OPS 生产 DF'), [entries[0]]);
  assert.deepEqual(state.filterCommands(entries, 'disk'), entries.slice(0, 2));
  assert.deepEqual(state.filterCommands(entries, 'DB.EXAMPLE'), [entries[2]]);
  assert.deepEqual(state.filterCommands(entries, 'missing'), []);
  assert.deepEqual(state.filterCommands(entries, '  '), entries);
});

test('SFTP breadcrumbs preserve absolute targets including spaces, unicode and shell characters', () => {
  assert.deepEqual(state.pathBreadcrumbs('/'), [{name:'/',path:'/'}]);
  assert.deepEqual(state.pathBreadcrumbs('/var/log/应用 a\'b/'), [
    {name:'/',path:'/'}, {name:'var',path:'/var'}, {name:'log',path:'/var/log'},
    {name:"应用 a'b",path:"/var/log/应用 a'b"}
  ]);
  assert.deepEqual(state.pathBreadcrumbs('relative/path'), []);
  assert.deepEqual(state.pathBreadcrumbs(undefined), []);
});
