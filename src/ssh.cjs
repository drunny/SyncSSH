
const { Client, utils } = require('ssh2');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');
const posix = require('node:path').posix;
const { TextDecoder } = require('node:util');
const { uuid, hash } = require('./vault.cjs');

const call = (target, method, ...args) => new Promise((resolve, reject) =>
  target[method](...args, (error, result) => error ? reject(error) : resolve(result)));
const fingerprint = (key) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
const textLimit = 2 * 1024 * 1024;

class Sessions {
  constructor({ trust, emit }) {
    Object.assign(this, { trust, emit });
    this.sessions = new Map();
  }

  async connect(id, profile, jump, { mode = 'session' } = {}) {
    if (this.sessions.has(id)) throw new Error('会话已经存在。');
    const session = { id, clients: [], inflight: 0, mode };
    this.sessions.set(id, session);
    try {
      let socket;
      if (jump) {
        const gateway = await this.client(session, jump, undefined, '跳板');
        socket = await call(gateway, 'forwardOut', '127.0.0.1', 0, profile.host, profile.port);
        socket.on('error', (error) => this.drop(session, error.message));
      }
      const connection = await this.client(session, profile, socket, jump ? '目标主机' : '直连主机');
      session.connection = connection;
      if (mode !== 'session') return connection;
      const terminal = await call(connection, 'shell', { term: 'xterm-256color', cols: 90, rows: 24 });
      session.terminal = terminal;
      const output = (data) => {
        session.inflight += data.length;
        this.emit('output', { id, data });
        if (session.inflight > 512 * 1024) {
          terminal.pause();
          terminal.stderr.pause();
        }
      };
      terminal.on('data', output);
      terminal.stderr.on('data', output);
      terminal.on('close', () => this.drop(session, '远程终端已退出。'));
      terminal.on('error', (error) => this.drop(session, error.message));
      // Open SFTP independently. A server that disables it can still host a terminal.
      session.sftp = call(connection, 'sftp').then((sftp) => {
        sftp.on('error', () => {});
        return sftp;
      });
      session.sftp.catch(() => {});
    } catch (error) {
      this.drop(session, error.message);
      throw error;
    }
  }

  client(session, profile, sock, role) {
    return new Promise((resolve, reject) => {
      if (this.sessions.get(session.id) !== session) {
        reject(new Error('会话已关闭。'));
        return;
      }
      const client = new Client();
      session.clients.push(client);
      let verificationError;
      client.once('ready', () => {
        client.setNoDelay(true);
        resolve(client);
      });
      client.on('error', (error) => {
        const failure = verificationError || error;
        reject(failure);
        this.drop(session, failure.message);
      });
      client.once('close', () => {
        const error = verificationError || new Error('SSH 连接已关闭。');
        reject(error);
        this.drop(session, error.message);
      });
      client.connect({
        host: profile.host, port: profile.port, username: profile.username, sock,
        ...(profile.auth === 'key' ? { privateKey: profile.privateKey, passphrase: profile.passphrase || undefined }
          : { password: profile.password }),
        keepaliveInterval: 15000, keepaliveCountMax: 3, readyTimeout: 120000,
        hostVerifier: (key, accept) => {
          this.trust(profile, fingerprint(key), { role, temporary: session.mode === 'test' }).then(() => {
            if (this.sessions.get(session.id) === session) accept(true);
          }, (error) => {
            verificationError = error;
            if (this.sessions.get(session.id) === session) accept(false);
          });
        }
      });
    });
  }

  drop(session, reason) {
    if (this.sessions.get(session.id) === session) this.disconnect(session.id, reason);
  }

  disconnect(id, reason = '已断开。') {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const client of session.clients.reverse()) client.destroy();
    this.emit('closed', { id, reason });
  }

  input(id, data) {
    this.sessions.get(id)?.terminal?.write(data);
  }

  acknowledge(id, size) {
    const session = this.sessions.get(id);
    if (!session?.terminal) return;
    session.inflight = Math.max(session.inflight - size, 0);
    if (session.inflight < 256 * 1024 && session.terminal.isPaused()) {
      session.terminal.resume();
      session.terminal.stderr.resume();
    }
  }

  resize(id, cols, rows) {
    this.sessions.get(id)?.terminal?.setWindow(rows, cols, 0, 0);
  }

  async files(id, operation, remote, options = {}) {
    const session = this.sessions.get(id);
    if (!session?.sftp) throw new Error('请先建立 SSH 会话。');
    const sftp = await session.sftp;
    if (['create', 'rename', 'chmod', 'delete'].includes(operation) && (!remote.startsWith('/') || posix.normalize(remote).replace(/\/$/, '') === '')) {
      throw new Error('请选择有效的远程路径。');
    }
    switch (operation) {
      case 'list': {
        const dir = await call(sftp, 'realpath', remote);
        const entries = await call(sftp, 'readdir', dir);
        return { dir, entries: entries.filter(({ filename }) =>
          filename !== '.' && filename !== '..' && !filename.includes('/') && !filename.includes('\0')
        ).map(({ filename, attrs }) => ({
          name: filename, dir: attrs.isDirectory(), link: attrs.isSymbolicLink(),
          regular: attrs.isFile(), size: attrs.size, mtime: attrs.mtime,
          mode: attrs.mode, uid: attrs.uid, gid: attrs.gid
        })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) };
      }
      case 'read': {
        const file = await call(sftp, 'realpath', remote);
        const { bytes } = await readTextFile(sftp, file);
        if (bytes.includes(0)) throw new Error('该文件不是 UTF-8 文本。');
        try {
          return { path: file, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
            revision: hash(bytes) };
        } catch {
          throw new Error('该文件不是 UTF-8 文本。');
        }
      }
      case 'save': {
        const { bytes, attrs } = await readTextFile(sftp, remote);
        if (hash(bytes) !== options.revision) throw new Error('远程文件已修改，草稿已保留。');
        const next = Buffer.from(options.content, 'utf8');
        if (next.length > textLimit) throw new Error('文本编辑限 2 MiB。');
        await replaceFile(sftp, remote, next, attrs, options.revision);
        return hash(next);
      }
      case 'mkdir':
        return call(sftp, 'mkdir', remote);
      case 'create': {
        const handle = await call(sftp, 'open', remote, 'wx', { mode: 0o644 });
        return call(sftp, 'close', handle);
      }
      case 'stat': {
        const attrs = await call(sftp, 'lstat', remote);
        return { mode: attrs.mode & 0o7777, dir: attrs.isDirectory(), link: attrs.isSymbolicLink() };
      }
      case 'rename': {
        const name = options.name;
        if (!name || ['.', '..'].includes(name) || /[\/\0]/.test(name)) throw new Error('请输入一个文件或目录名称。');
        return call(sftp, 'rename', remote, posix.join(posix.dirname(remote), name));
      }
      case 'chmod': {
        if (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o7777) throw new Error('权限必须为八进制。');
        if ((await call(sftp, 'lstat', remote)).isSymbolicLink()) throw new Error('请打开链接指向的路径后修改权限。');
        return call(sftp, 'chmod', remote, options.mode);
      }
      case 'delete': {
        const attrs = await call(sftp, 'lstat', remote);
        if (!attrs.isDirectory()) return call(sftp, 'unlink', remote);
        if (!options.recursive) return call(sftp, 'rmdir', remote);
        return removeDirectory(sftp, remote);
      }
      case 'download': {
        if ((await call(sftp, 'lstat', remote)).isDirectory()) {
          return downloadDirectory(sftp, remote, options.local);
        }
        return downloadFile(sftp, remote, options.local);
      }
      case 'upload': {
        const handle = await call(sftp, 'open', remote, 'wx', { mode: 0o600 });
        try {
          const destination = sftp.createWriteStream(remote, { handle, mode: 0o600 });
          await pipeline(fs.createReadStream(options.local), destination);
          if (!destination.isClosed) await once(destination, 'close');
        } catch (error) {
          await call(sftp, 'close', handle).catch(() => {});
          await call(sftp, 'unlink', remote).catch(() => {});
          throw error;
        }
        return;
      }
      default:
        throw new Error('未知的 SFTP 操作。');
    }
  }
}

async function removeDirectory(sftp, dir) {
  for (const { filename, attrs } of await call(sftp, 'readdir', dir)) {
    if (!validEntry(filename)) continue;
    const remote = posix.join(dir, filename);
    if (attrs.isDirectory() && (await call(sftp, 'lstat', remote)).isDirectory()) await removeDirectory(sftp, remote);
    else await call(sftp, 'unlink', remote);
  }
  return call(sftp, 'rmdir', dir);
}

function validEntry(name) {
  return name && !['.', '..'].includes(name) && !/[\/\0]/.test(name);
}

async function downloadDirectory(sftp, remote, local) {
  const localJoin = require('node:path').join;
  await fs.promises.mkdir(local);
  let skipped = 0;
  for (const { filename, attrs } of await call(sftp, 'readdir', remote)) {
    if (!validEntry(filename)) continue;
    if (/[<>:"/\\|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename)
      || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(filename)) {
      skipped++;
      continue;
    }
    const child = posix.join(remote, filename);
    const target = localJoin(local, filename);
    if (attrs.isDirectory() && (await call(sftp, 'lstat', child)).isDirectory()) skipped += await downloadDirectory(sftp, child, target);
    else if (attrs.isFile() && (await call(sftp, 'lstat', child)).isFile()) await downloadFile(sftp, child, target);
    else skipped++;
  }
  return skipped;
}

async function downloadFile(sftp, remote, localPath) {
  if (!(await call(sftp, 'stat', remote)).isFile()) throw new Error('远程路径不是普通文件。');
  const local = await fs.promises.open(localPath, 'wx', 0o600);
  try {
    const source = sftp.createReadStream(remote);
    await pipeline(source, local.createWriteStream());
    if (!source.isClosed) await once(source, 'close');
  } catch (error) {
    await local.close().catch(() => {});
    await fs.promises.unlink(localPath).catch(() => {});
    throw error;
  }
  return 0;
}

async function readTextFile(sftp, file) {
  const entry = await call(sftp, 'lstat', file);
  if (!entry.isFile() || entry.size > textLimit) throw new Error('只能编辑 2 MiB 以内的普通文本文件。');
  const handle = await call(sftp, 'open', file, 'r');
  try {
    const attrs = await call(sftp, 'fstat', handle);
    if (!attrs.isFile() || attrs.size > textLimit) throw new Error('只能编辑 2 MiB 以内的普通文本文件。');
    const chunks = [];
    let length = 0;
    while (length <= textLimit) {
      const buffer = Buffer.allocUnsafe(Math.min(32 * 1024, textLimit + 1 - length));
      const read = await call(sftp, 'read', handle, buffer, 0, buffer.length, length);
      if (!read) return { bytes: Buffer.concat(chunks), attrs };
      chunks.push(buffer.subarray(0, read));
      length += read;
    }
    throw new Error('文件已超过 2 MiB。');
  } finally {
    await call(sftp, 'close', handle);
  }
}

async function replaceFile(sftp, remote, data, attrs, expected) {
  const tmp = posix.join(posix.dirname(remote), '.syncssh-' + uuid());
  const handle = await call(sftp, 'open', tmp, 'wx', { mode: 0o600 });
  try {
    try {
      if (data.length) await call(sftp, 'write', handle, data, 0, data.length, 0);
      const created = await call(sftp, 'fstat', handle);
      if (created.uid !== attrs.uid || created.gid !== attrs.gid) {
        await call(sftp, 'fchown', handle, attrs.uid, attrs.gid);
      }
      await call(sftp, 'fchmod', handle, attrs.mode & 0o777);
    } finally {
      await call(sftp, 'close', handle);
    }
    const latest = await readTextFile(sftp, remote);
    if (hash(latest.bytes) !== expected || latest.attrs.mode !== attrs.mode
      || latest.attrs.uid !== attrs.uid || latest.attrs.gid !== attrs.gid) {
      throw new Error('远程文件已修改，草稿已保留。');
    }
    await call(sftp, 'ext_openssh_rename', tmp, remote);
  } catch (error) {
    await call(sftp, 'unlink', tmp).catch(() => {});
    throw error;
  }
}

function validateKey(privateKey, passphrase) {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error || !parsed.isPrivateKey()) {
    throw new Error('无法读取私钥，请核对格式和口令。');
  }
}

module.exports = { Sessions, fingerprint, call, validateKey };
