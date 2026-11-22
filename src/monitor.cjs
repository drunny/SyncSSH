const fs = require('node:fs/promises');
const path = require('node:path');
const { Sessions, call } = require('./ssh.cjs');
const { uuid } = require('./vault.cjs');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const locate = 'if [ "$(id -u)" = 0 ]; then printf "%s\\n" /root/.SyncSSH; else printf "%s\\n" "$HOME/.SyncSSH"; fi';
const samplerFile = 'metrics-v1.sh';

async function execute(connection, command, input) {
  const channel = await call(connection, 'exec', command);
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    const timer = setTimeout(() => { reject(new Error('远端操作超时。')); channel.close(); }, 12000);
    channel.on('data', (chunk) => { if (output.length < 8192) output += chunk; });
    channel.stderr.on('data', (chunk) => { if (error.length < 8192) error += chunk; });
    channel.once('error', (failure) => { clearTimeout(timer); reject(failure); });
    channel.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trimEnd());
      else reject(new Error(error.trim() || '远端操作已失败。'));
    });
    channel.end(input);
  });
}

function validatedPath(directory) {
  if (!directory.startsWith('/') || !directory.endsWith('/.SyncSSH') || /[\r\n\0]/.test(directory)
    || path.posix.normalize(directory) !== directory) throw new Error('远端账号的安装路径无效。');
  return directory;
}

function parseSample(line, previous) {
  const n = line.split(' ').map(Number);
  if (n.length !== 13 || n.some((value) => !Number.isFinite(value) || value < 0)
    || n[2] > n[1] || n[4] > n[3] || n[3] === 0 || n[6] > n[5] || n[5] === 0) return null;
  const seconds = previous ? n[0] - previous[0] : 0;
  const delta = (i) => seconds > 0 && n[i] >= previous[i] ? (n[i] - previous[i]) / seconds : null;
  const total = delta(1);
  const idle = delta(2);
  return {
    raw: n, cpu: total && idle !== null ? Math.max(0, Math.min(100, 100 * (total - idle) / total)) : null,
    memory: 100 * (n[3] - n[4]) / n[3], ram: n[3] * 1024,
    disk: 100 * (n[5] - n[6]) / n[5], diskTotal: n[5] * 1024,
    rx: delta(7), tx: delta(8), read: delta(9), write: delta(10), load: n[11], uptime: n[12]
  };
}

class Monitor {
  constructor({ trust, emit }) {
    this.emit = emit;
    this.transport = new Sessions({ trust, emit: () => {} });
    this.jobs = new Map();
  }
  async withConnection({ profile, jump }, task) {
    const id = uuid();
    try { return await task(await this.transport.connect(id, profile, jump, { mode: 'monitor' })); }
    finally { this.transport.disconnect(id); }
  }
  pathFor(config) {
    return this.withConnection(config, async (connection) => validatedPath(await execute(connection, locate)));
  }
  install(config, expected) {
    return this.withConnection(config, async (connection) => {
      const directory = validatedPath(await execute(connection, locate));
      if (directory !== expected) throw new Error('安装路径已改变，请重新确认。');
      const script = await fs.readFile(path.join(__dirname, samplerFile));
      const command = 'set -eu; umask 077; d=' + quote(directory) +
        '; test ! -L "$d"; mkdir -p "$d"; t=$(mktemp "$d/.install.XXXXXXXX"); ' +
        'trap \'rm -f "$t"\' EXIT; cat > "$t"; chmod 700 "$t"; mv -f -- "$t" "$d/' + samplerFile + '"';
      await execute(connection, 'sh -c ' + quote(command), script);
    });
  }
  publish(job, state, payload) {
    if (this.jobs.get(job.id) !== job) return;
    job.last = { id: job.id, state, at: Date.now(), ...payload };
    this.emit(job.last);
  }
  snapshot() {
    return [...this.jobs.values()].flatMap((job) => job.last ? [job.last] : []);
  }
  watch(id, config, identity) {
    if (this.jobs.get(id)?.identity === identity && this.jobs.has(id)) return;
    this.stop(id);
    const job = { id, config, identity, delay: 5000 };
    this.jobs.set(id, job);
    job.timer = setTimeout(() => this.run(job), Math.min(3000, (this.jobs.size - 1) * 250));
  }
  async run(job) {
    const current = () => this.jobs.get(job.id) === job;
    if (!current()) return;
    this.publish(job, 'connecting');
    const key = uuid();
    job.key = key;
    let watchdog;
    try {
      const { profile, jump } = job.config();
      const connection = await this.transport.connect(key, profile, jump, { mode: 'monitor' });
      if (!current()) return;
      const dir = validatedPath(await execute(connection, locate));
      if (!current()) return;
      const target = quote(dir + '/' + samplerFile);
      const channel = await call(connection, 'exec', 'test -x ' + target + ' && exec ' + target);
      if (!current()) return;
      await new Promise((resolve, reject) => {
        let buffer = '';
        let previous;
        let error = '';
        const waitForSample = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => reject(new Error('采集组件未返回数据。')), 15000);
        };
        waitForSample();
        channel.on('data', (bytes) => {
          buffer += bytes;
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            const sample = parseSample(line, previous);
            if (sample) {
              previous = sample.raw;
              const { raw, ...fields } = sample;
              job.delay = 5000;
              waitForSample();
              this.publish(job, 'online', { sample: fields });
            }
          }
          if (buffer.length > 8192) reject(new Error('采集数据格式错误。'));
        });
        channel.stderr.on('data', (bytes) => { if (error.length < 2048) error += bytes; });
        channel.once('error', reject);
        channel.once('close', () => reject(new Error(error.trim() || '监控已断开或采集组件不存在。')));
      });
    } catch (error) {
      this.publish(job, 'offline', { message: error.message, sample: job.last?.sample });
    } finally {
      clearTimeout(watchdog);
      this.transport.disconnect(key);
      if (current()) {
        job.timer = setTimeout(() => this.run(job), job.delay);
        job.delay = Math.min(60000, job.delay * 2);
      }
    }
  }
  stop(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    clearTimeout(job.timer);
    if (job.key) this.transport.disconnect(job.key);
  }
  close() {
    for (const id of this.jobs.keys()) this.stop(id);
    for (const id of this.transport.sessions.keys()) this.transport.disconnect(id);
  }
}
module.exports = { Monitor, parseSample };
