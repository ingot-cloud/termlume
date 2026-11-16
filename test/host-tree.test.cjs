const test = require('node:test');
const assert = require('node:assert/strict');
const { build, filter, descendants } = require('../src/ui/host-tree.js');
const { compare, scopes, flatten } = require('../src/ui/host-tree.js');
const groups = [
  {id:'root', name:'生产', path:'生产'},
  {id:'child', name:'应用', path:'生产 / 应用', parentId:'root'},
  {id:'leaf', name:'应用', path:'生产 / 应用 / 应用', parentId:'child'},
  {id:'empty', name:'空组', path:'空组'}
];
const hosts = [
  {id:'root-host', groupId:'root', group:'生产'},
  {id:'leaf-host', groupId:'leaf', group:'生产 / 应用 / 应用'},
  {id:'loose'}
];
test('host hierarchy nests by stable group IDs and leaves ungrouped hosts at the root', () => {
  const snapshot = structuredClone({groups, hosts});
  const tree = build(groups, hosts);
  const root = tree.groups.find(g => g.group.id === 'root');
  assert.deepEqual(tree.hosts.map(h => h.id), ['loose']);
  assert.equal(root.count, 2);
  assert.equal(root.groups[0].groups[0].hosts[0].id, 'leaf-host');
  assert.equal(root.hosts[0].id, 'root-host');
  assert.equal(tree.groups.find(g => g.group.id === 'empty').count, 0);
  assert.deepEqual({groups, hosts}, snapshot);
});
test('search prunes unmatched branches and preserves all ancestors of matching hosts', () => {
  const tree = build(groups, hosts);
  const result = filter(tree, h => h.id === 'leaf-host');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].group.id, 'root');
  assert.deepEqual(result.groups[0].hosts, []);
  assert.equal(result.groups[0].groups[0].groups[0].hosts[0].id, 'leaf-host');
  assert.equal(result.groups[0].count, 2, 'Counts describe the whole group, not only the search result');
  assert.equal(tree.groups.length, 2);
  assert.equal(filter(tree, () => false, g => g.id === 'empty').groups[0].group.id, 'empty');
  assert.equal(filter(tree, () => false).groups.length, 0);
});
test('legacy paths and orphan group records remain visible without splitting slash names', () => {
  const tree = build([{id:'orphan', name:'孤立', path:'孤立', parentId:'missing'}], [
    {id:'a', group:'a / b'}, {id:'b', group:'a / b'}, {id:'c', groupId:'orphan'}
  ]);
  assert.equal(tree.groups.length, 2);
  assert.equal(tree.groups.find(g => g.group.path === 'a / b').hosts.length, 2);
  assert.equal(tree.count, 3);
});
test('invalid cycles cannot recurse forever or hide hosts, and descendant exclusion includes self', () => {
  const cyclic = [{id:'a', name:'a', parentId:'b'}, {id:'b', name:'b', parentId:'a'}, {id:'c', name:'c', parentId:'b'}];
  assert.equal(build(cyclic, [{id:'host', groupId:'c'}]).count, 1);
  assert.deepEqual([...descendants(groups, 'root')], ['root','child','leaf']);
  assert.deepEqual([...descendants(cyclic, 'a')], ['a','b','c']);
});

test('name sorting uses natural numbers, Chinese collation and stable ties in both directions', () => {
  const rows = [{id:'b',name:'server10'}, {id:'c',name:'Server2'}, {id:'a',name:'server2'}, {id:'z',name:'生产'}];
  assert.deepEqual([...rows].sort(compare('name-asc')).map(h=>h.id), ['z','a','c','b']);
  assert.deepEqual([...rows].sort(compare('name-desc')).map(h=>h.id), ['b','a','c','z']);
  assert.deepEqual([...rows].sort(compare('recent',new Map([['b',5]]))).map(h=>h.id), ['b','z','a','c']);
});

test('manual positions are scoped to siblings and survive filtering without mutating records', () => {
  const gs = [{id:'b',name:'B',sortOrder:0}, {id:'a',name:'A',sortOrder:1}, {id:'c',name:'C',parentId:'a',sortOrder:0}];
  const hs = [{id:'h1',name:'host1',groupId:'a',sortOrder:1}, {id:'h2',name:'host2',groupId:'a',sortOrder:0},
    {id:'root',name:'root',sortOrder:0}, {id:'h3',name:'host3',groupId:'c',sortOrder:0}, {id:'new',name:'new',groupId:'a'}];
  const snapshot = structuredClone({gs,hs});
  const tree = build(gs,hs,{groupSort:'manual',hostSort:'manual'});
  assert.deepEqual(tree.groups.map(g=>g.group.id), ['b','a']);
  assert.deepEqual(flatten(tree).map(h=>h.id), ['h3','h2','h1','new','root']);
  assert.deepEqual(scopes(tree,'host').find(s=>s.parentId==='a').ids,['h2','h1','new']);
  assert.deepEqual(scopes(tree,'group').find(s=>s.parentId===null).ids,['b','a']);
  assert.deepEqual(flatten(filter(tree,h=>['h1','h2','root'].includes(h.id))).map(h=>h.id),['h2','h1','root']);
  assert.deepEqual({gs,hs},snapshot);
});
