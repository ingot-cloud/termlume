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


test('edge moves create three panes, preserve existing ratios and never duplicate a session', () => {
  const pair = state.presetTree(['a', 'b'], 'horizontal', 60);
  const snapshot = structuredClone(pair);
  const three = state.movePane(pair, 'c', 'b', 'bottom');
  assert.equal(three.ratio, 60);
  assert.equal(three.second.axis, 'row');
  assert.deepEqual(state.paneIds(three), ['a', 'b', 'c']);
  assert.deepEqual(pair, snapshot);
  const moved = state.movePane(three, 'a', 'c', 'right');
  assert.deepEqual(state.paneIds(moved), ['b', 'c', 'a']);
  assert.equal(new Set(state.paneIds(moved)).size, 3);
  assert.equal(state.movePane(three, 'a', 'a', 'left'), three);
  assert.equal(state.movePane(three, 'a', 'missing', 'left'), three);
});

test('drop feedback stays within the hovered pane when moving a nested member', () => {
  const bounds = { x: 322, y: 92, width: 313, height: 162 };
  for (const edge of ['left','right','top','bottom']) {
    const rect = state.dropPreviewRect(bounds, edge);
    assert(rect.x >= bounds.x && rect.y >= bounds.y);
    assert(rect.x + rect.width <= bounds.x + bounds.width);
    assert(rect.y + rect.height <= bounds.y + bounds.height);
  }
  assert.deepEqual(state.dropPreviewRect(bounds, 'right'), { x: 483, y: 92, width: 152, height: 162 });
});

test('pane counts grow with the tree and removing panes collapses only their branch', () => {
  const grid = state.presetTree(['a', 'b', 'c', 'd'], 'grid', 60, 55);
  assert.equal(state.paneIds(state.movePane(grid, 'e', 'b', 'left')).length, 5);
  const moved = state.movePane(grid, 'a', 'b', 'top');
  assert.equal(state.paneIds(moved).length, 4);
  assert.deepEqual(new Set(state.paneIds(moved)), new Set(['a', 'b', 'c', 'd']));
  const three = state.removePane(grid, 'a');
  assert.equal(three.first.id, 'c');
  assert.deepEqual(three.second, grid.second);
  assert.equal(three.ratio, 60);
  assert.deepEqual(state.removePane(state.presetTree(['a', 'b'], 'vertical'), 'a'), state.pane('b'));
});

test('legacy grids retain their visual positions and both dimensions', () => {
  const tree = state.layoutTree({ split: [0, 1, 2, 3], direction: 'grid', ratio: 60, rowRatio: 55 }, ['a', 'b', 'c', 'd']);
  const { panes, splits } = state.treeRects(tree, { x: 10, y: 20, width: 1009, height: 609 });
  assert.deepEqual(panes.get('a'), { x: 10, y: 20, width: 600, height: 330 });
  assert.deepEqual(panes.get('b'), { x: 619, y: 20, width: 400, height: 330 });
  assert.equal(panes.get('c').y, 359);
  assert.equal(panes.get('d').y, 359);
  assert.equal(splits.length, 3);
  const tiny = state.treeRects(tree, { x: 0, y: 0, width: 8, height: 8 });
  assert([...tiny.panes.values()].every(rect => rect.width >= 0 && rect.height >= 0));
});

test('edge hit testing leaves the center untouched and handles corners deterministically', () => {
  const rect = { x: 100, y: 100, width: 400, height: 300 };
  assert.equal(state.dropEdge(rect, 102, 250), 'left');
  assert.equal(state.dropEdge(rect, 498, 250), 'right');
  assert.equal(state.dropEdge(rect, 300, 102), 'top');
  assert.equal(state.dropEdge(rect, 300, 398), 'bottom');
  assert.equal(state.dropEdge(rect, 300, 250), undefined);
  assert.equal(state.dropEdge(rect, 99, 250), undefined);
  assert.equal(state.dropEdge(rect, 100, 100), 'left');
});

test('tree layouts round pointer ratios and restore indices to fresh session ids', () => {
  const tree = state.movePane(state.presetTree(['a', 'b'], 'horizontal', 61.25), 'c', 'b', 'bottom');
  const split = { version: 2, root: state.serializeTree(tree, ['a', 'b', 'c']) };
  assert.equal(split.root.ratio, 61);
  const restored = state.layoutTree({ split }, ['new-a', 'new-b', 'new-c']);
  assert.deepEqual(state.paneIds(restored), ['new-a', 'new-b', 'new-c']);
  for (const invalid of [
    { ...split, version: 3 },
    { ...split, root: { ...split.root, ratio: 90 } },
    { ...split, root: { ...split.root, first: { type: 'pane', index: 2 } } },
    { ...split, root: { type: 'pane', index: 10 } }
  ]) assert.throws(() => state.layoutTree({ split: invalid }, ['a', 'b', 'c']));
});


test('a vertical workspace accepts a third pane on the upper right without changing the lower pane', () => {
  const vertical = state.presetTree(['upper', 'lower'], 'vertical', 60);
  const nested = state.movePane(vertical, 'third', 'upper', 'right');
  assert.equal(nested.axis, 'row');
  assert.equal(nested.ratio, 60);
  assert.equal(nested.first.axis, 'column');
  assert.deepEqual(state.paneIds(nested.first), ['upper', 'third']);
  assert.equal(nested.second.id, 'lower');
  assert.equal(state.dropEdge({x:0,y:0,width:1140,height:300}, 900, 150), 'right');
  assert.deepEqual(state.minimumSize(nested), {width:369,height:209});
});

test('workspace tabs collapse members once, preserve separate groups and expose detached panes', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const groups = [{id:'one',panes:['a','c']},{id:'two',panes:['b','d']}];
  assert.deepEqual(state.workspaceTabs(ids, groups).map(entry => [entry.key, entry.representativeId]), [['one','a'],['two','b'],['e','e']]);
  assert.deepEqual(state.workspaceTabs(ids, [{id:'one',panes:['a']}]).map(entry => entry.key), ids);
  assert.deepEqual(state.workspaceTabs(['c','b','a'], [groups[0]]).map(entry => entry.key), ['one','b']);
});

test('a complete workspace can be inserted as a subtree while keeping both source ratios', () => {
  const destination = state.presetTree(['a','b'], 'vertical', 60);
  const source = state.presetTree(['c','d'], 'vertical', 45);
  const merged = state.moveTree(destination, source, 'a', 'right');
  assert.deepEqual(state.paneIds(merged), ['a','c','d','b']);
  assert.equal(merged.ratio, 60);
  assert.equal(merged.first.second.ratio, 45);
  assert.equal(state.paneIds(state.moveTree(merged, state.pane('e'), 'a', 'left')).length, 5);
});


test('large and deeply nested saved trees round trip without pane or depth count limits', () => {
  const ids = Array.from({length:32}, (_, index) => `pane-${index}`);
  const balanced = entries => entries.length===1 ? state.pane(entries[0]) : {
    type:'split',axis:'column',ratio:50,first:balanced(entries.slice(0,entries.length/2)),second:balanced(entries.slice(entries.length/2))
  };
  for(const tree of [balanced(ids), ids.slice(1,12).reduce((tree,id)=>state.movePane(tree,id,state.paneIds(tree).at(-1),'bottom'),state.pane(ids[0]))]) {
    const members=state.paneIds(tree);
    const restored=state.layoutTree({split:{version:2,root:state.serializeTree(tree,members)}},members);
    assert.deepEqual(state.paneIds(restored),members);
  }
});
