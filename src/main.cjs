
const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Vault, index, uuid, idPattern, derive } = require('./vault.cjs');
const { Dav, openRepository, restore, synchronize } = require('./dav.cjs');
const { Monitor } = require('./monitor.cjs');
const { Sessions, validateKey } = require('./ssh.cjs');

if (process.env.SYNCSSH_PROFILE) app.setPath('userData', path.resolve(process.env.SYNCSSH_PROFILE));
const vault = new Vault(path.join(app.getPath('userData'), 'vault.json'));
const page = path.join(__dirname, 'index.html');
let window;
let repository;
let syncing;
let interval;
let afterChange;
let retry;
let retryDelay = 10000;
let accountBusy = false;
let syncStatus = { state: 'idle' };
const trustQueue = new Map();
const trustRequests = new Map();
const pendingSync = () => Object.values(vault.state.events).filter((event) => !vault.state.uploaded[event.id]).length;

function send(name, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(name, payload);
  }
}

function entries() {
  if (!vault.state) return [];
  return [...index(vault.state.events)].map(([record, versions]) => {
    const [type, id] = record.split(':');
    return { type, id, versions: versions.map(({ id, value, at }) => {
      if (type === 'server' && value) {
        const { password, privateKey, passphrase, ...summary } = value;
        return { id, value: summary, at };
      }
      if (type === 'image' && value) return { id, value: { mime: value.mime }, at };
      return { id, value, at };
    }) };
  });
}

const snapshot = () => ({
  entries: entries(),
  sync: vault.state?.sync ? {
    url: vault.state.sync.url, username: vault.state.sync.username,
    minutes: vault.state.sync.minutes, onChange: vault.state.sync.onChange
  } : null,
  status: { ...syncStatus, pending: vault.state ? pendingSync() : 0 }
});
const changed = () => { reconcileMonitors(); send('state', snapshot()); };

function schedule() {
  clearInterval(interval);
  clearTimeout(afterChange);
  clearTimeout(retry);
  retryDelay = 10000;
  if (vault.state.sync?.minutes) {
    interval = setInterval(() => {
      if (!accountBusy) runSync().catch(() => {});
    }, vault.state.sync.minutes * 60000);
  }
}

function queueSync() {
  if (!vault.state.sync?.onChange) return;
  clearTimeout(afterChange);
  afterChange = setTimeout(() => {
    if (accountBusy) { queueSync(); return; }
    if (syncing) {
      syncing.catch(() => {}).then(() => { if (pendingSync()) queueSync(); });
      return;
    }
    runSync().catch(() => {});
  }, 1200);
}

async function runSync() {
  if (!repository || !vault.state.sync) throw new Error('请先配置 WebDAV。');
  if (syncing) return syncing;
  clearTimeout(retry);
  syncing = (async () => {
    syncStatus = { ...syncStatus, state: 'busy' };
    changed();
    try {
      const result = await synchronize(vault, repository);
      retryDelay = 10000;
      syncStatus = { state: 'ok', time: Date.now(), ...result };
      return result;
    } catch (error) {
      syncStatus = { ...syncStatus, state: 'error', message: error.message };
      if (vault.state.sync.onChange && pendingSync()) {
        retry = setTimeout(() => {
          if (!accountBusy) runSync().catch(() => {});
        }, retryDelay);
        retryDelay = Math.min(120000, retryDelay * 2);
      }
      throw error;
    } finally {
      syncing = null;
      changed();
    }
  })();
  return syncing;
}

function keyFor(profile) {
  return JSON.stringify([profile.host.toLowerCase(), profile.port]);
}
function trustHost(profile, presented, { role, temporary } = {}) {
  const key = keyFor(profile);
  const existing = trustQueue.get(key);
  if (existing) return existing.then(() => trustHost(profile, presented, { role, temporary }));
  const task = (async () => {
    const pinned = vault.state.pins[key];
    if (pinned === presented) return;
    if (pinned) throw new Error('主机指纹已变化，连接被阻止。已保存 ' + pinned + '，服务器提供 ' + presented);
    const id = uuid();
    const allowed = await new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        trustRequests.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => { finish(false); send('trust-expired', id); }, 105000);
      trustRequests.set(id, finish);
      send('trust-request', { id, name: profile.name, host: profile.host, port: profile.port,
        fingerprint: presented, role, temporary });
    });
    if (!allowed) throw new Error('主机指纹未获得信任。');
    if (temporary) return;
    await vault.transact((draft) => { draft.pins[key] = presented; });
  })().finally(() => trustQueue.delete(key));
  trustQueue.set(key, task);
  return task;
}

const sessions = new Sessions({ trust: trustHost, emit: send });
const monitor = new Monitor({ trust: trustHost, emit: (metric) => send('metric', metric) });
const current = (record) => index(vault.state.events).get(record) || [];
function version(record, id) {
  const list = current(record);
  const selected = id ? list.find((event) => event.id === id) : list[0];
  if (!selected?.value) throw new Error('记录不存在或已删除。');
  return selected;
}
function primary(record) {
  const list = current(record);
  if (list.length !== 1 || !list[0].value) throw new Error('记录已删除或存在冲突，请先处理。');
  return list[0].value;
}
function recordId(id) {
  if (!idPattern.test(id)) throw new Error('记录 ID 无效。');
  return id;
}
function limit(value, max, label = '文本') {
  if (typeof value !== 'string' || value.length > max) throw new Error(label + '格式错误或超过限制。');
  return value;
}
function required(value, max, label) {
  const result = limit(value, max, label).trim();
  if (!result) throw new Error('请输入' + label + '。');
  return result;
}

function credentials(input) {
  const result = {
    url: required(input.url, 2048, 'WebDAV 地址'),
    username: limit(input.username || '', 256, 'WebDAV 用户名'),
    password: limit(input.password || '', 2048, 'WebDAV 密码'),
    minutes: Number(input.minutes), onChange: Boolean(input.onChange)
  };
  if (result.username.includes(':') || !Number.isInteger(result.minutes) || result.minutes < 0 || result.minutes > 1440) {
    throw new Error('WebDAV 用户名不能含冒号，间隔为 0–1440 分钟。');
  }
  new Dav(result);
  return result;
}

function authorize(event) {
  return event.sender === window?.webContents && event.senderFrame?.url === pathToFileURL(page).href
    && event.senderFrame.parent === null;
}
function handle(channel, handler, locked = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!authorize(event) || (!locked && !vault.state)) throw new Error('请先解锁仓库。');
      return { result: await handler(...args) };
    } catch (error) {
      return { error: error.message || String(error) };
    }
  });
}
function receive(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (authorize(event) && vault.state) handler(...args);
  });
}

handle('initialize', async () => ({ exists: await vault.exists() }), true);
handle('account', async (mode, password, options) => {
  if (vault.state || accountBusy) throw new Error('仓库已解锁或正在处理。');
  accountBusy = true;
  try {
    if (mode === 'restore') {
      if (await vault.exists()) throw new Error('此设备已有本地仓库。');
      const result = await restore(credentials(options), password);
      await vault.create(password, result.state);
      repository = result.repository;
      syncStatus = { state: 'ok', time: Date.now(), pulled: Object.keys(result.state.events).length, pushed: 0 };
    } else if (mode === 'create') {
      await vault.create(password);
    } else if (mode === 'unlock') {
      await vault.open(password);
      if (vault.state.sync) {
        const { marker } = vault.state.sync;
        repository = { marker, key: await derive(password, marker.salt) };
      }
    } else {
      throw new Error('未知的仓库操作。');
    }
    schedule();
    reconcileMonitors();
    if (mode === 'unlock' && repository) runSync().catch(() => {});
    return snapshot();
  } finally {
    accountBusy = false;
  }
}, true);

handle('trust-response', (id, accepted) => { trustRequests.get(id)?.(accepted === true); });
handle('copy-text', (value) => clipboard.writeText(limit(value, 8192, '复制内容')));
const repositoryMetadata = require('../package.json').repository?.url;
const github = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repositoryMetadata || '') ? repositoryMetadata : null;
handle('app-info', () => ({ version: app.getVersion(), github }));
handle('open-repository', () => { if (github) return shell.openExternal(github); });
handle('pick-background', async () => {
  const result = await dialog.showOpenDialog(window, { title: '选择终端背景', properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (result.canceled) return null;
  const file = result.filePaths[0];
  if ((await fs.stat(file)).size > 20 * 1024 ** 2) throw new Error('图片文件上限为 20 MiB。');
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error('无法打开图片。');
  const { width, height } = image.getSize();
  const scaled = Math.max(width, height) > 1400
    ? image.resize(width >= height ? { width: 1400 } : { height: 1400 }) : image;
  return 'data:image/jpeg;base64,' + scaled.toJPEG(72).toString('base64');
});
handle('note-export', async (name, html) => {
  limit(html, 100 * 1024 ** 2, '导出的 HTML');
  const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
  const result = await dialog.showSaveDialog(window, { title: '导出备忘录', defaultPath: safeName + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, html, { encoding: 'utf8' });
  return true;
});
handle('dav-test', (options) => new Dav(credentials(options)).probe());
handle('settings', async () => vault.state.sync?.password ?? '');
handle('configure', async (options, password, method) => {
  if (syncing || accountBusy) throw new Error('正在同步，请稍后重试。');
  accountBusy = true;
  try {
    const account = credentials(options);
    if (repository) {
      const found = JSON.parse((await new Dav(account).get('repository.json')).content);
      const marker = repository.marker;
      if (found.id !== marker.id || found.salt !== marker.salt || found.proof !== marker.proof || found.v !== marker.v) {
        throw new Error('新地址必须指向当前同步仓库。');
      }
    } else {
      if (!['create', 'join'].includes(method)) throw new Error('请选择建立或连接仓库。');
      const localKey = await derive(password, vault.salt);
      const match = localKey.equals(vault.key);
      localKey.fill(0);
      if (!match) throw new Error('主密码错误。');
      const next = await openRepository(new Dav(account), password, method === 'create');
      await vault.transact((draft) => { draft.sync = { ...account, marker: next.marker }; });
      repository = next;
    }
    if (JSON.stringify(vault.state.sync) !== JSON.stringify({ ...account, marker: repository.marker })) {
      await vault.transact((draft) => { draft.sync = { ...account, marker: repository.marker }; });
    }
    schedule();
    changed();
    return runSync();
  } finally {
    accountBusy = false;
  }
});
handle('sync', () => {
  if (accountBusy) throw new Error('仓库设置正在更新。');
  return runSync();
});

async function update(records) {
  const ids = await vault.update(records);
  changed();
  queueSync();
  return ids;
}
handle('group-save', async (id, name, base) => {
  const record = 'group:' + (id ? recordId(id) : uuid());
  await update([{ record, value: { name: required(name, 100, '分组名称') }, parents: base ? [base] : [] }]);
  return record.split(':')[1];
});
handle('server-get', (id, base) => version('server:' + recordId(id), base).value);
function profileInput(input, id) {
  const value = {
    name: required(input.name, 100, '显示名称'),
    host: required(input.host, 253, '主机地址'),
    port: Number(input.port),
    username: required(input.username, 128, 'SSH 用户'),
    auth: input.auth,
    location: /^[A-Z]{2}$/.test(input.location || '') ? input.location : '',
    group: input.group ? recordId(input.group) : '',
    jump: input.jump ? recordId(input.jump) : ''
  };
  if (/[\/\\\s\[\]\0]/.test(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('请输入主机名或 IP（IPv6 省略方括号）以及有效端口。');
  }
  if (value.group) primary('group:' + value.group);
  if (value.jump && (value.jump === id || primary('server:' + value.jump).jump)) {
    throw new Error('跳板必须是能直连的另一台服务器。');
  }
  if (id && value.jump && entries().some((entry) => entry.type === 'server'
    && entry.versions.some(({ value }) => value?.jump === id))) {
    throw new Error('该服务器已被其他连接引用为跳板。');
  }
  if (input.auth === 'key') {
    value.privateKey = required(input.privateKey, 65536, '私钥') + '\n';
    value.passphrase = limit(input.passphrase || '', 2048, '私钥口令');
    validateKey(value.privateKey, value.passphrase);
  } else if (input.auth === 'password') {
    value.password = limit(input.password || '', 2048, '登录密码');
  } else {
    throw new Error('请选择认证方式。');
  }
  return value;
}
handle('server-save', async (id, input, base) => {
  id = id ? recordId(id) : uuid();
  const value = profileInput(input, id);
  await update([{ record: 'server:' + id, value, parents: base ? [base] : [] }]);
  return id;
});
handle('server-test', async (id, input) => {
  const profile = profileInput(input, id);
  const jump = profile.jump ? primary('server:' + profile.jump) : null;
  const testId = uuid();
  try { await sessions.connect(testId, profile, jump, { mode: 'test' }); }
  finally { sessions.disconnect(testId); }
});
handle('server-copy', async (id, base) => {
  const value = version('server:' + recordId(id), base).value;
  const names = new Set(entries().filter(({ type }) => type === 'server').flatMap(({ versions }) =>
    versions.filter((item) => item.value?.group === value.group).map((item) => item.value?.name)));
  let name;
  for (let n = 1; !name || names.has(name); n++) {
    const suffix = ' 副本' + n;
    name = value.name.slice(0, 100 - suffix.length) + suffix;
  }
  const next = uuid();
  await update([{ record: 'server:' + next, value: { ...value, name }, parents: [] }]);
  return name;
});
handle('server-move', async (id, base, group) => {
  const record = 'server:' + recordId(id);
  const value = version(record, base).value;
  if (group) primary('group:' + recordId(group));
  if (value.group !== group) await update([{ record, value: { ...value, group }, parents: [base] }]);
});
function monitoredProfile(id) {
  const profile = primary('server:' + recordId(id));
  const jump = profile.jump ? primary('server:' + profile.jump) : null;
  if (jump?.jump || id === profile.jump) throw new Error('监控仅支持直连和单跳。');
  return { profile, jump };
}
function reconcileMonitors() {
  if (!vault.state) return;
  const enabled = new Set(vault.state.monitor || []);
  for (const [id] of monitor.jobs) if (!enabled.has(id)) monitor.stop(id);
  for (const id of enabled) {
    try {
      const config = monitoredProfile(id);
      const identity = JSON.stringify([config.profile, config.jump], (field, value) =>
        ['name', 'group', 'location'].includes(field) ? undefined : value);
      monitor.watch(id, () => monitoredProfile(id), identity);
    } catch (error) {
      monitor.stop(id);
      send('metric', { id, state: 'offline', at: Date.now(), message: error.message });
    }
  }
}
handle('monitor-list', () => ({ enabled: vault.state.monitor || [], metrics: monitor.snapshot() }));
handle('monitor-path', (id) => monitor.pathFor(monitoredProfile(id)));
handle('monitor-enable', async (id, expectedPath) => {
  const config = monitoredProfile(id);
  await monitor.install(config, limit(expectedPath, 8192, '安装路径'));
  await vault.transact((draft) => { draft.monitor = [...new Set([...(draft.monitor || []), id])]; });
  reconcileMonitors();
});
handle('monitor-disable', async (id) => {
  await vault.transact((draft) => { draft.monitor = (draft.monitor || []).filter((item) => item !== id); });
  monitor.stop(id);
});
handle('import-key', async () => {
  const result = await dialog.showOpenDialog(window, { title: '选择可导出的 SSH 私钥', properties: ['openFile'] });
  if (result.canceled) return null;
  const file = result.filePaths[0];
  if ((await fs.stat(file)).size > 65536) throw new Error('私钥文件超过 64 KiB。');
  return fs.readFile(file, 'utf8');
});
handle('delete-record', async (type, id, base) => {
  if (!['group', 'server'].includes(type)) throw new Error('无法删除该类型的记录。');
  if (entries().some((entry) => entry.type === 'server' && entry.versions.some(({ value }) =>
    (type === 'group' ? value?.group : value?.jump) === id))) {
    throw new Error('该记录仍被服务器引用。请先解除引用。');
  }
  const record = type + ':' + recordId(id);
  version(record, base);
  await update([{ record, value: null, parents: [base] }]);
  if (type === 'server' && vault.state.monitor?.includes(id)) {
    await vault.transact((draft) => { draft.monitor = draft.monitor.filter((item) => item !== id); });
    monitor.stop(id);
  }
});
handle('note-save', async (id, text, base, attachments) => {
  const note = { record: 'note:' + recordId(id), value: { text: limit(text, 512 * 1024, '备忘录') }, parents: base ? [base] : [] };
  if (!Array.isArray(attachments) || attachments.length > 12) throw new Error('单次保存最多添加 12 张图片。');
  const images = attachments.map(({ id: image, mime, data }) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)
      || !/^[a-z0-9+/]+={0,2}$/i.test(limit(data, 7 * 1024 ** 2, '图片'))) throw new Error('仅支持常见图片，单张上限 5 MiB。');
    return { record: 'image:' + recordId(image), value: { mime, data }, parents: [] };
  });
  const ids = await update([...images, note]);
  return ids.at(-1);
});
handle('image-get', async (id) => version('image:' + recordId(id)).value);
handle('resolve-record', async (type, id, chosen, parents) => {
  if (!['group', 'server', 'note'].includes(type)) throw new Error('无法处理该记录。');
  const record = type + ':' + recordId(id);
  const heads = current(record);
  const selected = heads.find(({ id }) => id === chosen);
  if (heads.length < 2 || heads.length !== parents?.length || !heads.every(({ id }) => parents.includes(id)) || !selected) {
    throw new Error('冲突版本已变化，请重新选择。');
  }
  await update([{ record, value: selected.value, parents }]);
});
handle('pins', () => vault.state.pins);
handle('forget-pin', async (key) => {
  const choice = await dialog.showMessageBox(window, { type: 'warning', message: '清除已保存的主机指纹？',
    detail: key + '\n重连时请从可信渠道核对新指纹。', buttons: ['取消', '清除'], defaultId: 0, cancelId: 0 });
  if (choice.response === 1) await vault.transact((draft) => { delete draft.pins[key]; });
  return vault.state.pins;
});

handle('connect', async (id, profileId, base) => {
  const profile = version('server:' + recordId(profileId), base).value;
  const jump = profile.jump ? primary('server:' + profile.jump) : null;
  if (jump?.jump || profileId === profile.jump) throw new Error('仅支持单台跳板。');
  await sessions.connect(recordId(id), profile, jump);
});
handle('disconnect', (id) => sessions.disconnect(id));
receive('input', (id, data) => {
  if (typeof data === 'string' && data.length <= 1024 ** 2) sessions.input(id, data);
});
receive('ack', (id, size) => {
  if (Number.isInteger(size) && size > 0) sessions.acknowledge(id, size);
});
receive('resize', (id, cols, rows) => {
  if ([cols, rows].every((n) => Number.isInteger(n) && n > 0 && n < 2000)) sessions.resize(id, cols, rows);
});
handle('files', (id, op, remote, options) => {
  if (!['list', 'read', 'save', 'mkdir', 'create', 'stat', 'rename', 'chmod', 'delete'].includes(op)) throw new Error('未知文件操作。');
  limit(remote, 8192, '远程路径');
  if (op === 'rename') limit(options?.name, 255, '文件名');
  if (op === 'save') limit(options?.content, 2 * 1024 ** 2, '远程文本');
  return sessions.files(id, op, remote, options);
});
handle('upload', async (id, dir) => {
  const result = await dialog.showOpenDialog(window, { title: '选择上传文件', properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];
  const results = [];
  for (const file of result.filePaths) {
    const name = path.basename(file);
    try {
      await sessions.files(id, 'upload', path.posix.join(dir, name), { local: file });
      results.push({ name });
    } catch (error) {
      results.push({ name, error: error.message });
    }
  }
  return results;
});
handle('download', async (id, remote) => {
  const name = path.posix.basename(remote).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const result = await dialog.showSaveDialog(window, { title: '下载远程文件', defaultPath: name });
  if (result.canceled) return false;
  const skipped = await sessions.files(id, 'download', remote, { local: result.filePath });
  return { skipped };
});

function createWindow() {
  window = new BrowserWindow({
    title: 'SyncSSH', width: 1360, height: 900, minWidth: 860, minHeight: 560,
    backgroundColor: '#101722', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  let safeToClose = false;
  window.on('close', (event) => {
    if (safeToClose || !vault.state) return;
    event.preventDefault();
    send('before-close');
  });
  receive('request-close', () => window.close());
  receive('force-close', () => {
    safeToClose = true;
    window.close();
  });
  window.loadFile(page);
}
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    monitor.close();
    for (const finish of trustRequests.values()) finish(false);
    clearInterval(interval);
    clearTimeout(afterChange);
    clearTimeout(retry);
    for (const id of sessions.sessions.keys()) sessions.disconnect(id);
  });
}
