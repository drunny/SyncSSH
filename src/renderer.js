
'use strict';
const api = window.syncssh;
const $ = (id) => document.getElementById(id);
const dlg = $('dialog');
const workspace = $('workspace');
let state = { entries: [], sync: null, status: {} };
let panel = 'servers';
let selectedHost;
let active;
let pinned;
let accountDialog = false;
const sessions = new Map();
const documents = new Map();
const locations = [['', '未设置'], ['CN', 'CN（中国）'], ['US', 'US（美国）'], ['JP', 'JP（日本）'],
  ['UK', 'UK（英国）'], ['HK', 'HK（中国香港）'], ['SG', 'SG（新加坡）'], ['DE', 'DE（德国）'],
  ['CA', 'CA（加拿大）'], ['AU', 'AU（澳大利亚）'], ['NL', 'NL（荷兰）'], ['KR', 'KR（韩国）']];
const locationLabel = (code) => locations.find(([region]) => region === code)?.[1] || code;
let draggedServer;
let collapsedGroups;
function addGroupDrop(node, group) {
  node.ondragover = (event) => {
    if (!draggedServer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-target');
  };
  node.ondragleave = (event) => { if (!node.contains(event.relatedTarget)) node.classList.remove('drop-target'); };
  node.ondrop = (event) => {
    if (!draggedServer) return;
    event.preventDefault();
    const { id, base } = draggedServer;
    draggedServer = null;
    api['server-move'](id, base, group).then(() => announce('已移动连接')).catch(report).finally(renderServerList);
  };
}

function el(tag, value, cls) {
  const item = document.createElement(tag);
  if (value !== undefined) item.textContent = value;
  if (cls) item.className = cls;
  return item;
}
function button(value, action, cls) {
  const item = el('button', value, cls);
  item.type = 'button';
  item.onclick = action;
  return item;
}
function announce(message, error = false) {
  const bar = $('notification');
  bar.textContent = message || '';
  bar.title = message || '';
  bar.classList.toggle('error', error);
}
function report(error) { announce(error.message || String(error), true); }
function showDialog(body) {
  dlg.replaceChildren(body);
  if (!dlg.open) dlg.showModal();
}
function closeDialog() {
  if (dlg.open) dlg.close();
  dlg.replaceChildren();
}
function formObject(form) {
  const fields = Object.fromEntries(new FormData(form));
  if (form.elements.onChange) fields.onChange = form.elements.onChange.checked;
  return fields;
}
function submit(form, action) {
  form.onsubmit = async (event) => {
    event.preventDefault();
    const controls = [...form.querySelectorAll('button')].filter((item) => !item.disabled);
    const errorBox = form.querySelector('.dialog-error');
    if (errorBox) errorBox.textContent = '';
    controls.forEach((item) => { item.disabled = true; });
    form.dataset.busy = '1';
    try { await action(formObject(form)); }
    catch (error) { if (errorBox) errorBox.textContent = error.message; else report(error); }
    finally {
      controls.forEach((item) => { item.disabled = false; });
      delete form.dataset.busy;
    }
  };
}
dlg.addEventListener('cancel', (event) => {
  if (accountDialog || dlg.querySelector('form[data-busy]')) event.preventDefault();
  else { event.preventDefault(); closeDialog(); }
});

function account(mode) {
  accountDialog = true;
  const view = $('account-form').content.cloneNode(true);
  const form = view.querySelector('form');
  const title = mode === 'unlock' ? '解锁本地仓库' : mode === 'create' ? '创建本地仓库' : '恢复同步仓库';
  view.querySelector('[data-account-title]').textContent = title;
  view.querySelector('[data-account-info]').textContent = mode === 'restore'
    ? '使用同一个 WebDAV 地址及第一台电脑的仓库主密码。'
    : mode === 'create' ? '可先离线添加连接和备忘录。同步时会用此主密码加密。' : '输入仓库主密码，打开连接与备忘录。';
  const confirm = view.querySelector('[data-confirm]');
  confirm.hidden = mode !== 'create';
  confirm.querySelector('input').disabled = mode !== 'create';
  const davFields = view.querySelector('[data-dav-fields]');
  if (mode === 'restore') {
    davFields.append($('dav-fields').content.cloneNode(true));
    davFields.hidden = false;
  }
  const swap = view.querySelector('[data-switch]');
  swap.hidden = mode === 'unlock';
  swap.textContent = mode === 'restore' ? '返回创建' : '从 WebDAV 恢复';
  swap.onclick = () => account(mode === 'restore' ? 'create' : 'restore');
  view.querySelector('[data-account-submit]').textContent = mode === 'unlock' ? '解锁' : mode === 'create' ? '创建仓库' : '恢复仓库';
  submit(form, async (data) => {
    if (mode === 'create' && data.master !== data.confirm) throw new Error('两次主密码输入不一致。');
    state = await api.account(mode, data.master, data);
    accountDialog = false;
    closeDialog();
    workspace.inert = false;
    loadMonitors().catch(report);
    render();
  });
  showDialog(view);
  form.elements[mode === 'restore' ? 'url' : 'master'].focus();
}

const records = (type) => state.entries.filter((entry) => entry.type === type && entry.versions.some(({ value }) => value));
const record = (type, id) => state.entries.find((item) => item.type === type && item.id === id);
const liveVersion = (entry) => entry?.versions.find(({ value }) => value);
const servers = () => records('server');
const groups = () => records('group');
const activeSession = () => active?.kind === 'ssh' ? sessions.get(active.id) : sessions.get(documents.get(active?.id)?.session);
const hostId = () => activeSession()?.profileId || selectedHost;
const hostName = (id) => liveVersion(record('server', id))?.value.name || activeSession()?.profile.name || '服务器';

function switchPanel(name) {
  panel = name;
  for (const tab of document.querySelectorAll('[data-panel]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.panel === name));
    $(tab.dataset.panel).hidden = tab.dataset.panel !== name;
  }
  renderNotes();
  renderStatus();
  renderMonitorList();
}
function renderServerList() {
  if (draggedServer) return;
  const list = $('server-list');
  const query = $('server-search').value.trim().toLowerCase();
  list.replaceChildren();
  const available = servers().filter((entry) => {
    const { name, host, username, group, location } = liveVersion(entry).value;
    return [name, host, username, locationLabel(location), liveVersion(record('group', group))?.value.name || '']
      .join(' ').toLowerCase().includes(query);
  });
  const sections = [...groups().sort((a, b) => liveVersion(a).value.name.localeCompare(liveVersion(b).value.name)), null];
  for (const group of sections) {
    const members = available.filter((item) => {
      const id = liveVersion(item).value.group;
      return group ? id === group.id : !sections.some((section) => section?.id === id);
    });
    if (!members.length && (!group && !draggedServer || query)) continue;
    const target = group?.id || '';
    const collapsed = !query && collapsedGroups.has(target);
    const row = el('div', undefined, 'group-row');
    row.dataset.group = target;
    const fold = button(group ? liveVersion(group).value.name : '未分组', () => {
      if (collapsed) collapsedGroups.delete(target); else collapsedGroups.add(target);
      savePref('groups', [...collapsedGroups]);
      renderServerList();
    }, 'group-toggle');
    fold.setAttribute('aria-expanded', String(!collapsed));
    fold.setAttribute('aria-label', group ? liveVersion(group).value.name : '未分组');
    row.append(fold);
    if (!group || group.versions.length === 1) addGroupDrop(row, target);
    if (group) {
      const edit = button(group.versions.length > 1 ? '有冲突' : '⋯', () =>
        group.versions.length > 1 ? showConflict(group) : groupDialog(group), 'small row-detail');
      edit.title = '分组设置';
      row.append(edit);
    }
    list.append(row);
    if (collapsed) continue;
    for (const entry of members) {
      const v = liveVersion(entry);
      const value = v.value;
      const main = button('', () => {
        selectedHost = entry.id;
        if (entry.versions.length > 1) showConflict(entry);
        else openSession(entry, v).catch(report);
      }, 'server-main' + (hostId() === entry.id ? ' current' : ''));
      main.append(el('strong', value.name), el('span', value.username + '@' + value.host +
        (value.port === 22 ? '' : ':' + value.port) + (value.jump ? ' · 跳板' : '')));
      if (value.location) {
        const place = el('span', locationLabel(value.location), 'location-chip');
        main.append(place);
      }
      main.title = entry.versions.length > 1 ? '处理同步冲突' : '连接 ' + value.name;
      const edit = button(entry.versions.length > 1 ? '有冲突' : '⋯', () => {
        if (entry.versions.length > 1) showConflict(entry);
        else serverDialog(entry).catch(report);
      }, 'small row-detail');
      edit.title = '连接设置';
      const shell = el('div', undefined, 'server-row');
      shell.append(main, edit);
      if (entry.versions.length === 1) {
        shell.draggable = true;
        shell.ondragstart = (event) => {
          draggedServer = { id: entry.id, base: v.id };
          event.dataTransfer.setData('text/plain', entry.id);
          event.dataTransfer.effectAllowed = 'move';
          list.querySelectorAll('[data-empty-drop]').forEach((item) => { item.hidden = false; });
        };
        shell.ondragend = () => { draggedServer = null; renderServerList(); };
      }
      if (!group || group.versions.length === 1) addGroupDrop(shell, target);
      list.append(shell);
    }
  }
  if (!list.querySelector('.server-row') && !groups().length) list.append(el('p', query ? '没有匹配的连接' : '还没有保存的连接', 'empty muted'));
  if (!list.querySelector('[data-group=""]')) {
    const drop = el('div', '拖到这里移出分组', 'group-row empty-drop');
    drop.dataset.emptyDrop = '1';
    drop.hidden = !draggedServer;
    addGroupDrop(drop, '');
    list.append(drop);
  }
}

function formDialog(heading, fieldLabel, initial, onSave, onDelete) {
  const view = document.createDocumentFragment();
  const form = el('form', undefined, 'dialog-form');
  const label = el('label', fieldLabel);
  const input = el('input');
  input.name = 'value';
  input.value = initial;
  input.required = true;
  label.append(input);
  const actions = el('div', undefined, 'dialog-actions');
  if (onDelete) {
    actions.append(button('删除', async () => {
      if (!window.confirm('删除「' + initial + '」？')) return;
      try { await onDelete(); closeDialog(); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; }
    }, 'danger'));
  }
  const save = el('button', '保存', 'primary');
  actions.append(button('取消', closeDialog), save);
  form.append(label, el('div', undefined, 'dialog-error'), actions);
  view.append(el('h1', heading), form);
  submit(form, async ({ value }) => { await onSave(value); closeDialog(); });
  showDialog(view);
  input.focus();
  input.select();
}
function groupDialog(entry) {
  const version = liveVersion(entry);
  formDialog(entry ? '编辑分组' : '新建分组', '分组名称', version?.value.name || '',
    (name) => api['group-save'](entry?.id, name, version?.id),
    entry && (() => api['delete-record']('group', entry.id, version.id)));
}

function options(select, placeholder, choices, selected) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const entry of choices) {
    const value = liveVersion(entry).value;
    select.add(new Option(value.name + (entry.type === 'server' ? ' · ' + value.host : ''), entry.id));
  }
  if (selected && !choices.some(({ id }) => id === selected)) {
    select.add(new Option('引用不可用，请重新选择', selected));
  }
  select.value = selected || '';
}
async function serverDialog(entry) {
  const version = liveVersion(entry);
  const data = entry ? await api['server-get'](entry.id, version.id) : null;
  const view = $('server-form').content.cloneNode(true);
  view.querySelector('h1').textContent = entry ? '编辑连接' : '新建连接';
  const form = view.querySelector('form');
  const fields = form.elements;
  if (data) {
    for (const field of ['name', 'host', 'port', 'username', 'auth', 'password', 'passphrase', 'privateKey']) {
      fields[field].value = data[field] ?? '';
    }
  }
  const groupChoices = () => groups().filter((item) => item.versions.length === 1);
  const setGroups = (selected) => {
    options(fields.group, '未分组', groupChoices(), selected);
    fields.group.add(new Option('新建分组', '__new__'), fields.group.firstElementChild);
  };
  setGroups(data?.group);
  const addGroup = el('input');
  addGroup.placeholder = '输入新分组名称';
  addGroup.setAttribute('aria-label', '新分组名称');
  addGroup.hidden = true;
  fields.group.parentElement.append(addGroup);
  fields.group.onchange = () => {
    addGroup.required = fields.group.value === '__new__';
    addGroup.hidden = !addGroup.required;
    if (addGroup.required) addGroup.focus();
  };
  for (const [code, label] of locations) fields.location.add(new Option(label, code));
  fields.location.value = data?.location || '';
  const eye = view.querySelector('[data-eye]');
  eye.onclick = () => {
    const show = fields.password.type === 'password';
    fields.password.type = show ? 'text' : 'password';
    eye.title = show ? '隐藏密码' : '显示密码';
    eye.setAttribute('aria-label', eye.title);
    eye.classList.toggle('visible-password', show);
  };
  options(fields.jump, '直连', servers().filter((item) => entry?.id !== item.id
    && item.versions.length === 1 && !liveVersion(item).value.jump), data?.jump);
  const pass = view.querySelector('[data-password]');
  const key = view.querySelector('[data-key]');
  const auth = () => {
    key.hidden = fields.auth.value !== 'key';
    pass.hidden = !key.hidden;
  };
  fields.auth.onchange = auth;
  auth();
  view.querySelector('[data-import]').onclick = async () => {
    try {
      const imported = await api['import-key']();
      if (imported) fields.privateKey.value = imported;
    } catch (error) { form.querySelector('.dialog-error').textContent = error.message; }
  };
  const duplicate = view.querySelector('[data-copy]');
  duplicate.hidden = !entry;
  duplicate.onclick = async () => {
    duplicate.disabled = true;
    try { const name = await api['server-copy'](entry.id, version.id); closeDialog(); announce('已复制为 ' + name); }
    catch (error) { form.querySelector('.dialog-error').textContent = error.message; }
    finally { duplicate.disabled = false; }
  };
  const testConnection = view.querySelector('[data-test]');
  testConnection.onclick = () => testForm(form, testConnection, async (input) => {
    if (input.group === '__new__') input.group = '';
    input.name ||= '待保存连接';
    await api['server-test'](entry?.id, input);
    return input.jump ? '跳板及目标主机认证成功。' : 'SSH 认证成功。';
  }, ['host', 'port', 'username']);
  const del = view.querySelector('[data-delete]');
  del.hidden = !entry;
  del.onclick = async () => {
    if (!window.confirm('删除「' + data.name + '」连接？')) return;
    try { await api['delete-record']('server', entry.id, version.id); closeDialog(); }
    catch (error) { form.querySelector('.dialog-error').textContent = error.message; }
  };
  view.querySelector('[data-cancel]').onclick = closeDialog;
  submit(form, async (input) => {
    if (input.group === '__new__') {
      input.group = await api['group-save'](null, addGroup.value);
      setGroups(input.group);
      fields.group.onchange();
    }
    selectedHost = await api['server-save'](entry?.id, input, version?.id);
    closeDialog();
    render();
  });
  showDialog(view);
  fields.name.focus();
}

function showConflict(entry) {
  const view = document.createDocumentFragment();
  view.append(el('h1', '同步冲突'), el('p', '选择要保留的版本。处理前，各设备会保留所有版本。', 'muted'));
  const body = el('div', undefined, 'dialog-form');
  const errorBox = el('div', undefined, 'dialog-error');
  const parents = entry.versions.map(({ id }) => id);
  for (const item of entry.versions) {
    const card = el('div', undefined, 'status-card');
    card.append(el('h2', new Date(item.at).toLocaleString() + ' · ' + item.id.slice(0, 8)));
    const value = item.value;
    const description = !value ? '已删除' : entry.type === 'note' ? value.text
      : entry.type === 'group' ? value.name : value.name + '\n' + value.username + '@' + value.host + ':' + value.port +
        '\n认证方式 ' + (value.auth === 'key' ? '私钥' : '密码') + '\n跳板 ' + (value.jump ? hostName(value.jump) : '直连');
    card.append(el('pre', description, 'conflict-preview'));
    card.append(button('保留此版本', async () => {
      if (!window.confirm('确认保留此版本？')) return;
      try {
        await api['resolve-record'](entry.type, entry.id, item.id, parents);
        closeDialog();
      } catch (error) { errorBox.textContent = error.message; }
    }));
    body.append(card);
  }
  body.append(errorBox, button('关闭', closeDialog));
  view.append(body);
  showDialog(view);
}
async function settingsDialog() {
  const view = document.createDocumentFragment();
  const form = el('form', undefined, 'dialog-form');
  form.append($('dav-fields').content.cloneNode(true));
  if (state.sync) {
    const password = await api.settings();
    for (const key of ['url', 'username', 'minutes']) form.elements[key].value = state.sync[key];
    form.elements.password.value = password;
    form.elements.onChange.checked = state.sync.onChange;
  } else {
    const modeLabel = el('label', '仓库操作');
    const method = el('select');
    method.name = 'method';
    method.add(new Option('创建新的远程仓库', 'create'));
    method.add(new Option('连接已有远程仓库并合并本地记录', 'join'));
    modeLabel.append(method);
    const key = el('label', '仓库主密码');
    const master = el('input');
    master.name = 'master';
    master.type = 'password';
    master.required = true;
    master.minLength = 12;
    key.append(master);
    form.append(modeLabel, key);
  }
  const actions = el('div', undefined, 'dialog-actions');
  const testDav = button('测试连接', () => testForm(form, testDav, async (input) => {
    const result = await api['dav-test'](input);
    return result.existing ? 'WebDAV 读写测试通过，已找到同步仓库。' : 'WebDAV 读写测试通过，可以创建同步仓库。';
  }, ['url', 'minutes']));
  actions.append(testDav, button('取消', closeDialog), el('button', '保存并同步', 'primary'));
  form.append(el('div', undefined, 'dialog-error'), actions);
  view.append(el('h1', 'WebDAV 同步'), form);
  submit(form, async (data) => {
    const result = await api.configure(data, data.master, data.method);
    closeDialog();
    announce('同步完成 · 接收 ' + result.pulled + ' · 发送 ' + result.pushed);
  });
  showDialog(view);
}
function renderStatus() {
  if (panel !== 'status') return;
  const info = $('status-detail');
  const scroll = info.scrollTop;
  info.replaceChildren();
  const id = hostId();
  if (id) info.append(monitorCard(id, false));
  const session = activeSession();
  const details = [
    ['当前连接', session ? session.profile.name + ' · ' + session.status : '尚未连接'],
    ['连接方式', session ? (session.profile.jump ? '经 ' + hostName(session.profile.jump) : '直连') : '—'],
    ['WebDAV', state.sync?.url || '尚未配置'],
    ['同步状态', state.status.message || (state.status.state === 'busy' ? '正在同步'
      : state.status.time ? new Date(state.status.time).toLocaleString() : '等待同步')],
    ['待同步修订', String(state.status.pending || 0)]
  ];
  for (const [label, description] of details) {
    const card = el('div', undefined, 'status-card');
    card.append(el('h2', label), el('p', description, 'muted'));
    info.append(card);
  }
  info.scrollTop = scroll;
}
async function showPins() {
  const pins = await api.pins();
  const view = document.createDocumentFragment();
  view.append(el('h1', '主机指纹'));
  const body = el('div', undefined, 'dialog-form');
  for (const [key, finger] of Object.entries(pins)) {
    const [host, port] = JSON.parse(key);
    const card = el('div', undefined, 'status-card');
    card.append(el('h2', host + ':' + port), el('p', finger, 'muted mono'));
    card.append(button('清除此指纹', async () => {
      try { await api['forget-pin'](key); await showPins(); } catch (error) { report(error); }
    }, 'danger small'));
    body.append(card);
  }
  if (!Object.keys(pins).length) body.append(el('p', '本机尚未信任 SSH 主机。', 'muted'));
  body.append(button('关闭', closeDialog));
  view.append(body);
  showDialog(view);
}

async function openSession(entry, version, duplicate = false) {
  const existing = [...sessions.values()].find((item) => item.profileId === entry.id && item.status !== '已断开');
  if (existing && !duplicate) { activate('ssh', existing.id); return; }
  const id = crypto.randomUUID();
  const node = el('div', undefined, 'terminal-container');
  const viewport = el('div');
  node.append(viewport);
  $('terminals').append(node);
  const term = new Terminal({
    cursorBlink: true, fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, lineHeight: 1.12,
    allowProposedApi: false, allowTransparency: true, scrollback: 8000, theme: terminalPalette()
  });
  const fit = new FitAddon.FitAddon();
  const session = {
    id, node, term, fit, version: version.id, profileId: entry.id, profile: version.value,
    status: '正在连接', dir: '.', entries: [], tree: new Map(), expanded: new Set(['/']),
    fileError: '', selected: '', loading: false, follow: false, cwd: null
  };
  sessions.set(id, session);
  activate('ssh', id);
  term.loadAddon(fit);
  term.open(viewport);
  term.writeln('正在连接 ' + session.profile.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '') + '…');
  term.onData((data) => { if (session.status === '已连接') api.input(id, data); });
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
  term.onSelectionChange(renderAppend);
  term.parser.registerOscHandler(7, (data) => {
    try {
      const url = new URL(data);
      if (url.protocol !== 'file:') return false;
      const cwd = decodeURIComponent(url.pathname);
      if (!cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 8192) return false;
      session.cwd = cwd;
      if (session.follow && session.dir !== cwd && session.requestedDir !== cwd) navigate(session, cwd);
      return true;
    } catch { return false; }
  });
  bindShell(session);
  await connectSession(session);
}

async function connectSession(session) {
  const { id, term } = session;
  try {
    await api.connect(id, session.profileId, session.version);
    if (!sessions.has(id) || session.status === '已断开') return;
    session.status = '已连接';
    session.connectedAt = Date.now();
    session.shellReady = false;
    api.resize(id, term.cols, term.rows);
    navigate(session, session.dir);
    render();
  } catch (error) {
    session.status = '已断开';
    announce(error.message, true);
    render();
  }
}

async function reconnectSession(session) {
  if (session.reconnecting || session.status === '正在连接') return;
  session.reconnecting = true;
  session.status = '正在连接';
  session.pendingCommand = null;
  session.shellReady = false;
  session.connectedAt = null;
  session.cwd = null;
  closeTerminalTool();
  render();
  try {
    await api.disconnect(session.id);
    session.term.writeln('\r\n[SyncSSH] 正在重连…');
    if (sessions.has(session.id)) await connectSession(session);
  } finally { session.reconnecting = false; }
}

function activate(kind, id) {
  if (active?.id !== id) closeTerminalTool();
  active = { kind, id };
  if (kind === 'ssh') selectedHost = sessions.get(id)?.profileId;
  noteTarget = null;
  render();
  const session = activeSession();
  if (kind === 'ssh') requestAnimationFrame(() => { if (active?.id === id) session.term.focus(); });
  else requestAnimationFrame(() => { if (active?.id === id) documents.get(id)?.input.focus(); });
}
function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  const dirty = [...documents.values()].filter((doc) => doc.session === id && (doc.dirty || doc.saving));
  if (dirty.some((doc) => doc.saving)) { announce('请等待远程文件保存完成。', true); return; }
  if (dirty.length && !window.confirm('关闭会话并丢弃此会话的未保存文件草稿？')) return;
  for (const doc of documents.values()) if (doc.session === id) removeDocument(doc.id);
  sessions.delete(id);
  session.term.dispose();
  session.node.remove();
  api.disconnect(id).catch(report);
  if (active?.id === id || !active?.id || (active?.kind === 'file' && !documents.has(active.id))) {
    closeTerminalTool();
    const next = [...sessions.keys()].at(-1);
    active = next ? { kind: 'ssh', id: next } : null;
    noteTarget = null;
  }
  render();
}

function renderTabs() {
  const tabs = $('tabs');
  const tab = (kind, id, label, status, close) => {
    const row = el('div', undefined, 'tab' + (active?.id === id || (kind === 'file' && pinned === id && shownDocument()?.id === id) ? ' selected' : ''));
    const main = button('', () => activate(kind, id), 'tab-main');
    if (kind === 'ssh') main.append(el('span', '● ', 'dot ' + (status === '已连接' ? 'online' : status === '已断开' ? 'offline' : '')));
    main.append(document.createTextNode(label));
    main.title = label;
    const remove = button('×', close, 'small');
    remove.setAttribute('aria-label', '关闭 ' + label);
    row.append(main, remove);
    if (kind === 'ssh') {
      row.oncontextmenu = (event) => {
        event.preventDefault();
        const session = sessions.get(id);
        const entry = record('server', session.profileId);
        const selected = liveVersion(entry);
        showMenu([
          { label: '复制终端', disabled: !selected || entry.versions.length > 1 || status !== '已连接',
            action: () => openSession(entry, selected, true) },
          { label: '重连', disabled: status === '正在连接', action: () => reconnectSession(session) },
          { label: '关闭', action: close }
        ], event.clientX, event.clientY);
      };
    }
    return row;
  };
  tabs.replaceChildren();
  for (const session of sessions.values()) tabs.append(tab('ssh', session.id, session.profile.name, session.status, () => closeSession(session.id)));
  for (const doc of documents.values()) {
    tabs.append(tab('file', doc.id, basename(doc.path) + ' · ' + sessionLabel(doc) + (doc.dirty ? ' *' : ''), '', () => closeDocument(doc.id)));
  }
}
function renderAppend() {
  const session = activeSession();
  $('append').disabled = active?.kind !== 'ssh' || !session?.term.hasSelection();
}
function fitTerminal() {
  const session = activeSession();
  if (active?.kind === 'ssh' && session?.node.clientWidth && session?.term.element) session.fit.fit();
}
function renderWorkTop() {
  for (const session of sessions.values()) session.node.hidden = active?.kind !== 'ssh' || active.id !== session.id;
  $('terminals').hidden = active?.kind === 'file';
  $('terminal-empty').hidden = Boolean(active);
  renderTabs();
  renderEditor();
  renderAppend();
  requestAnimationFrame(fitTerminal);
}
function renderFooter() {
  renderConnectionTime();
  const { state: status, pending, message } = state.status;
  $('footer-sync').textContent = !state.sync ? '本地加密' : status === 'busy' ? '正在同步…' :
    status === 'error' ? '同步失败 · 待同步 ' + pending : pending ? '待同步 ' + pending : 'WebDAV 已同步';
  $('footer-sync').title = message || '';
  $('sync-now').disabled = !state.sync || status === 'busy';
}
function render() {
  renderServerList();
  renderWorkTop();
  renderFiles();
  renderNotes();
  renderStatus();
  renderMonitorList();
  renderTerminalTools();
  renderFooter();
}

document.addEventListener('DOMContentLoaded', async () => {
  api.on('state', (next) => { state = next; if (!workspace.inert) render(); });
  api.on('output', ({ id, data }) => {
    const session = sessions.get(id);
    if (session) {
      const bytes = new Uint8Array(data);
      session.term.write(bytes, () => api.ack(id, bytes.length));
    }
  });
  api.on('closed', ({ id, reason }) => {
    const session = sessions.get(id);
    if (!session || session.reconnecting) return;
    session.status = '已断开';
    session.connectedAt = null;
    session.pendingCommand = null;
    closeTerminalTool();
    session.term.writeln('\r\n[SyncSSH] ' + reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''));
    render();
  });
  api.on('before-close', () => {
    if ([...documents.values(), ...noteDrafts.values()].some((item) => item.saving)) {
      announce('请等待保存完成。', true);
      return;
    }
    if ([...documents.values(), ...noteDrafts.values()].some((item) => item.dirty)
      && !window.confirm('关闭 SyncSSH 并丢弃未保存草稿？')) return;
    api['force-close']();
  });
  $('add-group').onclick = () => groupDialog();
  $('add-server').onclick = $('empty-add').onclick = () => serverDialog().catch(report);
  $('server-search').oninput = renderServerList;
  $('settings').onclick = () => settingsDialog().catch(report);
  $('sync-now').onclick = async () => {
    try {
      const result = await api.sync();
      announce('同步完成 · 接收 ' + result.pulled + ' · 发送 ' + result.pushed);
    } catch (error) { report(error); }
  };
  $('show-pins').onclick = () => showPins().catch(report);
  for (const tab of document.querySelectorAll('[data-panel]')) tab.onclick = () => switchPanel(tab.dataset.panel);
  new ResizeObserver(fitTerminal).observe($('terminals'));
  collapsedGroups = new Set(pref('groups', []));
  wireFiles();
  wireNotes();
  wireDesktopTools();
  wireTerminalTools();
  try { account((await api.initialize()).exists ? 'unlock' : 'create'); }
  catch (error) {
    showDialog(el('p', error.message, 'error'));
  }
});
