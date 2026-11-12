const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join, posix } = require('node:path');
const { Client } = require('ssh2');

function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096) {
    throw new Error('请输入有效的远端绝对路径。');
  }
  return posix.normalize(value);
}

function fileName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\x00-\x1f\x7f]/.test(value)) {
    throw new Error('文件名包含不支持的字符。');
  }
  return value;
}

function commandFor({ action, argument, lines = 100 }) {
  if (action === 'disk') return 'df -h';
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error('行数须在 1 至 10000 之间。');
  if (action === 'journal') {
    if (typeof argument !== 'string' || !/^[\w][\w.@-]{0,255}$/.test(argument)) throw new Error('请输入明确的 systemd 服务名。');
    return `journalctl --unit=${argument} -n ${lines} --no-pager`;
  }
  if (action !== 'tail' && action !== 'follow') throw new Error('未知的快捷命令。');
  const quotedPath = `'${remotePath(argument).replaceAll("'", "'\\''")}'`;
  return `tail -n ${lines}${action === 'follow' ? ' -f' : ''} ${quotedPath}`;
}

function terminalSize({ cols, rows } = {}) {
  return {
    cols: Number.isInteger(cols) ? Math.max(2, Math.min(1000, cols)) : 80,
    rows: Number.isInteger(rows) ? Math.max(2, Math.min(500, rows)) : 24,
    term: 'xterm-256color'
  };
}

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error, value) => error ? reject(error) : resolve(value)));
}

class WorkspaceSSH {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
    this.sessions = new Map();
    this.commands = new Map();
    this.acknowledgments = new Map();
  }

  async connect(id, host, secret, dimensions, { getSavedPassword, onAuthenticated } = {}) {
    if (this.sessions.has(id)) throw new Error('这个标签已有连接。');
    const client = new Client();
    const session = { host, client, identity: { id, host }, size: terminalSize(dimensions) };
    this.sessions.set(id, session);
    const end = (message) => {
      if (this.sessions.get(id) !== session) return;
      this.sessions.delete(id);
      session.verify = undefined;
      const retryWithPassword = getSavedPassword && (session.authenticationFailed || session.savedPasswordUnavailable);
      this.emit({ type: 'session', id, status: 'closed', message, exited: Boolean(session.exited), retryWithPassword: Boolean(retryWithPassword) });
    };
    client.on('error', (error) => {
      if (error.level === 'client-authentication') session.authenticationFailed = true;
      session.error ||= session.authenticationFailed ? 'SSH 认证失败，请检查用户和凭据。' : error.message;
    });
    client.once('close', () => end(session.exited ? '远端会话已退出。' : session.error || 'SSH 连接已断开。'));
    client.once('ready', async () => {
      client.config.password = undefined;
      try {
        this.emit({ type: 'progress', id, message: '正在打开远端终端…' });
        const channel = await call(client, 'shell', session.size);
        if (this.sessions.get(id) !== session) { channel.close(); return; }
        session.channel = channel;
        channel.setWindow(session.size.rows, session.size.cols, 0, 0);
        this.pipeOutput(id, channel);
        channel.once('exit', (code, signal) => {
          session.exited = Number.isInteger(code);
          if (signal) session.error = '远端 Shell 被信号终止。';
        });
        channel.once('close', () => client.end());
        this.emit({ type: 'session', id, status: 'ready' });
        void onAuthenticated?.(session.identity.fingerprint);
      } catch (error) {
        session.error = error.message;
        client.destroy();
      }
    });

    let expectedFingerprint;
    let passwordFromVault = false;
    const config = {
      host: host.address, port: host.port, username: host.username,
      readyTimeout: 60000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostVerifier: (key, verify) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        const saved = this.store.fingerprint(host);
        session.identity.fingerprint = fingerprint;
        if (expectedFingerprint && (fingerprint !== expectedFingerprint || (!passwordFromVault && saved !== expectedFingerprint))) {
          session.savedPasswordUnavailable = true;
          session.error = '已保存密码的主机信任记录已变化，请重新输入密码。';
          return false;
        }
        if (saved) {
          if (saved !== fingerprint) {
            session.error = `主机指纹已变化，连接已阻断。已信任 ${saved}，当前 ${fingerprint}。`;
          }
          return saved === fingerprint;
        }
        session.verify = { fingerprint, verify };
        this.emit({ type: 'trust', id, fingerprint });
      }
    };
    try {
      if (host.auth === 'key') {
        config.privateKey = await readFile(host.keyPath);
        config.passphrase = secret || undefined;
      } else if (host.auth === 'password') {
        if (getSavedPassword) {
          try {
            const { password, fingerprint, fromVault } = await getSavedPassword();
            config.password = password;
            expectedFingerprint = fingerprint;
            passwordFromVault = fromVault === true;
          } catch (error) {
            session.savedPasswordUnavailable = true;
            throw error;
          }
        } else {
          config.password = secret;
        }
      } else {
        if (!process.env.SSH_AUTH_SOCK) throw new Error('找不到本机 SSH Agent。请从有 SSH_AUTH_SOCK 的终端启动，或选择私钥认证。');
        config.agent = process.env.SSH_AUTH_SOCK;
      }
      if (this.sessions.get(id) === session) client.connect(config);
    } catch (error) {
      end(error.message);
    } finally {
      config.password = undefined;
      config.privateKey?.fill(0);
    }
  }

  trust(id, accepted) {
    const session = this.sessions.get(id);
    const pending = session?.verify;
    if (!pending) return;
    session.verify = undefined;
    if (accepted) {
      try { this.store.trust(session.host, pending.fingerprint); }
      catch (error) { session.error = error.message; accepted = false; }
    } else {
      session.error = '已取消主机信任。';
    }
    pending.verify(accepted);
  }

  connected(id) {
    const session = this.sessions.get(id);
    if (!session?.channel) throw new Error('请先连接该主机。');
    return session;
  }

  resize(id, size) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.size = terminalSize(size);
    session.channel?.setWindow(session.size.rows, session.size.cols, 0, 0);
  }

  input(id, data) {
    if (typeof data !== 'string' || data.length > 1_048_576) return;
    this.sessions.get(id)?.channel?.write(data);
  }

  disconnect(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.verify?.verify(false);
    session.client.destroy();
  }

  async sftp(id) {
    const session = this.connected(id);
    if (!session.files) {
      session.files = call(session.client, 'sftp').then((channel) => {
        channel.on('error', () => {});
        channel.once('close', () => { session.files = undefined; });
        return channel;
      }).catch((error) => { session.files = undefined; throw error; });
    }
    return session.files;
  }

  async list(id, path) {
    const sftp = await this.sftp(id);
    const directory = remotePath(await call(sftp, 'realpath', path ? remotePath(path) : '.'));
    const rows = await call(sftp, 'readdir', directory);
    const entries = [];
    for (const { filename, attrs } of rows) {
      try { fileName(filename); } catch { continue; }
      entries.push({ name: filename, size: attrs.size, kind: attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other' });
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    return { directory, entries };
  }

  async mkdir(id, directory, name) {
    await call(await this.sftp(id), 'mkdir', posix.join(remotePath(directory), fileName(name)));
  }

  async createFile(id, directory, name) {
    const sftp = await this.sftp(id);
    const handle = await call(sftp, 'open', posix.join(remotePath(directory), fileName(name)), 'wx', { mode: 0o600 });
    await call(sftp, 'close', handle);
  }

  async inspect(id, value) {
    const path = remotePath(value);
    const sftp = await this.sftp(id);
    const attrs = await call(sftp, 'lstat', path);
    const directory = attrs.isDirectory() || (attrs.isSymbolicLink() &&
      await call(sftp, 'stat', path).then((target) => target.isDirectory(), () => false));
    const kind = directory ? 'directory' : attrs.isFile() ? 'file' : 'other';
    return { kind, path };
  }

  async directory(id) {
    const { client } = this.connected(id);
    const script = await readFile(join(__dirname, 'terminal-directory.sh'), 'utf8');
    return new Promise((resolve) => {
      let channel;
      let output = Buffer.alloc(0);
      let finished = false;
      const finish = (path) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(path);
        channel?.close();
      };
      const timeout = setTimeout(finish, 3000);
      client.exec(`sh -c '${script.replaceAll("'", "'\\''")}'`, (error, stream) => {
        if (error) { finish(); return; }
        if (finished) { stream.close(); return; }
        channel = stream;
        stream.on('data', (data) => {
          if (output.length + data.length > 4097) { finish(); return; }
          output = Buffer.concat([output, data]);
        });
        stream.on('error', () => finish());
        stream.on('close', (code) => {
          if (code !== 0 || output.at(-1) !== 0) { finish(); return; }
          try { finish(remotePath(output.subarray(0, -1).toString('utf8'))); }
          catch { finish(); }
        });
      });
    });
  }

  async serverInfo(id) {
    const { client } = this.connected(id);
    const script = await readFile(join(__dirname, 'server-info.sh'), 'utf8');
    return new Promise((resolve, reject) => {
      let channel, done = false, output = Buffer.alloc(0);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel?.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('采集服务器信息超时，请刷新重试。')), 15000);
      client.exec(`sh -c '${script.replaceAll("'", "'\\''")}'`, (error, stream) => {
        if (error) { finish(error); return; }
        if (done) { stream.close(); return; }
        channel = stream;
        stream.stderr.on('data', () => {});
        stream.on('data', bytes => {
          if (output.length + bytes.length > 256 * 1024) { finish(new Error('服务器信息超过大小限制。')); return; }
          output = Buffer.concat([output, bytes]);
        });
        stream.on('error', error => finish(error));
        stream.on('close', code => {
          if (code !== 0) finish(new Error('服务器信息采集失败，请重试。'));
          else finish(null, output.toString('utf8'));
        });
      });
    });
  }

  async command(id, sessionId, request) {
    const session = this.connected(sessionId);
    const command = commandFor(request);
    const follow = request.action === 'follow';
    const record = { sessionId, follow, command };
    this.commands.set(id, record);
    try {
      // A PTY gives the follow process a controlling terminal for interrupt and hangup.
      const channel = await call(session.client, 'exec', `exec ${command}`, follow ? { pty: true } : {});
      if (this.commands.get(id) !== record) { channel.close(); return; }
      record.channel = channel;
      this.pipeOutput(id, channel);
      if (record.stopping) this.stop(id);
      channel.once('close', (code) => {
        clearTimeout(record.timer);
        if (this.commands.get(id) !== record) return;
        this.commands.delete(id);
        const status = record.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
        this.emit({ type: 'command', id, status, message: code && !record.stopping ? `远端命令退出码 ${code}` : '' });
      });
      this.emit({ type: 'command', id, status: 'running' });
    } catch (error) {
      if (this.commands.get(id) !== record) return;
      this.commands.delete(id);
      this.emit({ type: 'command', id, status: 'failed', message: error.message });
    }
  }

  stop(id) {
    const record = this.commands.get(id);
    if (!record?.follow) return;
    record.stopping = true;
    if (!record.channel || record.timer) return;
    record.channel.write('\x03');
    record.timer = setTimeout(() => record.channel.close(), 1500);
  }

  closeCommand(id) {
    const record = this.commands.get(id);
    if (!record) return;
    if (record.follow) this.stop(id);
    else record.channel?.close();
    this.commands.delete(id);
  }

  pipeOutput(id, channel) {
    const ack = randomUUID();
    const streams = [channel, channel.stderr];
    const pending = [];
    let sent = false;
    let closed = false;
    const pump = () => {
      if (sent) return;
      if (pending.length) {
        sent = true;
        this.emit({ type: 'output', id, ack, bytes: pending.shift() });
      } else {
        for (const stream of streams) stream.resume();
        if (closed && streams.every((stream) => !stream.readableLength)) this.acknowledgments.delete(ack);
      }
    };
    const acknowledge = () => { sent = false; pump(); };
    this.acknowledgments.set(ack, acknowledge);
    for (const stream of streams) {
      stream.on('error', () => {});
      stream.on('data', (bytes) => {
        for (const source of streams) source.pause();
        pending.push(bytes);
        pump();
      });
    }
    channel.once('close', () => { closed = true; pump(); });
  }

  acknowledge(id) { this.acknowledgments.get(id)?.(); }

  dispose() {
    for (const id of this.commands.keys()) this.closeCommand(id);
    for (const id of this.sessions.keys()) this.disconnect(id);
    this.acknowledgments.clear();
  }
}

module.exports = { WorkspaceSSH, call, commandFor, fileName, remotePath };
