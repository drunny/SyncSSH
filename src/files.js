
'use strict';
const basename = (remote) => remote.slice(remote.lastIndexOf('/') + 1) || '/';
const dirname = (remote) => remote.slice(0, remote.lastIndexOf('/')) || '/';
const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

function showFileState(session) {
  if (activeSession()?.id === session.id) renderFiles();
}
async function navigate(session, directory) {
  const request = Symbol();
  session.directoryRequest = request;
  session.requestedDir = directory;
  session.loading = true;
  session.fileError = '';
  showFileState(session);
  try {
    const result = await api.files(session.id, 'list', directory);
    if (session.directoryRequest !== request) return;
    session.dir = result.dir;
    session.entries = result.entries;
    session.selected = '';
    session.contextItem = null;
    session.scroll = 0;
    session.tree.set(result.dir, result.entries);
    for (let ancestor = result.dir; ancestor !== '/'; ancestor = dirname(ancestor)) session.expanded.add(ancestor);
    session.expanded.add('/');
    if (!session.tree.has('/') && !session.rootPending) {
      session.rootPending = true;
      api.files(session.id, 'list', '/').then(({ entries }) => {
        session.tree.set('/', entries);
        showFileState(session);
      }).catch(() => {}).finally(() => { session.rootPending = false; });
    }
  } catch (error) {
    if (session.directoryRequest === request) session.fileError = error.message;
  } finally {
    if (session.directoryRequest === request) {
      session.loading = false;
      session.requestedDir = null;
      showFileState(session);
    }
  }
}

function renderTree(session) {
  const tree = $('tree');
  const scroll = tree.scrollTop;
  const view = document.createDocumentFragment();
  const visit = (dir, depth) => {
    const row = el('div', undefined, 'tree-row' + (dir === session.dir ? ' current' : ''));
    row.style.paddingLeft = Math.min(depth * 13, 105) + 'px';
    const expanded = session.expanded.has(dir);
    const toggle = button(expanded ? '▾' : '▸', () => toggleTree(), 'small');
    const open = button(basename(dir), () => navigate(session, dir));
    open.title = dir;
    toggle.title = (expanded ? '折叠 ' : '展开 ') + dir;
    toggle.setAttribute('aria-expanded', String(expanded));
    row.append(toggle, open);
    const item = { name: basename(dir), dir: true };
    row.oncontextmenu = (event) => showFileContext(event, session, item, dir);
    view.append(row);
    async function toggleTree() {
      if (expanded) session.expanded.delete(dir);
      else {
        session.expanded.add(dir);
        if (!session.tree.has(dir)) {
          try {
            const result = await api.files(session.id, 'list', dir);
            session.tree.set(dir, result.entries);
          } catch (error) { session.expanded.delete(dir); report(error); }
        }
      }
      showFileState(session);
    }
    if (!expanded || depth >= 64) return;
    const children = new Set((session.tree.get(dir) || []).filter((item) => item.dir)
      .map((item) => joinPath(dir, item.name)));
    for (const known of session.expanded) if (known !== '/' && dirname(known) === dir) children.add(known);
    for (const child of children) visit(child, depth + 1);
    for (const item of (session.tree.get(dir) || []).filter((item) => !item.dir)) {
      const path = joinPath(dir, item.name);
      const file = el('div', undefined, 'tree-row tree-file');
      file.style.paddingLeft = Math.min((depth + 1) * 13 + 14, 119) + 'px';
      const openFile = button('▧ ' + item.name, () => {
        session.contextItem = { item, path };
        for (const row of tree.querySelectorAll('.tree-file')) row.classList.toggle('current', row === file);
        $('sftp-more').disabled = false;
      });
      openFile.title = path;
      file.append(openFile);
      file.ondblclick = () => openRemote(session, item, path).catch(report);
      openFile.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); openRemote(session, item, path).catch(report); } };
      file.oncontextmenu = (event) => showFileContext(event, session, item, path);
      view.append(file);
    }
  };
  if (session?.dir?.startsWith('/')) visit('/', 0);
  tree.replaceChildren(view);
  tree.scrollTop = scroll;
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
}

function renderFiles() {
  const session = activeSession();
  const usable = session?.status === '已连接';
  const path = $('sftp-path');
  if (path.dataset.session !== (session?.id || '') || document.activeElement !== path) {
    path.value = session?.dir === '.' ? '' : session?.dir || '';
  }
  path.dataset.session = session?.id || '';
  $('sftp-server').textContent = session?.profile.name || '';
  $('follow').checked = session?.follow || false;
  for (const id of ['root-dir', 'up', 'refresh', 'mkdir', 'mkfile', 'upload', 'sftp-path', 'file-search', 'follow']) $(id).disabled = !usable;
  const selected = session?.entries.find((item) => item.name === session.selected);
  $('download').disabled = !usable || !selected || !(selected.dir || selected.regular || selected.link);
  $('sftp-more').disabled = !usable || !(selected || session?.contextItem);
  const filter = $('file-search');
  if (filter.dataset.session !== (session?.id || '')) {
    filter.value = session?.filter || '';
    filter.dataset.session = session?.id || '';
  }
  const query = (session?.filter || '').trim().toLowerCase();
  const results = (session?.entries || []).filter((item) => item.name.toLowerCase().includes(query));
  const view = document.createDocumentFragment();
  for (const item of results) {
    const row = el('tr', undefined, item.name === session.selected ? 'selected' : '');
    const name = button('', () => {
      session.selected = item.name;
      session.contextItem = { item, path: joinPath(session.dir, item.name) };
      $('sftp-more').disabled = !usable;
      for (const other of $('file-rows').children) other.classList.toggle('selected', other === row);
      $('download').disabled = !usable || !(item.dir || item.regular || item.link);
    });
    name.append(el('span', item.dir ? '▸' : item.link ? '↗' : '▧', 'file-icon'), document.createTextNode(item.name));
    name.title = item.name;
    const open = () => openRemote(session, item).catch(report);
    row.ondblclick = open;
    row.oncontextmenu = (event) => showFileContext(event, session, item, joinPath(session.dir, item.name));
    name.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); open(); } };
    const cell = el('td');
    cell.append(name);
    row.append(cell, el('td', item.dir ? '—' : sizeLabel(item.size)),
      el('td', Number.isFinite(item.mtime) ? new Date(item.mtime * 1000).toLocaleString() : '—'));
    view.append(row);
  }
  $('file-rows').replaceChildren(view);
  const message = $('file-message');
  message.hidden = results.length > 0 && !session?.fileError;
  message.textContent = session?.fileError || (session?.loading ? '正在读取目录…' :
    !usable ? '连接服务器后浏览远程文件。' : query ? '当前目录没有匹配的文件。' : '此目录为空。');
  message.classList.toggle('error', Boolean(session?.fileError));
  const table = document.querySelector('.file-table');
  table.scrollTop = session?.scroll || 0;
  renderTree(session);
}

function shownDocument() {
  if (active?.kind === 'file') return documents.get(active.id);
  const doc = documents.get(pinned);
  if (doc?.session === active?.id) return doc;
  return null;
}
function sessionLabel(doc) {
  const profile = sessions.get(doc.session)?.profile;
  return profile ? profile.name + ' [' + profile.host + ':' + profile.port + ']' : '';
}
function renderEditor() {
  const doc = shownDocument();
  const current = sessions.get(doc?.session);
  $('editor').hidden = !doc;
  for (const item of documents.values()) item.input.hidden = item !== doc;
  $('split').hidden = !doc;
  $('split').textContent = active?.kind === 'file' ? '与终端分屏' : '移到独立标签';
  if (!doc) return;
  const title = sessionLabel(doc) + ' · ' + doc.path + (doc.dirty ? ' *' : '');
  $('editor-title').textContent = title;
  $('editor-title').title = title;
  $('save-file').disabled = !doc.dirty || doc.saving || current?.status !== '已连接';
  $('save-file').textContent = doc.saving ? '正在保存…' : '保存';
}

async function openRemote(session, item, remote = joinPath(session.dir, item.name)) {
  if (item.dir) { await navigate(session, remote); return; }
  if (!item.regular && !item.link) throw new Error('此文件类型无法编辑。');
  let file;
  try { file = await api.files(session.id, 'read', remote); }
  catch (error) {
    if (item.link) { await navigate(session, remote); return; }
    throw error;
  }
  if (!sessions.has(session.id)) return;
  const id = session.id + ':' + file.path;
  if (!documents.has(id)) {
    const input = el('textarea', undefined, 'editor-input');
    input.setAttribute('aria-label', '编辑 ' + file.path);
    input.setAttribute('wrap', 'off');
    input.spellcheck = false;
    input.value = file.content;
    const doc = {
      id, session: session.id, path: file.path, textareaBase: input.value, revision: file.revision,
      crlf: file.content.includes('\r\n') && !file.content.replace(/\r\n/g, '').includes('\n'),
      mixed: file.content.includes('\r\n') && file.content.replace(/\r\n/g, '').includes('\n'),
      input, dirty: false, saving: false
    };
    input.oninput = () => {
      doc.dirty = input.value !== doc.textareaBase;
      renderEditor();
      renderTabs();
    };
    input.onkeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDocument(doc).catch(report);
      }
    };
    documents.set(id, doc);
    $('editor-buffers').append(input);
  }
  if (activeSession()?.id === session.id) {
    pinned = id;
    activate('ssh', session.id);
    requestAnimationFrame(() => { if (shownDocument()?.id === id) documents.get(id).input.focus(); });
  }
}
function removeDocument(id) {
  documents.get(id)?.input.remove();
  documents.delete(id);
  if (pinned === id) pinned = null;
}
function closeDocument(id) {
  const doc = documents.get(id);
  if (doc.saving) { announce('请等待远程文件保存完成。', true); return; }
  if (doc.dirty && !window.confirm('丢弃「' + basename(doc.path) + '」的未保存草稿？')) return;
  removeDocument(id);
  if (active?.id === id) active = { kind: 'ssh', id: doc.session };
  render();
}
async function saveDocument(doc) {
  if (!doc?.dirty || doc.saving) return;
  if (doc.mixed && !window.confirm('此文件混用了 CRLF 与 LF 换行。保存时将统一为 LF，继续吗？')) return;
  const text = doc.input.value;
  doc.saving = true;
  renderEditor();
  try {
    doc.revision = await api.files(doc.session, 'save', doc.path, {
      content: doc.crlf ? text.replace(/\n/g, '\r\n') : text, revision: doc.revision
    });
    doc.textareaBase = text;
    doc.mixed = false;
    doc.dirty = doc.input.value !== text;
    announce('已保存 ' + basename(doc.path));
    const session = sessions.get(doc.session);
    if (session && session.dir === dirname(doc.path)) navigate(session, session.dir);
  } finally {
    doc.saving = false;
    renderEditor();
    renderTabs();
  }
}

async function downloadRemote(session, remote) {
  const result = await api.download(session.id, remote);
  if (result) announce(result.skipped ? '下载完成 · 跳过 ' + result.skipped + ' 个链接或不兼容的名称' : '下载完成');
}

function showFileContext(event, session, item, remote) {
  event.preventDefault();
  if (session.status !== '已连接') return;
  session.contextItem = { item, path: remote };
  $('sftp-more').disabled = false;
  showFileMenu(session, item, remote, event.clientX, event.clientY);
}

function showFileMenu(session, item, remote, x, y) {
  const root = remote === '/';
  const refresh = async () => {
    for (const dir of session.tree.keys()) {
      if (dir === dirname(remote) || dir === remote || dir.startsWith(remote + '/')) session.tree.delete(dir);
    }
    if (remote === session.dir || session.dir.startsWith(remote + '/')) await navigate(session, dirname(remote));
    else {
      await navigate(session, session.dir);
      if (session.dir !== dirname(remote) && session.expanded.has(dirname(remote))) {
        try {
          const listing = await api.files(session.id, 'list', dirname(remote));
          session.tree.set(dirname(remote), listing.entries);
          showFileState(session);
        } catch {}
      }
    }
  };
  showMenu([
    { label: '打开', action: () => openRemote(session, item, remote) },
    { label: '重命名', disabled: root, action: () => formDialog('重命名远程项目', '新名称', item.name,
      async (name) => { if (name === item.name) return; await api.files(session.id, 'rename', remote, { name }); await refresh(); }) },
    { label: '复制路径', action: async () => { await api['copy-text'](remote); announce('已复制远程路径'); } },
    { label: '更改权限', disabled: root || item.link, action: async () => {
      const attrs = await api.files(session.id, 'stat', remote);
      formDialog('更改远程权限', '八进制权限（如 644、755）', attrs.mode.toString(8), async (value) => {
        if (!/^[0-7]{3,4}$/.test(value)) throw new Error('请输入 3 或 4 位八进制权限。');
        await api.files(session.id, 'chmod', remote, { mode: Number.parseInt(value, 8) });
        announce('权限已更新');
      });
    } },
    { label: '下载到本机', disabled: root || !(item.dir || item.regular || item.link), action: () => downloadRemote(session, remote) },
    { label: '删除', danger: true, disabled: root, action: async () => {
      const prompt = item.dir ? '将递归删除该目录及其内容。' : '将删除该远程文件。';
      if (!await confirmAction('删除远程项目', remote + '\n\n' + prompt, '确认删除', true)) return;
      await api.files(session.id, 'delete', remote, { recursive: item.dir });
      await refresh();
      announce('已删除 ' + remote);
    } }
  ], x, y);
}

function wireFiles() {
  const withSession = (run) => {
    const session = activeSession();
    if (session?.status === '已连接') run(session);
  };
  $('split').onclick = () => {
    const doc = shownDocument();
    if (!doc) return;
    if (active.kind === 'file') {
      pinned = doc.id;
      activate('ssh', doc.session);
      requestAnimationFrame(() => doc.input.focus());
    } else {
      pinned = null;
      activate('file', doc.id);
    }
  };
  $('save-file').onclick = () => saveDocument(shownDocument()).catch(report);
  $('close-file').onclick = () => { const doc = shownDocument(); if (doc) closeDocument(doc.id); };
  $('path-form').onsubmit = (event) => {
    event.preventDefault();
    const dir = $('sftp-path').value;
    if (dir) withSession((session) => navigate(session, dir.startsWith('/') ? dir : joinPath(session.dir, dir)));
    $('sftp-path').blur();
  };
  $('root-dir').onclick = () => withSession((session) => navigate(session, '/'));
  $('up').onclick = () => withSession((session) => navigate(session, dirname(session.dir)));
  $('refresh').onclick = () => withSession((session) => navigate(session, session.dir));
  $('file-search').oninput = () => withSession((session) => {
    session.filter = $('file-search').value;
    session.scroll = 0;
    renderFiles();
  });
  document.querySelector('.file-table').onscroll = (event) => {
    const session = activeSession();
    if (session) session.scroll = event.target.scrollTop;
  };
  $('follow').onchange = () => withSession((session) => {
    session.follow = $('follow').checked;
    if (session.follow && session.cwd) navigate(session, session.cwd);
    else if (session.follow) announce('等待远程终端发送 OSC 7 目录通知。');
  });
  $('mkdir').onclick = () => withSession((session) => {
    const dir = session.dir;
    formDialog('新建远程目录', '目录名称', '', async (name) => {
      if (!name || ['.', '..'].includes(name) || name.includes('/') || name.includes('\0')) throw new Error('请输入单个目录名称。');
      await api.files(session.id, 'mkdir', joinPath(dir, name));
      if (dir === session.dir) await navigate(session, dir);
    });
  });
  $('mkfile').onclick = () => withSession((session) => {
    const dir = session.dir;
    if (!dir.startsWith('/')) { announce('请先打开远程目录。', true); return; }
    formDialog('新建远程文件', '文件名称', '', async (name) => {
      if (!name || ['.', '..'].includes(name) || name.includes('/') || name.includes('\0')) throw new Error('请输入单个文件名称。');
      const remote = joinPath(dir, name);
      await api.files(session.id, 'create', remote);
      if (dir === session.dir) await navigate(session, dir);
    });
  });
  $('sftp-more').onclick = () => withSession((session) => {
    const item = session.contextItem || (() => {
      const item = session.entries.find((entry) => entry.name === session.selected);
      return item && { item, path: joinPath(session.dir, item.name) };
    })();
    if (!item) return;
    const rect = $('sftp-more').getBoundingClientRect();
    showFileMenu(session, item.item, item.path, rect.left, rect.bottom + 3);
  });
  $('upload').onclick = () => withSession(async (session) => {
    const dir = session.dir;
    try {
      if (!dir.startsWith('/')) throw new Error('请先打开一个远程目录。');
      $('upload').disabled = true;
      const result = await api.upload(session.id, dir);
      if (result.length) {
        const failures = result.filter((item) => item.error);
        announce(failures.length ? failures.map((item) => item.name + ' · ' + item.error).join('；')
          : '已上传 ' + result.length + ' 个文件', Boolean(failures.length));
        if (dir === session.dir) navigate(session, dir);
      }
    } catch (error) { report(error); }
    finally { renderFiles(); }
  });
  $('download').onclick = () => withSession(async (session) => {
    try {
      await downloadRemote(session, joinPath(session.dir, session.selected));
    } catch (error) { report(error); }
  });
  const divider = $('pane-divider');
  const pane = document.querySelector('.work-pane');
  const resize = (fraction) => {
    const min = 155 / pane.clientHeight;
    pane.style.setProperty('--terminal-height', Math.max(min, Math.min(1 - min, fraction)) * 100 + '%');
  };
  divider.onpointerdown = (event) => divider.setPointerCapture(event.pointerId);
  divider.onpointermove = (event) => {
    if (divider.hasPointerCapture(event.pointerId)) resize((event.clientY - pane.getBoundingClientRect().top) / pane.clientHeight);
  };
  divider.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    resize((divider.offsetTop - pane.offsetTop + (event.key === 'ArrowUp' ? -16 : 16)) / pane.clientHeight);
  };
}
