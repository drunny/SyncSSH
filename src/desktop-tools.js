'use strict';

function pref(name, fallback) {
  try { return JSON.parse(localStorage.getItem('syncssh:' + name)) ?? fallback; }
  catch { return fallback; }
}
function savePref(name, value) {
  try { localStorage.setItem('syncssh:' + name, JSON.stringify(value)); }
  catch { announce('本地设置空间已满，此次选择仅在当前窗口生效。', true); }
}

async function testForm(form, control, task, requiredFields) {
  if (form.dataset.busy) return;
  for (const name of requiredFields) if (!form.elements[name].reportValidity()) return;
  const message = form.querySelector('.dialog-error');
  control.disabled = true;
  message.textContent = '正在测试连接…';
  message.classList.add('success');
  try { message.textContent = await task(formObject(form)); }
  catch (error) { message.textContent = error.message; message.classList.remove('success'); }
  finally { control.disabled = false; }
}

const menu = $('popup-menu');
let menuTrigger;
function closeMenu(restoreFocus = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus && menuTrigger?.isConnected) menuTrigger.focus();
}
function showMenu(items, x, y, above = false, trigger = document.activeElement) {
  menuTrigger = trigger;
  menu.replaceChildren(...items.map(({ label, action, disabled, danger }) => {
    const item = button(label, () => {
      closeMenu();
      Promise.resolve().then(action).catch(report);
    }, danger ? 'danger' : '');
    item.disabled = !!disabled;
    item.setAttribute('role', 'menuitem');
    return item;
  }));
  menu.hidden = false;
  menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(above ? y - menu.offsetHeight : y, innerHeight - menu.offsetHeight - 6)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus();
}

const trustPanel = $('trust-dialog');
const trustPrompts = [];
function displayTrust() {
  if (trustPanel.open || $('rest-dialog').open || !trustPrompts.length) return;
  const host = trustPrompts[0];
  const badge = el('div', '◆', 'trust-shield');
  badge.setAttribute('aria-hidden', 'true');
  const heading = el('h1', '核对 SSH 主机指纹');
  heading.id = 'trust-title';
  const detail = el('p', host.role + ' · ' + host.name + '  [' + host.host + ']:' + host.port, 'trust-host');
  const value = el('code', host.fingerprint);
  const copy = button('复制', async () => {
    try { await api['copy-text'](host.fingerprint); copy.textContent = '已复制'; }
    catch (error) { report(error); }
  }, 'small');
  const key = el('div', undefined, 'fingerprint');
  key.append(value, copy);
  const text = el('p', '请用服务器控制台或管理员提供的值核对指纹，再继续连接。', 'muted');
  const actions = el('div', undefined, 'dialog-actions');
  const deny = button('取消连接', () => finishTrust(false));
  actions.append(deny, button(host.temporary ? '仅本次信任' : '确认并信任', () => finishTrust(true), 'primary'));
  trustPanel.replaceChildren(badge, heading, detail, key, text, actions);
  trustPanel.showModal();
  deny.focus();
}
function finishTrust(approved, expired = false) {
  const host = trustPrompts.shift();
  if (!host) return;
  trustPanel.close();
  if (!expired) api['trust-response'](host.id, approved).catch(report);
  displayTrust();
}

let theme = pref('theme', 'default');
let background = pref('background', { kind: 'none' });
function terminalPalette() {
  if (theme === 'matrix') return { background: '#00000000', foreground: '#75ff91', cursor: '#75ff91',
    selectionBackground: '#2b5838', black: '#000000', brightBlack: '#549e60', green: '#5aff76' };
  if (theme === 'light') return { background: '#ffffff00', foreground: '#172e42', cursor: '#065c4d',
    selectionBackground: '#92cec0', black: '#172e42', brightBlack: '#52677e', blue: '#1756a5' };
  return { background: '#0d131d00', foreground: '#e0e8f2', cursor: '#a9e8ce' };
}
function applyLook() {
  document.documentElement.dataset.theme = theme;
  const area = $('session-area');
  area.dataset.background = background.kind;
  if (background.kind === 'custom' && /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(background.data)) {
    area.style.setProperty('--user-background', 'url("' + background.data + '")');
  } else area.style.removeProperty('--user-background');
  for (const session of sessions.values()) session.term.options.theme = terminalPalette();
}
function chooseTheme() {
  const view = el('div', undefined, 'appearance');
  view.append(el('h1', '底色'));
  for (const [id, name] of [['default', '默认深蓝'], ['light', '白色'], ['matrix', '纯黑绿字']]) {
    const choice = button(name, () => {
      theme = id;
      savePref('theme', theme);
      applyLook();
      closeDialog();
    }, 'theme-choice theme-' + id);
    choice.setAttribute('aria-pressed', String(id === theme));
    view.append(choice);
  }
  showDialog(view);
}
function setBackground(kind, data) {
  background = { kind, data };
  savePref('background', background);
  applyLook();
  closeDialog();
}
function chooseBackground() {
  const view = el('div', undefined, 'appearance');
  view.append(el('h1', '自定义终端背景'));
  view.append(button('使用主题底色', () => setBackground('none')),
    button('深色背景', () => setBackground('dark'), 'background-dark'),
    button('浅绿背景', () => setBackground('mint'), 'background-mint'),
    button('选择本机图片…', async () => {
      try {
        const data = await api['pick-background']();
        if (data) setBackground('custom', data);
      } catch (error) {
        message.textContent = error.message;
      }
    }));
  const message = el('p', '', 'error');
  view.append(message);
  showDialog(view);
}
async function aboutSyncSSH() {
  const info = await api['app-info']();
  const view = el('div', undefined, 'appearance');
  view.append(el('h1', '关于 SyncSSH'), el('p', '版本 ' + info.version), el('p', '作者 Wypum'),
    el('p', '开源软件 · MIT 许可证'),
    info.github ? button('GitHub · ' + info.github, () => api['open-repository']().catch(report))
      : el('p', 'GitHub 仓库地址待公布。', 'muted'),
    button('关闭', closeDialog));
  showDialog(view);
}

const duration = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
function renderConnectionTime() {
  const session = activeSession();
  const footer = $('footer-ssh');
  const elapsed = session?.connectedAt ? ' · ' + duration(Math.floor((Date.now() - session.connectedAt) / 1000) * 1000) : '';
  const text = session ? '● ' + session.profile.name + ' · ' + session.status + elapsed : '● 未连接';
  if (footer.textContent !== text) footer.textContent = text;
  footer.classList.toggle('online', session?.status === '已连接');
}

const restPanel = $('rest-dialog');
let clockSettings = pref('clock', { nextAlarm: 0, interval: 0, restMinutes: 2, breakAt: 0, breakUntil: 0 });
const alarmSound = $('alarm-sound');
function stopChime() {
  alarmSound.pause();
  alarmSound.currentTime = 0;
  $('alarm-toast').hidden = true;
}
function chime(preview = false) {
  if (!preview) $('alarm-toast').hidden = false;
  alarmSound.currentTime = 0;
  alarmSound.play().catch((error) => announce('无法播放闹钟 · ' + error.message, true));
}
function endBreak() {
  if (restPanel.open) restPanel.close();
  displayTrust();
  clockSettings.breakUntil = 0;
  clockSettings.breakAt = clockSettings.interval ? Date.now() + clockSettings.interval * 60000 : 0;
  savePref('clock', clockSettings);
}
function tickClock() {
  const now = Date.now();
  const local = new Date(now);
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'long' }).formatToParts(local);
  const value = (type) => time.find((part) => part.type === type)?.value;
  $('system-clock').textContent = [value('hour'), value('minute'), value('second')].join(':');
  $('system-clock').dateTime = local.toISOString();
  $('system-date').textContent = local.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const offset = -local.getTimezoneOffset();
  const digits = (part) => String(part).padStart(2, '0');
  $('system-zone').textContent = (value('timeZoneName') || '') + ' · UTC' + (offset < 0 ? '−' : '+')
    + digits(Math.floor(Math.abs(offset) / 60)) + ':' + digits(Math.abs(offset) % 60);
  const countdown = $('alarm-countdown');
  if (clockSettings.nextAlarm && now >= clockSettings.nextAlarm) {
    clockSettings.nextAlarm = 0;
    savePref('clock', clockSettings);
    chime();
  }
  countdown.hidden = !clockSettings.nextAlarm;
  if (clockSettings.nextAlarm) countdown.textContent = '⏰ 倒计时：' + duration(clockSettings.nextAlarm - now);
  if (clockSettings.breakUntil && now >= clockSettings.breakUntil) endBreak();
  if (clockSettings.interval && !clockSettings.breakUntil && now >= clockSettings.breakAt) {
    clockSettings.breakUntil = now + clockSettings.restMinutes * 60000;
    savePref('clock', clockSettings);
  }
  if (clockSettings.breakUntil) {
    if (!restPanel.open) restPanel.showModal();
    $('rest-remaining').textContent = '剩余 ' + duration(clockSettings.breakUntil - now);
  }
  renderConnectionTime();
}
function alarmDialog() {
  const heading = el('h1', '闹钟与休息');
  const form = el('form', undefined, 'dialog-form');
  const alarm = el('label', '系统时间闹钟');
  const at = el('input');
  at.type = 'time';
  at.name = 'at';
  if (clockSettings.nextAlarm) {
    const date = new Date(clockSettings.nextAlarm);
    at.value = [date.getHours(), date.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  }
  alarm.append(at);
  const hint = el('p', '闹钟按本机时间提醒一次。留空可关闭。', 'muted helper');
  const grid = el('div', undefined, 'field-grid');
  const number = (name, label, current, min, max) => {
    const wrap = el('label', label);
    const field = el('input');
    Object.assign(field, { type: 'number', name, value: current, min, max, required: true });
    wrap.append(field);
    return wrap;
  };
  grid.append(number('interval', '工作间隔（分钟）', clockSettings.interval, 0, 1440),
    number('rest', '休息时长（分钟）', clockSettings.restMinutes, 1, 120));
  const actions = el('div', undefined, 'dialog-actions');
  actions.append(button('试听', () => { stopChime(); chime(true); }), button('取消', closeDialog), el('button', '保存', 'primary'));
  form.append(alarm, hint, grid, el('p', '工作间隔为 0 时关闭休息提醒。', 'muted helper'),
    el('div', undefined, 'dialog-error'), actions);
  const view = document.createDocumentFragment();
  view.append(heading, form);
  submit(form, async (data) => {
    let nextAlarm = 0;
    if (data.at) {
      const [hours, minutes] = data.at.split(':').map(Number);
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      nextAlarm = next.getTime();
    }
    const interval = Number(data.interval);
    clockSettings = { nextAlarm, interval, restMinutes: Number(data.rest), breakAt: interval ? Date.now() + interval * 60000 : 0, breakUntil: 0 };
    savePref('clock', clockSettings);
    stopChime();
    closeDialog();
    tickClock();
  });
  showDialog(view);
}

let monitored = new Set();
const measurements = new Map();
const samples = new Map();
const pendingMonitors = new Set();
async function loadMonitors() {
  const reply = await api['monitor-list']();
  monitored = new Set(reply.enabled);
  for (const metric of reply.metrics) {
    if (!measurements.has(metric.id) || measurements.get(metric.id).at < metric.at) acceptMetric(metric);
  }
  renderStatus();
  renderMonitorList();
}
function acceptMetric(metric) {
  measurements.set(metric.id, metric);
  if (metric.state === 'online') {
    const history = samples.get(metric.id) || [];
    history.push(metric.sample);
    if (history.length > 30) history.shift();
    samples.set(metric.id, history);
  }
  if (panel === 'status') renderStatus();
  if (panel === 'monitor-panel') renderMonitorList();
}
async function toggleMonitor(id) {
  if (pendingMonitors.has(id)) return;
  pendingMonitors.add(id);
  renderStatus();
  renderMonitorList();
  try {
    if (monitored.has(id)) {
      await api['monitor-disable'](id);
      monitored.delete(id);
      measurements.delete(id);
      samples.delete(id);
    } else {
      const location = await api['monitor-path'](id);
      const accepted = await confirmAction('安装 Linux 监控组件',
        hostName(id) + '\n' + location + '\n\n安装后，由此设备经 SSH 定时采集。', '安装并启用');
      if (!accepted) return;
      await api['monitor-enable'](id, location);
      monitored.add(id);
    }
  } finally {
    pendingMonitors.delete(id);
    renderStatus();
    renderMonitorList();
  }
}
function confirmAction(title, text, action, danger = false) {
  return new Promise((resolve) => {
    const view = el('div', undefined, 'appearance');
    const actions = el('div', undefined, 'dialog-actions');
    const cancel = button('取消', () => closeDialog());
    const accepted = button(action, () => { dlg.removeEventListener('close', denied); closeDialog(); resolve(true); }, danger ? 'danger' : 'primary');
    const denied = () => resolve(false);
    actions.append(cancel, accepted);
    view.append(el('h1', title), el('p', text, 'confirm-detail'), actions);
    dlg.addEventListener('close', denied, { once: true });
    showDialog(view);
    cancel.focus();
  });
}
const percentage = (value) => Number.isFinite(value) ? value.toFixed(1) + '%' : '—';
const rate = (value) => Number.isFinite(value) ? sizeLabel(value) + '/s' : '—';
function monitorCard(id, compact) {
  const recordEntry = record('server', id);
  const metric = measurements.get(id);
  const enabled = monitored.has(id);
  const pending = pendingMonitors.has(id);
  const sample = metric?.sample;
  const card = el('article', undefined, 'monitor-card');
  const headline = el('div', undefined, 'monitor-heading');
  const label = el('h2', compact ? hostName(id) : '实时遥测');
  const status = !enabled ? '未启用' : metric?.state === 'online' ? '在线' : metric?.state === 'offline' ? '离线' : '正在连接';
  const pill = el('span', status, 'monitor-pill ' + (status === '在线' ? 'online' : 'muted'));
  headline.append(label, pill);
  card.append(headline);
  if (sample) {
    if (!compact) {
      card.append(metricTrend(id, 'CPU', percentage(sample.cpu), ['cpu'], 100),
        metricTrend(id, '网络 ↓ / ↑', rate(sample.rx) + ' / ' + rate(sample.tx), ['rx', 'tx']),
        metricTrend(id, '磁盘读 / 写', rate(sample.read) + ' / ' + rate(sample.write), ['read', 'write']));
    }
    const gauges = compact ? [['CPU', sample.cpu], ['内存', sample.memory], ['磁盘 /', sample.disk]]
      : [['内存', sample.memory], ['磁盘容量 /', sample.disk]];
    for (const [name, value] of gauges) {
      const row = el('div', undefined, 'metric-row');
      row.append(el('span', name), el('strong', percentage(value)));
      const meter = document.createElement('progress');
      meter.max = 100;
      meter.value = value ?? 0;
      meter.setAttribute('aria-label', name);
      row.append(meter);
      card.append(row);
    }
    const io = el('div', undefined, 'metric-details');
    if (compact) io.append(el('span', '网络 ↓ ' + rate(sample.rx) + ' ↑ ' + rate(sample.tx)),
      el('span', '磁盘读 ' + rate(sample.read) + ' · 写 ' + rate(sample.write)));
    io.append(el('span', '内存 ' + sizeLabel(sample.ram) + ' · 根分区 ' + sizeLabel(sample.diskTotal)),
      el('span', '负载 ' + sample.load.toFixed(2) + ' · 运行 ' + duration(sample.uptime * 1000)));
    if (metric.state === 'online') io.append(el('span', '最近采样 ' + new Date(metric.at).toLocaleTimeString()));
    card.append(io);
  }
  if (metric?.message) card.append(el('p', metric.message, 'error helper'));
  const action = button(pending ? '正在处理…' : enabled ? '停用监控' : '安装并启用',
    () => toggleMonitor(id).catch(report), 'small');
  action.disabled = pending || (!enabled && recordEntry?.versions.length !== 1);
  card.append(action);
  return card;
}
function metricTrend(id, name, current, keys, maximum) {
  const row = el('div', undefined, 'metric-row trend-row');
  const canvas = el('canvas', undefined, 'metric-trend');
  canvas.width = 400;
  canvas.height = 48;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', name + '实时曲线');
  const history = samples.get(id) || [];
  const values = keys.flatMap((key) => history.map((sample) => sample[key]).filter(Number.isFinite));
  const ceiling = maximum || Math.max(1, ...values);
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#778b9c45';
  for (const y of [12, 24, 36]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(400, y);
    ctx.stroke();
  }
  keys.forEach((key, index) => {
    ctx.strokeStyle = index ? '#eaab56' : '#38bba4';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    history.forEach((point, i) => {
      if (!Number.isFinite(point[key])) { started = false; return; }
      const x = history.length === 1 ? 397 : 3 + i * 394 / (history.length - 1);
      const y = 45 - 41 * Math.min(1, point[key] / ceiling);
      if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      if (i === history.length - 1) ctx.fillRect(x - 2, y - 2, 4, 4);
      started = true;
    });
    ctx.stroke();
  });
  row.append(el('span', name), el('strong', current), canvas);
  return row;
}
function renderMonitorList() {
  if (panel !== 'monitor-panel') return;
  const body = $('monitor-list');
  const scroll = body.scrollTop;
  const cards = servers().map((entry) => monitorCard(entry.id, true));
  body.replaceChildren(...(cards.length ? cards : [el('p', '请先添加服务器。', 'empty muted')]));
  body.scrollTop = scroll;
}

function wireDesktopTools() {
  applyLook();
  api.on('trust-request', (host) => { trustPrompts.push(host); displayTrust(); });
  api.on('trust-expired', (id) => {
    const index = trustPrompts.findIndex((host) => host.id === id);
    if (index === 0) finishTrust(false, true);
    else if (index > 0) trustPrompts.splice(index, 1);
  });
  api.on('metric', acceptMetric);
  trustPanel.oncancel = (event) => { event.preventDefault(); finishTrust(false); };
  restPanel.oncancel = (event) => { event.preventDefault(); endBreak(); displayTrust(); };
  $('rest-skip').onclick = () => { endBreak(); displayTrust(); };
  $('alarm-dismiss').onclick = stopChime;
  $('alarm-countdown').onclick = alarmDialog;
  const settings = $('options-menu');
  settings.onclick = () => {
    if (!menu.hidden && menuTrigger === settings) { closeMenu(); return; }
    const bounds = settings.getBoundingClientRect();
    showMenu([
      { label: '⏰  闹钟', action: alarmDialog },
      { label: '◐  底色', action: chooseTheme },
      { label: '▧  自定义背景', action: chooseBackground },
      { label: '↻  同步设置', action: settingsDialog },
      { label: 'ⓘ  关于 SyncSSH', action: aboutSyncSSH },
      { label: '↪  退出', action: () => api['request-close']() }
    ], bounds.left, bounds.top - 4, true, settings);
  };
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target) && !menuTrigger?.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(true); }
    if (!menu.hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      event.preventDefault();
    }
  });
  wireSidebarResize();
  tickClock();
  setInterval(tickClock, 500);
}

function wireSidebarResize() {
  const divider = $('sidebar-divider');
  const grid = document.querySelector('.work-grid');
  const sidebar = document.querySelector('.sidebar');
  const min = 190;
  const maximum = () => Math.max(min, Math.min(540, grid.clientWidth - 470));
  let preferred = pref('sidebar-width', 260);
  if (!Number.isFinite(preferred)) preferred = 260;
  const resize = (width, remember = false) => {
    const max = maximum();
    const current = Math.round(Math.max(min, Math.min(max, width)));
    grid.style.setProperty('--sidebar-width', current + 'px');
    divider.setAttribute('aria-valuemin', String(min));
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(current));
    if (remember) { preferred = current; savePref('sidebar-width', preferred); }
  };
  divider.onpointerdown = (event) => {
    if (event.button === 0) divider.setPointerCapture(event.pointerId);
  };
  divider.onpointermove = (event) => {
    if (divider.hasPointerCapture(event.pointerId)) resize(event.clientX - grid.getBoundingClientRect().left);
  };
  divider.onlostpointercapture = () => resize(sidebar.offsetWidth, true);
  divider.onkeydown = (event) => {
    const bumps = { ArrowLeft: -12, ArrowRight: 12 };
    if (!(event.key in bumps) && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resize(event.key === 'Home' ? min : event.key === 'End' ? maximum() : sidebar.offsetWidth + bumps[event.key], true);
  };
  new ResizeObserver(() => resize(preferred)).observe(grid);
  resize(preferred);
}
