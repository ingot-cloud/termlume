(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.workspaceState = api;
})(typeof window !== 'undefined' ? window : globalThis, () => ({
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
}));
