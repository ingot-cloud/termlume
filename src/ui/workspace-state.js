(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.workspaceState = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const pane = id => ({ type: 'pane', id });
  const branch = (axis, first, second, ratio = 50) => ({ type: 'split', axis, ratio, first, second });
  const paneIds = tree => !tree ? [] : tree.type === 'pane' ? [tree.id] : [...paneIds(tree.first), ...paneIds(tree.second)];
  const mapTree = (tree, convert) => tree.type === 'pane' ? convert(tree) : {
    ...tree, first: mapTree(tree.first, convert), second: mapTree(tree.second, convert)
  };
  function presetTree(ids, direction, ratio = 50, rowRatio = 50) {
    const leaves = ids.map(pane);
    if (leaves.length < 2) return leaves[0];
    if (direction !== 'grid') return branch(direction === 'vertical' ? 'row' : 'column', leaves[0], leaves[1], ratio);
    return branch('column', leaves[2] ? branch('row', leaves[0], leaves[2], rowRatio) : leaves[0],
      leaves[3] ? branch('row', leaves[1], leaves[3], rowRatio) : leaves[1], ratio);
  }
  function layoutTree(layout, ids = layout.panes) {
    if (layout.tree) return layout.tree;
    if (layout.split && !Array.isArray(layout.split)) {
      if (layout.split.version !== 2) throw new Error('不支持此会话布局版本，请更新 Termlume。');
      const indices = new Set();
      const read = item => {
        if (!item) throw new Error('分屏结构无效。');
        if (item.type === 'pane' && Number.isInteger(item.index) && item.index >= 0 && item.index < ids.length && !indices.has(item.index)) {
          indices.add(item.index); return pane(ids[item.index]);
        }
        if (item.type === 'split' && ['column', 'row'].includes(item.axis) && Number.isInteger(item.ratio) && item.ratio >= 20 && item.ratio <= 80) {
          return branch(item.axis, read(item.first), read(item.second), item.ratio);
        }
        throw new Error('分屏包含重复或无效的会话。');
      };
      const tree = read(layout.split.root);
      if (indices.size < 2 || indices.size !== ids.length) throw new Error('分屏会话数量无效。');
      return tree;
    }
    const selected = layout.split?.length ? layout.split.map(index => ids[index]) : ids;
    return presetTree(selected, layout.direction, layout.ratio, layout.rowRatio);
  }
  function serializeTree(tree, ids) {
    return tree.type === 'pane' ? { type: 'pane', index: ids.indexOf(tree.id) }
      : { type: 'split', axis: tree.axis, ratio: Math.round(tree.ratio), first: serializeTree(tree.first, ids), second: serializeTree(tree.second, ids) };
  }
  function removePane(tree, id) {
    if (!tree || tree.type === 'pane') return tree?.id === id ? undefined : tree;
    const first = removePane(tree.first, id), second = removePane(tree.second, id);
    return !first ? second : !second ? first : { ...tree, first, second };
  }
  function moveTree(tree, movingTree, target, edge) {
    const moving = paneIds(movingTree);
    if (moving.includes(target) || !paneIds(tree).includes(target) || !['left', 'right', 'top', 'bottom'].includes(edge)) return tree;
    const remaining = moving.reduce((result, id) => removePane(result, id), tree);
    return mapTree(remaining, leaf => {
      if (leaf.id !== target) return { ...leaf };
      const before = edge === 'left' || edge === 'top';
      return branch(edge === 'left' || edge === 'right' ? 'column' : 'row',
        before ? movingTree : { ...leaf }, before ? { ...leaf } : movingTree);
    });
  }
  function movePane(tree, moving, target, edge) { return moveTree(tree, pane(moving), target, edge); }
  function workspaceTabs(ids, groups) {
    const membership = new Map();
    for (const group of groups) {
      const members = group.panes.filter(id => ids.includes(id));
      if (members.length > 1) for (const id of members) membership.set(id, { ...group, panes: members });
    }
    const seen = new Set();
    return ids.flatMap(id => {
      const group = membership.get(id), key = group?.id || id;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, representativeId: id, panes: group?.panes || [id], grouped: Boolean(group) }];
    });
  }
  function minimumSize(tree) {
    if (tree.type === 'pane') return { width: 180, height: 100 };
    const a = minimumSize(tree.first), b = minimumSize(tree.second);
    return tree.axis === 'column' ? { width: a.width + b.width + 9, height: Math.max(a.height, b.height) }
      : { width: Math.max(a.width, b.width), height: a.height + b.height + 9 };
  }
  function treeRects(tree, bounds) {
    const panes = new Map(), splits = [];
    const walk = (item, rect) => {
      if (item.type === 'pane') { panes.set(item.id, rect); return; }
      const column = item.axis === 'column', dimension = column ? 'width' : 'height', coordinate = column ? 'x' : 'y';
      const gap = Math.min(9, rect[dimension]), length = Math.max(0, rect[dimension] - gap);
      const a = minimumSize(item.first)[dimension], b = minimumSize(item.second)[dimension];
      const lower = length >= a + b ? a : 0, upper = length >= a + b ? length - b : length;
      const size = Math.max(lower, Math.min(upper, length * item.ratio / 100));
      const first = { ...rect, [dimension]: size };
      const grip = { ...rect, [coordinate]: rect[coordinate] + size, [dimension]: gap };
      const second = { ...rect, [coordinate]: rect[coordinate] + size + gap, [dimension]: length - size };
      splits.push({ node: item, bounds: rect, grip });
      walk(item.first, first); walk(item.second, second);
    };
    walk(tree, bounds);
    return { panes, splits };
  }
  function dropPreviewRect(rect, edge) {
    const result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const column = edge === 'left' || edge === 'right';
    const dimension = column ? 'width' : 'height', coordinate = column ? 'x' : 'y';
    const gap = Math.min(9, result[dimension]);
    result[dimension] = (result[dimension] - gap) / 2;
    if (edge === 'right' || edge === 'bottom') result[coordinate] += result[dimension] + gap;
    return result;
  }
  function dropEdge(rect, x, y) {
    if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return;
    const horizontal = Math.max(1, rect.width), vertical = Math.max(1, rect.height);
    const nx = (x - rect.x) / horizontal, ny = (y - rect.y) / vertical;
    // Most of the pane is a drop zone; keep a small neutral center for cancellation.
    if (nx > .42 && nx < .58 && ny > .42 && ny < .58) return;
    return [['left', nx], ['right', 1 - nx], ['top', ny], ['bottom', 1 - ny]]
      .sort((a, b) => a[1] - b[1])[0][0];
  }
  return {
    pane, paneIds, mapTree, presetTree, layoutTree, serializeTree, removePane, movePane, moveTree, workspaceTabs, minimumSize, treeRects, dropEdge, dropPreviewRect,

    retryDelay(attempt) { return [1000, 3000, 8000][attempt - 1] ?? null; },
    automaticCredential(auth, saved) { return auth === 'agent' || (auth === 'password' && saved); },
    reorder(ids, moving, before) {
      if (moving === before || !ids.includes(moving) || !ids.includes(before)) return [...ids];
      const out = ids.filter(id => id !== moving);
      out.splice(out.indexOf(before), 0, moving);
      return out;
    },
    filterCommands(entries, query) {
      const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return entries.filter(entry => {
        const text = `${entry.label} ${entry.detail || ''} ${entry.keywords || ''}`.toLocaleLowerCase();
        return words.every(word => text.includes(word));
      });
    },
    pathBreadcrumbs(directory) {
      if (!directory?.startsWith('/')) return [];
      const crumbs = [{name: '/', path: '/'}];
      let path = '';
      for (const name of directory.split('/').filter(Boolean)) {
        path += `/${name}`;
        crumbs.push({name, path});
      }
      return crumbs;
    }
  };
});
