const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { maxGitDocumentSize } = require('./vault.cjs');

const defaultBranch = 'termlume-vault';
const snapshotFile = 'vault.json';

function branchName(value = '') {
  if (typeof value !== 'string') throw new Error('请输入有效的 Git 分支名称。');
  const name = value.trim();
  if (!name) return defaultBranch;
  if (Buffer.byteLength(name) > 240 || name === 'HEAD' || name === '@' || name.startsWith('-')
    || name.startsWith('refs/heads/') || name.endsWith('.') || name.includes('..') || name.includes('@{')
    || /[\x00-\x20\x7f~^:?*[\\]/.test(name)
    || name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('请输入有效的 Git 分支名称，例如 termlume-vault 或 vault/personal。');
  }
  return name;
}

function remoteURL(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('请输入 SSH 或 HTTPS 仓库地址。');
  const remote = value.trim();
  if (/^https:\/\/[^\s\\]+$/i.test(remote)) {
    try {
      const url = new URL(remote);
      if (url.hostname && !url.username && !url.password && !url.search && !url.hash && url.pathname.replaceAll('/', '')) return url.href;
    } catch { /* invalid URL */ }
  }
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(remote)) return remote;
  if (/^ssh:\/\/(?:[\w.-]+@)?(?:[\w.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?\/[\w./~-]+$/i.test(remote)) {
    try { return new URL(remote).href; } catch { /* invalid port */ }
  }
  throw new Error('请输入 SSH 或 HTTPS 仓库地址，地址中请勿包含用户名、密码或 Token。');
}

function resolveAuth(remote, input, saved) {
  if (!remote.startsWith('https://')) return undefined;
  const auth = input ?? saved;
  if (!auth) throw new Error('请输入 HTTPS 仓库的用户名和访问 Token。');
  const username = typeof auth.username === 'string' ? auth.username.trim() : '';
  const token = typeof auth.token === 'string' ? auth.token.trim() : '';
  if (!username || /[:\x00-\x1f\x7f]/.test(username) || Buffer.byteLength(username) > 256
    || !token || /[\s\x00-\x1f\x7f]/.test(token) || Buffer.byteLength(token) > 4096) {
    throw new Error('HTTPS 仓库的用户名或访问 Token 格式无效。');
  }
  return { username, token };
}

function run(directory, signal, args, input, auth) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=12',
    GIT_AUTHOR_NAME: 'Termlume', GIT_COMMITTER_NAME: 'Termlume',
    GIT_AUTHOR_EMAIL: 'vault@termlume.invalid', GIT_COMMITTER_EMAIL: 'vault@termlume.invalid'
  });
  if (auth && ['ls-remote', 'fetch', 'push'].includes(args[0])) {
    const header = Buffer.from(auth.username + ':' + auth.token).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.sslVerify', GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'http.extraHeader', GIT_CONFIG_VALUE_2: 'Authorization: Basic ' + header
    });
  }
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env, signal, timeout: 45_000, maxBuffer: maxGitDocumentSize + 4096
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

async function useRepository(remote, name, signal, operation, auth) {
  const branch = 'refs/heads/' + name;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termlume-git-'));
  const git = (args, input) => run(directory, signal, args, input, auth);
  try {
    await git(['init', '--bare', '--quiet', '--template=']);
    const refs = () => git(['ls-remote', '--refs', '--', remote]);
    const advertisedCommit = (refs) => refs.split('\n').map((line) => line.split('\t')).find(([, name]) => name === branch)?.[0];
    const fetch = async () => {
      let refs;
      try { refs = await git(['ls-remote', '--refs', '--exit-code', '--', remote, branch]); }
      catch (error) { if (error.code === 2) return null; throw error; }
      if (!advertisedCommit(refs)) return null;
      await git(['fetch', '--quiet', '--no-tags', '--', remote, branch]);
      const [commit, parent, extraParent] = (await git(['rev-list', '--parents', '-n', '1', 'FETCH_HEAD'])).trim().split(' ');
      if (extraParent) throw new Error('同步分支含有未经 Termlume 生成的合并提交。');
      const spec = `${commit}:${snapshotFile}`;
      const size = Number((await git(['cat-file', '-s', spec])).trim());
      if (!size || size > maxGitDocumentSize) throw new Error('仓库中的保险库大小无效。');
      return { commit, parent: parent || null, envelope: JSON.parse(await git(['cat-file', 'blob', spec])) };
    };
    const descendant = async (base, tip) => {
      try { await git(['merge-base', '--is-ancestor', base, tip]); return true; }
      catch (error) { if (error.code === 1 || error.code === 128) return false; throw error; }
    };
    const createCommit = async (envelope, parent) => {
      const contents = JSON.stringify(envelope);
      const blob = (await git(['hash-object', '-w', '--stdin'], contents)).trim();
      const tree = (await git(['mktree'], `100644 blob ${blob}\t${snapshotFile}\n`)).trim();
      return (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Update encrypted Termlume vault'])).trim();
    };
    const pushCommit = async (commit, createOnly = false) => {
      const lease = createOnly ? ['--force-with-lease=' + branch + ':'] : [];
      try { await git(['push', '--porcelain', ...lease, '--', remote, `${commit}:${branch}`]); }
      catch (error) {
        if (/non-fast-forward|fetch first|cannot lock ref|stale info/i.test(`${error.detail || ''}\n${error.gitOutput || ''}`)) error.concurrent = true;
        throw error;
      }
    };
    const push = async (envelope, parent) => {
      const commit = await createCommit(envelope, parent);
      await pushCommit(commit);
      return commit;
    };
    return await operation({ fetch, descendant, push, refs, advertisedCommit, createCommit, pushCommit });
  } catch (error) {
    if (signal?.aborted) throw new Error('同步已取消。');
    if (error.detail !== undefined) throw new Error(auth
      ? 'HTTPS Git 操作失败，请检查仓库地址、网络和 Token 权限。'
      : error.detail || 'Git 操作失败，请检查仓库地址及本机 SSH 授权。');
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

module.exports = { branchName, defaultBranch, remoteURL, resolveAuth, useRepository, sameRecord, mergeSnapshots };
