
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify, TextDecoder } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const uuid = () => crypto.randomUUID();
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const newSalt = () => crypto.randomBytes(32).toString('base64');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function derive(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('主密码需要 12–1024 个字符。');
  }
  const bytes = Buffer.from(salt || '', 'base64');
  if (bytes.length !== 32) throw new Error('仓库加密参数无效。');
  return scrypt(password, bytes, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 ** 2 });
}

function seal(key, context, value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const payload = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString('base64');
}

function unseal(key, context, encoded) {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new Error('主密码错误，或加密数据损坏。');
  }
}

const index = (events) => {
  const heads = new Map();
  const replaced = new Set();
  for (const event of Object.values(events)) {
    const group = heads.get(event.record) || [];
    group.push(event);
    heads.set(event.record, group);
    for (const parent of event.parents) replaced.add(parent);
  }
  return new Map([...heads].map(([record, versions]) => [
    record, versions.filter((event) => !replaced.has(event.id)).sort((a, b) =>
      b.at - a.at || b.id.localeCompare(a.id))
  ]));
};

function validateEvents(events) {
  for (const [id, event] of Object.entries(events)) {
    if (!idPattern.test(id) || event.id !== id || !/^(group|server|note|image):[0-9a-f-]{36}$/.test(event.record)
      || !Number.isFinite(event.at) || !Array.isArray(event.parents)
      || !(event.value === null || (event.value && typeof event.value === 'object'))) {
      throw new Error('同步记录格式有误。');
    }
    if (event.parents.some((parent) => parent === id || events[parent]?.record !== event.record)) {
      throw new Error('同步记录缺少历史版本或引用无效。');
    }
  }
  // Kahn's algorithm protects against cycles without relying on device clocks.
  const counts = new Map(Object.values(events).map((event) => [event.id, event.parents.length]));
  const successors = new Map();
  for (const event of Object.values(events)) {
    for (const parent of event.parents) {
      const next = successors.get(parent) || [];
      next.push(event.id);
      successors.set(parent, next);
    }
  }
  const queue = [...counts].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    for (const id of successors.get(queue[i]) || []) {
      const remaining = counts.get(id) - 1;
      counts.set(id, remaining);
      if (remaining === 0) queue.push(id);
    }
  }
  if (queue.length !== counts.size) throw new Error('同步记录存在循环引用。');
}

class Vault {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async exists() {
    try { await fs.access(this.file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async open(password) {
    const envelope = JSON.parse(await fs.readFile(this.file, 'utf8'));
    if (envelope.v !== 1) throw new Error('本地仓库版本不受支持。');
    const key = await derive(password, envelope.salt);
    const state = unseal(key, 'syncssh:local:v1', envelope.data);
    validateEvents(state.events);
    Object.assign(this, { key, salt: envelope.salt, state });
  }

  async create(password, restored = {}) {
    if (await this.exists()) throw new Error('此设备已有本地仓库。');
    const salt = newSalt();
    const key = await derive(password, salt);
    const state = { events: {}, uploaded: {}, pins: {}, sync: null, ...restored };
    validateEvents(state.events);
    await this.write(state, key, salt);
    Object.assign(this, { salt, key, state });
  }

  async write(state, key = this.key, salt = this.salt) {
    const tmp = this.file + '.tmp';
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: 1, salt, data: seal(key, 'syncssh:local:v1', state) }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file);
  }

  transact(change) {
    const task = this.queue.then(async () => {
      const { events, uploaded, pins } = this.state;
      const draft = { ...this.state, events: { ...events }, uploaded: { ...uploaded }, pins: { ...pins } };
      const result = change(draft);
      await this.write(draft);
      this.state = draft;
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  update(records) {
    return this.transact((draft) => {
      const versions = index(draft.events);
      return records.map(({ record, value, parents }) => {
        if (parents?.some((id) => draft.events[id]?.record !== record)) {
          throw new Error('编辑版本无效，请重新打开。');
        }
        const id = uuid();
        draft.events[id] = {
          id, record, value, at: Date.now(),
          parents: parents ?? (versions.get(record) || []).map((head) => head.id)
        };
        return id;
      });
    });
  }
}

module.exports = { Vault, index, validateEvents, uuid, idPattern, hash, derive, newSalt, seal, unseal };
