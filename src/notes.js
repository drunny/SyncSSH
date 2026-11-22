
'use strict';
const noteDrafts = new Map();
const imageCache = new Map();
const noteInput = $('note-text');
const preview = $('note-render');
let noteId;
let noteTarget;
let notePreview = false;
let previewRequest = 0;
let renderedDraft;
let renderedText;

function getDraft(id) {
  const entry = record('note', id);
  const base = liveVersion(entry);
  let draft = noteDrafts.get(id);
  if (!draft || (!draft.dirty && !draft.saving && draft.base !== base?.id)) {
    draft = { id, base: base?.id, text: base?.value.text || '', dirty: false, saving: false, attachments: [] };
    noteDrafts.set(id, draft);
  }
  return draft;
}
function captureNote() {
  const draft = noteDrafts.get(noteId);
  if (draft) {
    draft.start = noteInput.selectionStart;
    draft.end = noteInput.selectionEnd;
    draft.scroll = noteInput.scrollTop;
  }
}
function renderNotes() {
  if (panel !== 'notes') return;
  const choices = servers();
  const selected = noteTarget || hostId();
  const id = choices.some((entry) => entry.id === selected) ? selected : choices[0]?.id;
  const buttonSave = $('note-save');
  const buttonPreview = $('note-preview');
  const buttonExport = $('note-export');
  const changedHost = id !== noteId;
  if (changedHost) captureNote();
  noteId = id;
  const select = $('note-host');
  options(select, id ? '选择服务器' : '请先添加服务器', choices, id);
  select.disabled = !id;
  if (id) select.firstElementChild.disabled = true;
  const draft = id ? getDraft(id) : null;
  const entry = record('note', id);
  const conflict = entry?.versions.length > 1;
  if (noteInput.value !== (draft?.text || '') || changedHost) {
    noteInput.value = draft?.text || '';
    noteInput.setSelectionRange(draft?.start || 0, draft?.end || 0);
    noteInput.scrollTop = draft?.scroll || 0;
  }
  noteInput.disabled = !draft;
  noteInput.hidden = notePreview && !!draft;
  preview.hidden = !notePreview || !draft;
  buttonPreview.disabled = !draft;
  buttonExport.disabled = !draft;
  buttonPreview.textContent = notePreview ? '编辑' : '预览';
  buttonSave.disabled = !conflict && (!draft?.dirty || draft?.saving);
  buttonSave.textContent = draft?.saving ? '正在保存…' : conflict ? '备忘录存在同步冲突' : '保存备忘录';
  buttonSave.classList.toggle('conflict', Boolean(conflict));
  if (!preview.hidden && (renderedDraft !== draft.id || renderedText !== draft.text)) renderMarkdown(draft).catch(report);
}
async function renderMarkdown(draft) {
  const request = ++previewRequest;
  renderedDraft = draft.id;
  renderedText = draft.text;
  const tree = await noteMarkup(draft);
  if (request === previewRequest && noteId === draft.id) preview.replaceChildren(tree);
}
async function noteMarkup(draft) {
  const html = marked.parse(draft.text, { gfm: true });
  const imagePath = /^syncssh-image:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
  const tree = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 's', 'code', 'pre', 'ul', 'ol',
      'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'a'],
    ALLOWED_ATTR: ['src', 'alt', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: imagePath
  });
  const pending = [];
  for (const image of tree.querySelectorAll('img')) {
    const match = imagePath.exec(image.getAttribute('src') || '');
    image.removeAttribute('src');
    if (!match) { image.replaceWith(el('span', image.alt || '图片')); continue; }
    const id = match[1];
    const attachment = draft.attachments.find((item) => item.id === id);
    pending.push(Promise.resolve(attachment || imageCache.get(id) || api['image-get'](id)).then(({ mime, data }) => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return;
      if (imageCache.size >= 16) imageCache.delete(imageCache.keys().next().value);
      imageCache.set(id, { mime, data });
      image.src = 'data:' + mime + ';base64,' + data;
    }).catch(() => { image.replaceWith(el('span', '图片暂不可用')); }));
  }
  await Promise.all(pending);
  return tree;
}

async function saveNote() {
  const draft = noteDrafts.get(noteId);
  if (!draft || draft.saving) return;
  const entry = record('note', draft.id);
  if (entry?.versions.length > 1) { showConflict(entry); return; }
  if (!draft.dirty) return;
  const { text, attachments, base } = draft;
  const linked = attachments.filter(({ id }) => text.includes('syncssh-image:' + id));
  draft.saving = true;
  renderNotes();
  try {
    draft.base = await api['note-save'](draft.id, text, base, linked);
    draft.attachments = draft.attachments.filter((item) => !attachments.includes(item));
    draft.dirty = draft.text !== text || draft.attachments.length > 0;
    announce('备忘录已保存');
  } finally {
    draft.saving = false;
    renderNotes();
  }
}

function pasteImage(file, draft) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取截图。'));
    reader.onload = () => {
      const id = crypto.randomUUID();
      const data = reader.result.slice(reader.result.indexOf(',') + 1);
      const text = '![截图](syncssh-image:' + id + ')';
      if (draft.id === noteId && !notePreview) {
        noteInput.setRangeText(text, noteInput.selectionStart, noteInput.selectionEnd, 'end');
        draft.text = noteInput.value;
      } else {
        draft.text += (draft.text ? '\n\n' : '') + text;
      }
      draft.attachments = [...draft.attachments, { id, mime: file.type, data }];
      draft.dirty = true;
      renderNotes();
      resolve();
    };
    reader.readAsDataURL(file);
  });
}
async function exportNote() {
  const draft = noteDrafts.get(noteId);
  if (!draft) return;
  const name = hostName(draft.id) + ' · 备忘录';
  const container = el('main');
  container.append(el('h1', name), await noteMarkup(draft));
  const title = el('title', name);
  const styles = '<style>body{max-width:850px;margin:36px auto;padding:0 20px;font:16px/1.6 system-ui;color:#172b3a}img{max-width:100%}pre{padding:1rem;background:#eef4f8;overflow:auto}table{border-collapse:collapse}th,td{border:1px solid #b4c2d0;padding:.3em .5em}</style>';
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'">';
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + csp + title.outerHTML
    + styles + '</head><body>' + container.outerHTML + '</body></html>';
  if (await api['note-export'](name, html)) announce('备忘录已导出为 HTML');
}

function wireNotes() {
  $('note-export').onclick = () => exportNote().catch(report);
  $('note-host').onchange = (event) => {
    noteTarget = event.target.value;
    renderNotes();
  };
  noteInput.oninput = () => {
    const draft = noteDrafts.get(noteId);
    if (!draft) return;
    draft.text = noteInput.value;
    draft.dirty = true;
    renderNotes();
  };
  noteInput.onkeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNote().catch(report);
    }
  };
  noteInput.onpaste = async (event) => {
    const draft = noteDrafts.get(noteId);
    if (!draft) return;
    const files = [...event.clipboardData.files].filter((item) => item.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    try {
      if (files.length + draft.attachments.length > 12) throw new Error('保存后可继续添加图片，每次最多 12 张。');
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || !file.size || file.size > 5 * 1024 ** 2) {
          throw new Error('支持 PNG、JPEG、WebP、GIF，单张上限 5 MiB。');
        }
        await pasteImage(file, draft);
      }
    } catch (error) { report(error); }
  };
  $('note-preview').onclick = () => {
    notePreview = !notePreview;
    renderNotes();
    if (!notePreview) noteInput.focus();
  };
  $('note-save').onclick = () => saveNote().catch(report);
  $('append').onmousedown = (event) => event.preventDefault();
  $('append').onclick = () => {
    const session = activeSession();
    const selection = session?.term.getSelection();
    if (!selection) return;
    const draft = getDraft(session.profileId);
    const tick = String.fromCharCode(96);
    let width = 3;
    for (const [run] of selection.matchAll(new RegExp(tick + '+', 'g'))) width = Math.max(width, run.length + 1);
    const block = tick.repeat(width);
    draft.text += (draft.text ? '\n\n' : '') + block + '\n' + selection + '\n' + block + '\n';
    draft.dirty = true;
    noteTarget = session.profileId;
    switchPanel('notes');
    announce('选区已追加到备忘录草稿');
  };
}
