const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { Sessions, call } = require('./ssh.cjs');
const { uuid } = require('./vault.cjs');

const block = 128 * 1024;
const sizeOf = (attr) => Number.isSafeInteger(attr.size) && attr.size >= 0 ? attr.size : -1;
const sourceStamp = (attr, local) => [sizeOf(attr), local ? attr.mtimeMs : attr.mtime,
  local ? attr.ctimeMs : null, local ? attr.ino : null];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class TransferQueue {
  constructor({ trust, emit }) {
    this.jobs = new Map();
    this.ssh = new Sessions({ trust, emit: (kind, event) => {
      if (kind === 'closed') this.jobs.get(event.id)?.connectionClosed?.();
    } });
    this.emit = emit;
    this.active = 0;
  }

  view(job) {
    const { id, type, server, remote, local, state, size, done, message, directory, route } = job;
    return { id, type, server, remote, local, state, size, done, message, directory, route };
  }

  snapshot() {
    return [...this.jobs.values()].map((job) => this.view(job));
  }

  add(type, profile, jump, remote, local, { directory = false } = {}) {
    if (this.jobs.size >= 500) throw new Error('传输任务过多，请先清理历史任务。');
    const id = uuid();
    const target = type === 'upload' ? remote : local;
    const parent = type === 'upload' ? path.posix.dirname(target) : path.dirname(target);
    const join = type === 'upload' ? path.posix.join : path.join;
    const endpoint = ({ host, port, username }) => [host.toLowerCase(), port, username];
    const route = JSON.stringify([endpoint(profile), jump ? endpoint(jump) : null]);
    const job = { id, type, profile, jump, route, server: profile.name, remote, local, directory,
      part: join(parent, '.syncssh-' + id + '.part'), state: 'queued', size: null, done: 0, attempts: 0 };
    this.jobs.set(id, job);
    this.publish(job);
    this.pump();
    return id;
  }

  publish(job) {
    this.emit(this.view(job));
  }

  pump() {
    if (this.closing) return;
    while (this.active < 2) {
      const job = [...this.jobs.values()].find((item) => item.state === 'queued');
      if (!job) break;
      this.active++;
      job.state = 'running';
      job.message = '';
      this.publish(job);
      this.run(job).finally(() => { this.active--; this.pump(); }).catch(() => {});
    }
  }

  async connect(job) {
    const connection = await this.ssh.connect(job.id, job.profile, job.jump, { mode: 'transfer' });
    const sftp = await job.request(connection, 'sftp');
    sftp.on('error', () => {});
    return sftp;
  }

  async run(job) {
    let sftp;
    const guard = connectionGuard();
    job.connectionClosed = guard.close;
    job.request = guard.call;
    try {
      sftp = await this.connect(job);
      if (job.canceled) return;
      if (job.directory) {
        this.ssh.sessions.get(job.id).sftp = Promise.resolve(sftp);
        const skipped = await this.ssh.files(job.id, 'download', job.remote, { local: job.local });
        if (skipped) job.message = '已跳过 ' + skipped + ' 项。';
      } else await this.copy(job, sftp);
      if (!job.canceled) job.state = 'complete';
    } catch (error) {
      if (!job.canceled) {
        const disconnected = !sftp
          ? ['client-socket', 'client-timeout'].includes(error.level) || /ECONN|ENET|ETIMEDOUT|SSH 连接已关闭/.test(error.message)
          : !this.ssh.sessions.has(job.id) || error.code === 'ERR_NOT_CONNECTED' ||
            /No response from server|Channel is not open|Connection lost/i.test(error.message);
        job.message = error.message;
        if (!job.directory && disconnected && job.attempts < 3 && !this.closing) {
          job.state = 'waiting';
          const delay = 1200 * 2 ** job.attempts++;
          job.timer = setTimeout(() => {
            job.state = 'queued';
            this.publish(job);
            this.pump();
          }, delay);
        } else job.state = 'failed';
      }
    } finally {
      if (job.canceled) {
        await this.cleanup(job, sftp);
        job.state = 'canceled';
      }
      guard.close();
      job.connectionClosed = null;
      job.request = null;
      this.ssh.disconnect(job.id);
      this.publish(job);
    }
  }

  async copy(job, sftp) {
    const upload = job.type === 'upload';
    const local = localAccess();
    const remote = remoteAccess(sftp, job.request);
    const src = upload ? local : remote;
    const dst = upload ? remote : local;
    const srcPath = upload ? job.local : await job.request(sftp, 'realpath', job.remote);
    const dstPath = upload ? job.remote : job.local;
    const source = await src.stat(srcPath);
    if (!source.isFile() || sizeOf(source) < 0) throw new Error('源路径不是可传输的普通文件。');
    const stamp = sourceStamp(source, upload);
    if (job.source && (srcPath !== job.sourcePath || !same(stamp, job.source))) {
      throw new Error('源文件已变化。请取消此任务并重新加入队列。');
    }
    job.source = stamp;
    job.sourcePath = srcPath;
    job.size = stamp[0];
    if (await dst.tryStat(dstPath)) throw new Error('目标已存在。请保留现有文件并选择其他目标。');

    const reader = await src.open(srcPath, 'r');
    let writer;
    try {
      const part = job.created && await dst.tryStat(job.part);
      if (part && (!part.isFile() || sizeOf(part) < job.done || sizeOf(part) > job.size)) {
        throw new Error('临时文件已变化，无法安全续传。');
      }
      writer = await dst.open(job.part, part ? 'r+' : 'wx');
      job.created = true;
      let offset = 0;
      const checksum = createHash('sha256');
      if (part) {
        const length = sizeOf(part);
        while (offset < length) {
          const count = Math.min(block, length - offset, offset < job.done ? job.done - offset : block);
          const original = await readExactly(src, reader, count, offset);
          const staged = await readExactly(dst, writer, count, offset);
          if (!original.equals(staged)) throw new Error('已传部分与源文件不一致，无法安全续传。');
          offset += count;
          checksum.update(original);
          if (offset === job.done && job.checkpoint && checksum.copy().digest('hex') !== job.checkpoint) {
            throw new Error('已传部分与先前校验结果不一致。');
          }
        }
      } else job.done = 0;
      job.done = offset;
      job.checkpoint = checksum.copy().digest('hex');
      this.publish(job);
      let last = 0;
      while (offset < job.size) {
        if (job.canceled) throw new Error('已取消');
        const bytes = await readExactly(src, reader, Math.min(block, job.size - offset), offset);
        await dst.write(writer, bytes, offset);
        checksum.update(bytes);
        offset += bytes.length;
        job.done = offset;
        job.checkpoint = checksum.copy().digest('hex');
        if (Date.now() - last > 180) { last = Date.now(); this.publish(job); }
      }
      if (job.canceled) throw new Error('已取消');
      if (!same(sourceStamp(await src.stat(srcPath), upload), stamp)) throw new Error('传输期间源文件发生变化。');
      if (upload && sizeOf(await job.request(sftp, 'fstat', writer)) !== job.size) throw new Error('远程临时文件大小不一致。');
      if (!upload) await writer.sync();
      const finishedWriter = writer;
      writer = null;
      await dst.close(finishedWriter);
      if (job.canceled) throw new Error('已取消');
      if (await dst.tryStat(dstPath)) throw new Error('目标已存在，未覆盖。');
      job.publishing = true;
      try {
        if (upload) await job.request(sftp, 'rename', job.part, dstPath);
        else {
          try { await fs.link(job.part, dstPath); }
          catch (error) {
            if (!['ENOTSUP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
            await fs.copyFile(job.part, dstPath, constants.COPYFILE_EXCL);
          }
        }
      } finally { job.publishing = false; }
      if (!upload) await fs.unlink(job.part).catch(() => {});
      job.created = false;
    } finally {
      if (writer) await dst.close(writer).catch(() => {});
      await src.close(reader).catch(() => {});
    }
  }

  async cleanup(job, sftp) {
    if (!job.created) return;
    try {
      if (job.type === 'download') await fs.unlink(job.part);
      else if (sftp) await job.request(sftp, 'unlink', job.part);
      else throw new Error('已断线');
      job.created = false;
    } catch {
      job.message = '可能仍有临时文件：' + job.part;
    }
  }

  async change(id, action) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('找不到传输任务。');
    if (action === 'retry' && job.state === 'failed' && !job.directory) {
      job.attempts = 0;
      job.state = 'queued';
      this.publish(job);
      this.pump();
    } else if (action === 'cancel' && !job.publishing && ['queued', 'waiting', 'running', 'failed'].includes(job.state)) {
      if (job.directory && job.state === 'running') return false;
      clearTimeout(job.timer);
      job.canceled = true;
      if (job.state === 'running') return true;
      await this.cleanup(job);
      job.state = 'canceled';
      this.publish(job);
    }
    return true;
  }

  clear() {
    for (const job of this.jobs.values()) {
      if (['complete', 'canceled'].includes(job.state)) this.jobs.delete(job.id);
    }
    return this.snapshot();
  }

  hasUnfinished() {
    return [...this.jobs.values()].some(({ state }) => ['queued', 'running', 'waiting', 'failed'].includes(state));
  }

  close() {
    this.closing = true;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    for (const id of this.ssh.sessions.keys()) this.ssh.disconnect(id);
  }
}

function connectionGuard() {
  let closed = false;
  const requests = new Set();
  const disconnected = () => Object.assign(new Error('SSH 连接已关闭。'), { code: 'ERR_NOT_CONNECTED' });
  return {
    close() {
      if (closed) return;
      closed = true;
      for (const reject of requests) reject(disconnected());
    },
    call(target, method, ...args) {
      if (closed) return Promise.reject(disconnected());
      return new Promise((resolve, reject) => {
        const settle = (error, value) => {
          requests.delete(settle);
          clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => settle(disconnected()), 45000);
        requests.add(settle);
        call(target, method, ...args).then((value) => settle(null, value), settle);
      });
    }
  };
}

function access(stat, missing, open, read, write, close) {
  return { stat, open, read, write, close, async tryStat(file) {
    try { return await stat(file); }
    catch (error) { if (error.code === missing) return null; throw error; }
  } };
}

function localAccess() {
  return access(fs.lstat, 'ENOENT', (file, flags) => fs.open(file, flags, 0o600),
    async (handle, buffer, offset, count, at) => (await handle.read(buffer, offset, count, at)).bytesRead,
    async (handle, buffer, at) => {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, at + offset);
        if (!bytesWritten) throw new Error('写入本地磁盘失败。');
        offset += bytesWritten;
      }
    }, (handle) => handle.close());
}

function remoteAccess(sftp, request) {
  return access((file) => request(sftp, 'lstat', file), 2,
    (file, flags) => request(sftp, 'open', file, flags, { mode: 0o600 }),
    (handle, buffer, offset, count, at) => request(sftp, 'read', handle, buffer, offset, count, at),
    (handle, buffer, at) => request(sftp, 'write', handle, buffer, 0, buffer.length, at),
    (handle) => request(sftp, 'close', handle));
}

async function readExactly(endpoint, handle, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const count = await endpoint.read(handle, bytes, filled, length - filled, position + filled);
    if (!count) throw new Error('源文件或临时文件意外结束。');
    filled += count;
  }
  return bytes;
}

module.exports = { TransferQueue };
