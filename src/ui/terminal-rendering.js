(function(root, create) {
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.createTerminalRendering = create;
})(typeof window !== 'undefined' ? window : globalThis, (terminal, fit) => {
  const queue = [];
  let writing = false;
  let disposed = false;

  // xterm 6 parses write() asynchronously. A fit between write() and its
  // callback would parse the previous Vim frame using the new row/column count.
  function drain() {
    while (!writing && !disposed && queue.length) {
      const operation = queue.shift();
      if (operation.type === 'fit') {
        fit();
        for (const resolve of operation.done) resolve();
      } else {
        writing = true;
        terminal.write(operation.data, () => {
          writing = false;
          try { operation.done?.(); }
          finally { drain(); }
        });
      }
    }
  }

  return {
    write(data, done) {
      if (disposed) { done?.(); return; }
      queue.push({ type: 'write', data, done });
      drain();
    },
    fit() {
      if (disposed) return Promise.resolve();
      return new Promise(resolve => {
        const previous = queue.at(-1);
        if (previous?.type === 'fit') previous.done.push(resolve);
        else queue.push({ type: 'fit', done: [resolve] });
        drain();
      });
    },
    dispose() {
      disposed = true;
      for (const operation of queue.splice(0)) {
        if (operation.type === 'fit') for (const resolve of operation.done) resolve();
        else operation.done?.();
      }
    }
  };
});
