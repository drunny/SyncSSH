'use strict';

const jobs = new Map();
let draftIndex = [];
let transferOpen = false;
const labels = { queued: '排队', running: '传输中', waiting: '等待重连', failed: '失败', complete: '完成', canceled: '已取消' };
const activeTransfer = (job) => ['queued', 'running', 'waiting'].includes(job.state);

function renderTransferQueue() {
  const count = [...jobs.values()].filter(activeTransfer).length;
  const failed = [...jobs.values()].filter((job) => job.state === 'failed').length;
  const toggle = $('transfer-toggle');
  toggle.textContent = '传输' + (count ? ' · ' + count + ' 进行中' : '') + (failed ? ' · ' + failed + ' 失败' : '');
  toggle.setAttribute('aria-expanded', String(transferOpen));
  $('transfer-body').hidden = !transferOpen;
  if (!transferOpen) return;
  const list = $('transfer-list');
  const scroll = list.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!jobs.size) fragment.append(el('p', '暂无传输任务。', 'muted'));
  for (const job of [...jobs.values()].reverse()) {
    const row = el('div', undefined, 'transfer-row');
    const detail = el('div', undefined, 'transfer-detail');
    const title = el('strong', (job.type === 'upload' ? '上传' : '下载') + ' · ' + job.server + ' · ' + basename(job.remote));
    title.title = job.remote + '\n' + job.local;
    detail.append(title, el('div', job.remote, 'muted'));
    if (job.message) detail.append(el('div', job.message, job.state === 'failed' ? 'danger' : 'muted'));
    const state = el('div', labels[job.state], 'transfer-state');
    if (job.size != null && job.size > 0) {
      const progress = el('progress');
      progress.max = job.size;
      progress.value = job.done;
      progress.setAttribute('aria-label', '传输进度');
      state.append(progress, el('small', sizeLabel(job.done) + ' / ' + sizeLabel(job.size)));
    }
    const actions = el('div', undefined, 'transfer-actions');
    if (job.state === 'failed' && !job.directory) actions.append(button('重试', () => api['transfer-change'](job.id, 'retry').catch(report)));
    if ((activeTransfer(job) || job.state === 'failed') && !(job.directory && job.state === 'running')) {
      actions.append(button('取消', () => api['transfer-change'](job.id, 'cancel').catch(report)));
    }
    row.append(detail, state, actions);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  list.scrollTop = scroll;
}
function acceptTransfer(job) {
  const previous = jobs.get(job.id);
  jobs.set(job.id, job);
  if (job.state === 'complete' && previous?.state !== 'complete' && job.type === 'upload') {
    const current = activeSession();
    if (current?.status === '已连接' && current.route === job.route && dirname(job.remote) === current.dir) {
      navigate(current, current.dir);
    }
  }
  renderTransferQueue();
}
function reportQueued(count) {
  if (count) announce('已加入传输队列 · ' + count + ' 项');
}

const draftTimers = new Map();
const draftWriting = new Map();
const locator = (doc) => ({ server: doc.server, route: doc.route, path: doc.path });
const matchingDraft = (a, b) => a.server === b.server && a.route === b.route && a.path === b.path;

async function refreshDrafts() {
  draftIndex = await api['draft-list']();
  $('drafts').textContent = '草稿' + (draftIndex.length ? ' · ' + draftIndex.length : '');
}
function scheduleDraft(doc) {
  clearTimeout(draftTimers.get(doc.id));
  draftTimers.set(doc.id, setTimeout(() => flushDraft(doc).catch(report), 350));
}
function flushDraft(doc) {
  clearTimeout(draftTimers.get(doc.id));
  draftTimers.delete(doc.id);
  const text = doc.dirty ? doc.input.value : null;
  if (!doc.persisted && text === null && !draftWriting.has(doc.id)) return Promise.resolve();
  const payload = { ...locator(doc), text, revision: doc.revision, crlf: doc.crlf, mixed: doc.mixed };
  const operation = (draftWriting.get(doc.id) || Promise.resolve()).catch(() => {}).then(async () => {
    await api['draft-put'](payload);
    doc.persisted = text !== null;
    await refreshDrafts();
  });
  draftWriting.set(doc.id, operation);
  return operation.finally(() => {
    if (draftWriting.get(doc.id) === operation) draftWriting.delete(doc.id);
  });
}
async function flushFileDrafts() {
  await Promise.all([...documents.values()].map(flushDraft));
}
async function showDrafts() {
  await flushFileDrafts();
  await refreshDrafts();
  const panel = el('div', undefined, 'draft-dialog');
  panel.append(el('h1', '可恢复草稿'));
  if (!draftIndex.length) panel.append(el('p', '暂无草稿。', 'muted'));
  for (const draft of draftIndex) {
    const row = el('div', undefined, 'draft-row');
    const name = liveVersion(record('server', draft.server))?.value.name || '服务器资料已移除';
    row.append(el('strong', name + ' · ' + draft.path), el('p', new Date(draft.savedAt).toLocaleString(), 'muted'));
    row.append(button('恢复', async () => {
      closeDialog();
      try {
        const entry = record('server', draft.server);
        const v = liveVersion(entry);
        if (!v || entry.versions.length !== 1) throw new Error('请先恢复该服务器资料或解决连接资料冲突。');
        await openSession(entry, v);
        const session = activeSession();
        if (session?.profileId !== draft.server || session.status !== '已连接') throw new Error('请连接草稿所属服务器。');
        if (session.route !== draft.route) throw new Error('连接地址或跳板已变化，草稿仍保留。');
        await openRemote(session, { name: basename(draft.path), regular: true }, draft.path, draft);
      } catch (error) { report(error); }
    }), button('删除草稿', async () => {
      if (!window.confirm('删除这份本地草稿？')) return;
      try {
        if ([...documents.values()].some((doc) => doc.dirty && matchingDraft(locator(doc), draft))) {
          throw new Error('草稿正在编辑，请先关闭文件。');
        }
        await api['draft-put']({ ...draft, text: null });
        await showDrafts();
      } catch (error) { report(error); }
    }, 'danger'));
    panel.append(row);
  }
  panel.append(button('关闭', closeDialog));
  showDialog(panel);
}
function exportDraftText(doc) {
  return doc.crlf ? doc.input.value.replace(/\n/g, '\r\n') : doc.input.value;
}
async function compareDraft(doc) {
  const session = sessions.get(doc.session);
  if (session?.status !== '已连接') throw new Error('重新连接后可以比对远端文件。');
  let remote;
  let readable = true;
  try { remote = (await api.files(doc.session, 'read', doc.path)).content; }
  catch (error) { readable = false; remote = '无法读取远端版本 · ' + error.message; }
  const panel = el('div', undefined, 'draft-dialog');
  panel.append(el('h1', '比较草稿与远端'), el('p', doc.path, 'muted'));
  const before = remote.replace(/\r\n/g, '\n').split('\n');
  const after = doc.input.value.split('\n');
  let first = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  let suffix = 0;
  while (suffix < before.length - first && suffix < after.length - first
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const different = readable && (first < before.length || first < after.length);
  if (different) panel.append(el('p', '第 ' + (first + 1) + ' 行起有差异 · 远端 '
    + (before.length - first - suffix) + ' 行 / 草稿 ' + (after.length - first - suffix) + ' 行', 'muted'));
  else if (readable) panel.append(el('p', '文本内容一致。', 'muted'));
  const columns = el('div', undefined, 'diff-panes');
  for (const [name, value] of [['远端现有内容', remote], ['本地草稿', doc.input.value]]) {
    const side = el('section');
    const box = el('textarea');
    box.readOnly = true;
    box.setAttribute('aria-label', name);
    box.value = value;
    side.append(el('h2', name), box);
    columns.append(side);
  }
  panel.append(columns, button('另存为远程副本', () => saveDraftCopy(doc)), button('关闭', closeDialog));
  showDialog(panel);
  if (different) requestAnimationFrame(() => {
    for (const box of columns.querySelectorAll('textarea')) box.scrollTop = Math.max(0, first - 2) * 18;
  });
}
function saveDraftCopy(doc) {
  formDialog('另存为远程副本', '同目录下的新文件名', basename(doc.path) + '.copy', async (name) => {
    if (!name || name === '.' || name === '..' || /[/\0]/.test(name) || name === basename(doc.path)) {
      throw new Error('请输入同一目录下的其他文件名。');
    }
    await api.files(doc.session, 'save-as', joinPath(dirname(doc.path), name), { content: exportDraftText(doc) });
    const session = sessions.get(doc.session);
    if (session?.dir === dirname(doc.path)) await navigate(session, session.dir);
    announce('远程副本已保存。本地草稿仍保留。');
  });
}

function wireWorkspaceV12() {
  $('transfer-toggle').onclick = () => { transferOpen = !transferOpen; renderTransferQueue(); };
  $('transfer-clear').onclick = async () => {
    try {
      const list = await api['transfer-clear']();
      for (const [id, job] of jobs) {
        if (['complete', 'canceled'].includes(job.state) && !list.some((item) => item.id === id)) jobs.delete(id);
      }
      renderTransferQueue();
    } catch (error) { report(error); }
  };
  api.on('transfer', acceptTransfer);
  $('drafts').onclick = () => showDrafts().catch(report);
  $('compare-draft').onclick = () => { const doc = shownDocument(); if (doc) compareDraft(doc).catch(report); };
}
