
const { XMLParser } = require('fast-xml-parser');
const { derive, newSalt, seal, unseal, uuid, idPattern, validateEvents } = require('./vault.cjs');

const markerName = 'repository.json';
const documentLimit = 24 * 1024 ** 2;
const parser = new XMLParser({ removeNSPrefix: true, processEntities: false });

class Dav {
  constructor({ url, username = '', password = '' }) {
    const base = new URL(url);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) {
      throw new Error('WebDAV 需要 HTTPS，本机测试地址可以使用 HTTP。');
    }
    if (base.username || base.password || base.hash || base.search) {
      throw new Error('WebDAV 地址不能带账号、密码、查询参数或锚点。');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    this.root = new URL('syncssh-v1/', base);
    this.auth = username || password ? 'Basic ' + Buffer.from(username + ':' + password).toString('base64') : '';
  }

  async request(method, name, options = {}) {
    const headers = { ...options.headers };
    if (this.auth) headers.Authorization = this.auth;
    let response;
    try {
      response = await fetch(new URL(name, this.root), {
        method, headers, body: options.body, redirect: 'error', signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      throw new Error('WebDAV 无法访问，请检查网络、HTTPS 证书及路径。', { cause: error });
    }
    if (!(options.accept || [200, 201, 204]).includes(response.status)) {
      await response.body?.cancel();
      throw new Error('WebDAV ' + method + ' 返回 HTTP ' + response.status + '。');
    }
    if (!options.read || response.status === 404) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > documentLimit) throw new Error('WebDAV 响应超过大小限制。');
      chunks.push(chunk);
    }
    return { status: response.status, content: Buffer.concat(chunks).toString('utf8') };
  }

  async get(name, optional = false) {
    return this.request('GET', name, { read: true, accept: optional ? [200, 404] : [200] });
  }

  async putNew(name, body) {
    // Stage the request body so readers never see a partially uploaded revision.
    const temporary = 'stage-' + uuid() + '.tmp';
    let moved = false;
    try {
      await this.request('PUT', temporary, { body, headers: { 'Content-Type': 'application/json' } });
      const result = await this.request('MOVE', temporary, {
        accept: [201, 204, 412],
        headers: { Destination: new URL(name, this.root).href, Overwrite: 'F' }
      });
      moved = result.status !== 412;
      return moved;
    } finally {
      if (!moved) await this.request('DELETE', temporary, { accept: [200, 204, 404] }).catch(() => {});
    }
  }

  async probe() {
    const marker = await this.get(markerName, true);
    if (marker.status === 200) await this.list();
    const probe = new Dav({ url: this.root.href });
    probe.auth = this.auth;
    probe.root = marker.status === 200 ? this.root : new URL('../', this.root);
    const folder = 'syncssh-check-' + uuid() + '/';
    const file = folder + 'result.json';
    await probe.request('MKCOL', folder, { accept: [201] });
    try {
      await probe.request('PROPFIND', folder, { headers: { Depth: '1' }, accept: [207] });
      if (!await probe.putNew(file, '{"ok":true}')) throw new Error('WebDAV 测试文件无法创建。');
      if ((await probe.get(file)).content !== '{"ok":true}') throw new Error('WebDAV 测试文件读回不一致。');
    } finally {
      try { await probe.request('DELETE', file, { accept: [200, 204, 404] }); }
      finally { await probe.request('DELETE', folder, { accept: [200, 204, 404] }); }
    }
    return { existing: marker.status === 200 };
  }

  async list() {
    const { content } = await this.request('PROPFIND', '', { headers: { Depth: '1' }, read: true, accept: [207] });
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('WebDAV XML 包含不受支持的声明。');
    const responses = parser.parse(content).multistatus?.response;
    if (!responses) throw new Error('WebDAV 目录响应无效。');
    const ids = new Set();
    for (const entry of [responses].flat()) {
      if (typeof entry.href !== 'string') continue;
      const url = new URL(entry.href, this.root);
      if (!url.pathname.startsWith(this.root.pathname)) continue;
      const name = url.pathname.slice(this.root.pathname.length);
      const id = name.endsWith('.json') && name.slice(0, -5);
      if (id && idPattern.test(id)) ids.add(id);
    }
    return ids;
  }
}

async function openRepository(dav, password, create = false) {
  let marker;
  let key;
  const response = await dav.get(markerName, true);
  if (create) {
    if (response.status === 200) throw new Error('该地址已经有 SyncSSH 仓库，请在新设备上选择恢复。');
    await dav.request('MKCOL', '', { accept: [201, 405] });
    if ((await dav.list()).size) throw new Error('远端已有修订，但仓库标识丢失。请先恢复远端备份。');
    marker = { v: 1, id: uuid(), salt: newSalt() };
    key = await derive(password, marker.salt);
    marker.proof = seal(key, 'syncssh:repository:' + marker.id, { id: marker.id });
    if (!await dav.putNew(markerName, JSON.stringify(marker))) {
      throw new Error('远端仓库已被另一台设备建立。');
    }
  } else {
    if (response.status === 404) throw new Error('远端仓库不存在。请核对 WebDAV 地址。');
    marker = JSON.parse(response.content);
    if (marker.v !== 1 || !idPattern.test(marker.id)) throw new Error('远端仓库格式无效。');
    key = await derive(password, marker.salt);
    if (unseal(key, 'syncssh:repository:' + marker.id, marker.proof).id !== marker.id) {
      throw new Error('远端仓库校验失败。');
    }
  }
  return { marker, key };
}

function eventContext(marker, id) {
  return 'syncssh:event:v1:' + marker.id + ':' + id;
}

async function readEvents(dav, repository, known = {}) {
  const ids = await dav.list();
  const events = {};
  const missing = [...ids].filter((id) => !known[id]);
  for (let i = 0; i < missing.length; i += 6) {
    await Promise.all(missing.slice(i, i + 6).map(async (id) => {
      const { content } = await dav.get(id + '.json');
      events[id] = unseal(repository.key, eventContext(repository.marker, id), JSON.parse(content).data);
    }));
  }
  return { ids, events };
}

async function restore(credentials, password) {
  const dav = new Dav(credentials);
  const repository = await openRepository(dav, password);
  const { ids, events } = await readEvents(dav, repository);
  validateEvents(events);
  return {
    repository,
    state: {
      events, uploaded: Object.fromEntries([...ids].map((id) => [id, true])),
      sync: { ...credentials, marker: repository.marker, minutes: credentials.minutes ?? 5,
        onChange: credentials.onChange ?? true }
    }
  };
}

async function synchronize(vault, repository) {
  const { sync, events: known, uploaded } = vault.state;
  const dav = new Dav(sync);
  const marker = JSON.parse((await dav.get(markerName)).content);
  const expected = repository.marker;
  if (marker.v !== expected.v || marker.id !== expected.id || marker.salt !== expected.salt
    || marker.proof !== expected.proof) throw new Error('远端仓库标识已变化，同步暂停。');

  const { ids, events } = await readEvents(dav, repository, known);
  if (Object.keys(uploaded).some((id) => !ids.has(id))) {
    throw new Error('远端缺少之前同步的修订。请检查 WebDAV 仓库及其备份。');
  }
  validateEvents({ ...known, ...events });

  const received = [...ids].filter((id) => !uploaded[id]);
  if (received.length) {
    await vault.transact((draft) => {
      Object.assign(draft.events, events);
      for (const id of received) draft.uploaded[id] = true;
    });
  }

  const pending = Object.values(known).filter((event) => !ids.has(event.id));
  const acknowledged = [];
  try {
    for (const event of pending) {
      const name = event.id + '.json';
      const context = eventContext(marker, event.id);
      const data = seal(repository.key, context, event);
      if (!await dav.putNew(name, JSON.stringify({ data }))) {
        const existing = unseal(repository.key, context, JSON.parse((await dav.get(name)).content).data);
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('远端修订同名但内容不同。');
      }
      acknowledged.push(event.id);
    }
  } finally {
    if (acknowledged.length) {
      await vault.transact((draft) => {
        for (const id of acknowledged) draft.uploaded[id] = true;
      });
    }
  }
  return { pulled: Object.keys(events).length, pushed: pending.length };
}

module.exports = { Dav, openRepository, restore, synchronize };
