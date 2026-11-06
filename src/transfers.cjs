const { randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { call, fileName, remotePath } = require('./ssh.cjs');

async function optionalStat(read, missingCode) {
  try { return await read(); }
  catch (error) { if (error.code !== missingCode) throw error; }
}

function sameTarget(current, original, upload) {
  if (!current?.isFile() || !original?.isFile()) return false;
  return (upload ? ['size', 'mode', 'mtime'] : ['size', 'mode', 'mtimeMs', 'ino', 'dev'])
    .every((key) => current[key] === original[key]);
}

class Transfers {
  constructor(ssh, emit) {
    this.ssh = ssh;
    this.emit = emit;
    this.jobs = new Map();
    this.pending = [];
  }

  async prepare(sessionId, direction, directory, names, localDirectory) {
    const session = this.ssh.connected(sessionId).identity;
    const sftp = await this.ssh.sftp(sessionId);
    const remoteDirectory = remotePath(directory);
    const files = [];
    for (const name of names) {
      const local = direction === 'up' ? name : path.join(localDirectory, fileName(name));
      const remote = path.posix.join(remoteDirectory, fileName(direction === 'up' ? path.basename(name) : name));
      const source = direction === 'up' ? await fs.stat(local) : await call(sftp, 'lstat', remote);
      if (!source.isFile()) throw new Error('首版支持传输普通文件。');
      const target = direction === 'up' ? remote : local;
      const exists = await this.targetStat(sftp, direction, target);
      files.push({ session, direction, local, remote, size: source.size, target, original: exists, exists: Boolean(exists), canReplace: exists?.isFile() });
    }
    return files;
  }

  targetStat(sftp, direction, target) {
    return direction === 'up'
      ? optionalStat(() => call(sftp, 'lstat', target), 2)
      : optionalStat(() => fs.lstat(target), 'ENOENT');
  }

  enqueue(files, policy) {
    for (const file of files) {
      const job = { ...file, id: randomUUID(), policy, status: 'queued', bytes: 0, controller: new AbortController() };
      this.jobs.set(job.id, job);
      this.pending.push(job);
      this.publish(job);
    }
    void this.drain();
  }

  publish(job) {
    this.emit({
      type: 'transfer', id: job.id, sessionId: job.session.id, host: job.session.host.name,
      direction: job.direction, local: job.local, remote: job.remote, size: job.size,
      bytes: job.bytes, status: job.status, message: job.message || ''
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running'].includes(job.status)) return;
    job.controller.abort();
    if (job.status === 'queued') {
      job.status = 'canceled';
      this.publish(job);
    }
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['failed', 'canceled'].includes(job.status)) return;
    const session = this.ssh.connected(job.session.id).identity;
    if (session.fingerprint !== job.session.fingerprint || session.host.address !== job.session.host.address || session.host.port !== job.session.host.port || session.host.username !== job.session.host.username) {
      throw new Error('原会话的连接目标已改变，请重新发起传输。');
    }
    this.enqueue([{ ...job, session, message: '' }], 'skip');
  }

  async cancelSession(sessionId) {
    const cleanup = [];
    for (const job of this.jobs.values()) {
      if (job.session.id !== sessionId) continue;
      this.cancel(job.id);
      if (job.settled) cleanup.push(job.settled);
    }
    if (!cleanup.length) return;
    let timeout;
    await Promise.race([Promise.all(cleanup), new Promise((resolve) => { timeout = setTimeout(resolve, 3000); })]);
    clearTimeout(timeout);
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift();
        if (job.status === 'canceled') continue;
        job.status = 'running';
        this.publish(job);
        job.settled = this.run(job).catch((error) => {
          const cleanup = job.message;
          const detail = cleanup ? `${error.message} ${cleanup}` : error.message;
          const remoteCommitUnknown = job.status === 'committing' && job.direction === 'up'
            && typeof error.code !== 'number' && !error.message.startsWith('Server does not support');
          job.status = job.controller.signal.aborted ? 'canceled' : remoteCommitUnknown ? 'unverified' : 'failed';
          job.message = job.status === 'unverified' ? `提交未确认，请检查目标文件。${detail}` : detail;
        });
        try { await job.settled; }
        finally { delete job.settled; }
        this.publish(job);
      }
    } finally {
      this.draining = false;
    }
  }

  async run(job) {
    const { signal } = job.controller;
    const upload = job.direction === 'up';
    if (this.ssh.connected(job.session.id).identity !== job.session) throw new Error('原 SSH 会话已断开，请重新连接后重试。');
    const sftp = await this.ssh.sftp(job.session.id);
    signal.throwIfAborted();

    const targetPath = upload ? path.posix : path;
    const stat = (target) => this.targetStat(sftp, job.direction, target);
    const existing = await stat(job.target);
    const replace = Boolean(existing && job.policy === 'replace' && job.exists && job.canReplace && existing.isFile());
    if (replace && !sameTarget(existing, job.original, upload)) throw new Error('目标文件已变化，请重新确认后传输。');
    if (existing && !replace && job.policy !== 'keep') { job.status = 'skipped'; return; }
    if (existing && job.policy === 'keep') {
      const { dir, name, ext } = targetPath.parse(job.target);
      let available;
      for (let i = 2; i <= 100; i++) {
        const candidate = targetPath.join(dir, `${name} (${i})${ext}`);
        if (!await stat(candidate)) { available = candidate; break; }
      }
      if (!available) throw new Error('找不到可用的另存文件名。');
      job.target = available;
      if (upload) job.remote = available;
      else job.local = available;
    }

    const temporary = targetPath.join(targetPath.dirname(job.target), `.termlume-${job.id}.part`);
    let handle;
    let localHandle;
    let created = false;
    let lastUpdate = 0;
    const progress = new Transform({ transform: (chunk, _encoding, callback) => {
      job.bytes += chunk.length;
      if (Date.now() - lastUpdate >= 125) { lastUpdate = Date.now(); this.publish(job); }
      callback(null, chunk);
    } });
    try {
      signal.throwIfAborted();
      if (upload) {
        handle = await call(sftp, 'open', temporary, 'wx', { mode: 0o600 });
        created = true;
        let offset = 0;
        const writer = new Writable({ write: (chunk, _encoding, callback) => {
          const position = offset;
          offset += chunk.length;
          sftp.write(handle, chunk, 0, chunk.length, position, callback);
        } });
        await pipeline(createReadStream(job.local), progress, writer, { signal });
        await call(sftp, 'close', handle);
        handle = undefined;
      } else {
        localHandle = await fs.open(temporary, 'wx', 0o600);
        created = true;
        await pipeline(sftp.createReadStream(job.remote), progress, localHandle.createWriteStream(), { signal });
      }
      if (job.bytes !== job.size) throw new Error('源文件大小已改变，请重新选择文件。');
      if (replace) {
        const current = await stat(job.target);
        if (!sameTarget(current, existing, upload)) {
          throw new Error('目标文件已变化，请重新确认后传输。');
        }
      }
      signal.throwIfAborted();
      job.status = 'committing';
      this.publish(job);
      if (upload) {
        await call(sftp, replace ? 'ext_openssh_rename' : 'rename', temporary, job.remote);
        created = false;
      } else if (replace) {
        await fs.rename(temporary, job.local);
        created = false;
      } else {
        // A hard link publishes the completed file without clobbering a racing writer.
        await fs.link(temporary, job.local);
      }
      job.status = 'done';
    } finally {
      if (handle) await call(sftp, 'close', handle).catch(() => {});
      if (localHandle) await localHandle.close().catch(() => {});
      if (created) {
        const remove = upload ? call(sftp, 'unlink', temporary) : fs.unlink(temporary);
        await remove.catch(() => { job.message = `请检查传输临时文件 ${temporary}`; });
      }
    }
  }
}

module.exports = { Transfers };
