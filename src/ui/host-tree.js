(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.hostTree = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function build(groups, hosts = []) {
    const branches = groups.map(group => ({ group, groups: [], hosts: [], count: 0 }));
    const byId = new Map(branches.map(branch => [branch.group.id, branch]));
    const byPath = new Map(branches.map(branch => [branch.group.path, branch]));
    const tree = { groups: [], hosts: [] };
    for (const branch of branches) {
      let parent = byId.get(branch.group.parentId);
      const seen = new Set([branch.group.id]);
      for (let ancestor = parent; ancestor; ancestor = byId.get(ancestor.group.parentId)) {
        if (seen.has(ancestor.group.id)) { parent = undefined; break; }
        seen.add(ancestor.group.id);
      }
      (parent || tree).groups.push(branch);
    }
    for (const host of hosts) {
      let parent = (host.groupId && byId.get(host.groupId)) || (host.group && byPath.get(host.group));
      // Older workspaces can still supply group paths without group records.
      // Treat the entire path as a name: a slash can be part of a group name.
      if (!parent && host.group) {
        parent = { group: { id: `path:${host.group}`, name: host.group, path: host.group }, groups: [], hosts: [], count: 0 };
        byPath.set(host.group, parent);
        tree.groups.push(parent);
      }
      (parent || tree).hosts.push(host);
    }
    const count = branch => {
      branch.groups.sort((a, b) => a.group.name.localeCompare(b.group.name, 'zh-CN'));
      branch.count = branch.hosts.length + branch.groups.reduce((sum, child) => sum + count(child), 0);
      return branch.count;
    };
    count(tree);
    return tree;
  }

  function filter(tree, hostMatches, groupMatches = () => false) {
    const groups = tree.groups.map(branch => filter(branch, hostMatches, groupMatches))
      .filter(branch => branch.hosts.length || branch.groups.length || groupMatches(branch.group));
    return { ...tree, groups, hosts: tree.hosts.filter(hostMatches) };
  }

  function descendants(groups, id) {
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups) {
        if (ids.has(group.parentId) && !ids.has(group.id)) { ids.add(group.id); changed = true; }
      }
    }
    return ids;
  }
  return { build, filter, descendants };
});
