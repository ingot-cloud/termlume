const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { maxDocumentSize } = require('./vault.cjs');

const branch = 'refs/heads/termlume-vault';
const snapshotFile = 'vault.json';

function remoteURL(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('请输入 Git 仓库 SSH 地址。');
  const remote = value.trim();
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(remote)) return remote;
  if (/^ssh:\/\/(?:[\w.-]+@)?(?:[\w.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?\/[\w./~-]+$/i.test(remote)) {
    try { return new URL(remote).href; } catch { /* invalid port */ }
  }
  throw new Error('请输入 Git 仓库的 SSH 地址，例如 git@github.com:owner/repo.git。');
}

function run(directory, signal, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=12',
    GIT_AUTHOR_NAME: 'Termlume', GIT_COMMITTER_NAME: 'Termlume',
    GIT_AUTHOR_EMAIL: 'vault@termlume.invalid', GIT_COMMITTER_EMAIL: 'vault@termlume.invalid'
  });
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env, signal, timeout: 45_000, maxBuffer: maxDocumentSize + 4096
    }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      error.detail = stderr.trim().slice(0, 1500);
      error.gitOutput = stdout;
      reject(error);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function useRepository(remote, signal, operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-git-'));
  const git = (args, input) => run(directory, signal, args, input);
  try {
    await git(['init', '--bare', '--quiet', '--template=']);
    const fetch = async () => {
      try { await git(['ls-remote', '--refs', '--exit-code', remote, branch]); }
      catch (error) { if (error.code === 2) return null; throw error; }
      await git(['fetch', '--quiet', '--no-tags', '--', remote, branch]);
      const [commit, parent, extraParent] = (await git(['rev-list', '--parents', '-n', '1', 'FETCH_HEAD'])).trim().split(' ');
      if (extraParent) throw new Error('同步分支含有未经 Termlume 生成的合并提交。');
      const spec = `${commit}:${snapshotFile}`;
      const size = Number((await git(['cat-file', '-s', spec])).trim());
      if (!size || size > maxDocumentSize) throw new Error('仓库中的保险库大小无效。');
      return { commit, parent: parent || null, envelope: JSON.parse(await git(['cat-file', 'blob', spec])) };
    };
    const descendant = async (base, tip) => {
      try { await git(['merge-base', '--is-ancestor', base, tip]); return true; }
      catch (error) { if (error.code === 1 || error.code === 128) return false; throw error; }
    };
    const push = async (envelope, parent) => {
      const contents = JSON.stringify(envelope);
      const blob = (await git(['hash-object', '-w', '--stdin'], contents)).trim();
      const tree = (await git(['mktree'], `100644 blob ${blob}\t${snapshotFile}\n`)).trim();
      const commit = (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Update encrypted Termlume vault'])).trim();
      try { await git(['push', '--porcelain', '--', remote, `${commit}:${branch}`]); }
      catch (error) {
        if (/non-fast-forward|fetch first|cannot lock ref|stale info/i.test(`${error.detail || ''}\n${error.gitOutput || ''}`)) error.concurrent = true;
        throw error;
      }
      return commit;
    };
    return await operation({ fetch, descendant, push });
  } catch (error) {
    if (signal?.aborted) throw new Error('同步已取消。');
    if (error.detail !== undefined) throw new Error(error.detail || 'Git 操作失败，请检查仓库地址及本机 SSH 授权。');
    throw error;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function sameRecord(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function mergeSnapshots(base, local, remote, choices = {}) {
  const [original, ours, theirs] = [base, local, remote].map((rows) => new Map(rows.map((row) => [row.id, row])));
  const records = [];
  const conflicts = [];
  for (const id of new Set([...original.keys(), ...ours.keys(), ...theirs.keys()])) {
    const previous = original.get(id);
    const a = ours.get(id);
    const b = theirs.get(id);
    let chosen;
    if (sameRecord(a, b) || sameRecord(b, previous)) chosen = a;
    else if (sameRecord(a, previous)) chosen = b;
    else if (choices[id] === 'local') chosen = a;
    else if (choices[id] === 'remote') chosen = b;
    else conflicts.push({ id, local: a, remote: b });
    if (chosen) records.push(chosen);
  }
  return { records: records.sort((a, b) => a.id.localeCompare(b.id)), conflicts };
}

module.exports = { remoteURL, useRepository, sameRecord, mergeSnapshots };
