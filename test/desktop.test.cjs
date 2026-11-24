
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright-core');
const { sshFixture, davFixture } = require('./fixtures.cjs');

const master = 'Windows local test master passphrase';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9WnV0AAAAASUVORK5CYII=';
const root = path.resolve(__dirname, '..');
const exact = { exact: true };
const btn = (page, name) => page.getByRole('button', { name, exact: true });

async function openDesktop(profile, t) {
  const packaged = process.env.SYNCSSH_TEST_EXECUTABLE;
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [root],
    cwd: root, env: { ...process.env, SYNCSSH_PROFILE: profile, ELECTRON_ENABLE_LOGGING: '1' }
  });
  t.after(async () => {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 25); }).catch(() => {});
    await app.close().catch(() => {});
  });
  const page = await app.firstWindow();
  await page.evaluate(() => {
    window.testTrustPrompts = [];
    const dialog = document.getElementById('trust-dialog');
    new MutationObserver(() => {
      if (!dialog.open) return;
      window.testTrustPrompts.push({ host: dialog.querySelector('.trust-host').textContent, detail: dialog.querySelector('code').textContent });
      [...dialog.querySelectorAll('button')].find(({ textContent }) =>
        ['确认并信任', '仅本次信任'].includes(textContent)).click();
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  });
  page.on('pageerror', (error) => t.diagnostic(error.stack || String(error)));
  page.on('console', (event) => {
    if (event.type() === 'error') t.diagnostic(event.text());
  });
  page.setDefaultTimeout(6500);
  return { app, page };
}

async function profileForm(page, input) {
  await btn(page, '＋ 新建连接').click();
  const form = page.locator('dialog form');
  for (const field of ['name', 'host', 'port', 'username']) {
    await form.locator('[name=' + field + ']').fill(String(input[field]));
  }
  if (input.group) await form.locator('[name=group]').selectOption({ label: input.group });
  if (input.jump) {
    const label = form.locator('[name=jump] option').filter({ hasText: input.jump });
    await form.locator('[name=jump]').selectOption(await label.getAttribute('value'));
  }
  await form.locator('[name=auth]').selectOption(input.auth);
  if (input.auth === 'key') {
    await form.locator('[name=privateKey]').fill(input.privateKey);
    await form.locator('[name=passphrase]').fill(input.passphrase);
  } else {
    await form.locator('[name=password]').fill(input.password);
  }
  await btn(page, '保存连接').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
}
async function davForm(page, options) {
  const form = page.locator('dialog form');
  for (const field of ['url', 'username', 'password', 'minutes']) {
    await form.locator('[name=' + field + ']').fill(String(options[field]));
  }
  await form.locator('input[name=onChange]').setChecked(options.onChange);
  await form.locator('[name=master]').fill(master);
}
const serverButton = (page, name) => page.locator('#server-list .server-main').filter({ hasText: name });
async function connect(page, name) {
  await serverButton(page, name).dblclick();
  await page.waitForFunction((name) => document.querySelector('#footer-ssh').textContent.includes(name + ' · 已连接'), name);
  await page.locator('#file-rows button[title="readme.txt"]').waitFor();
}
async function terminalCommand(page, command) {
  const input = page.locator('.terminal-container:visible .xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction((command) => {
    const session = activeSession();
    const buffer = session.term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer.getLine(i).translateToString(true).includes('received: ' + command)) return true;
    }
    return false;
  }, command);
}
async function seeImage(page) {
  await btn(page, '预览').click();
  await page.waitForFunction(() => {
    const image = document.querySelector('#note-render img');
    return image?.complete && image.naturalWidth === 1;
  });
}
async function pulse(page, state) {
  await page.waitForFunction((target) => document.querySelector('#footer-sync').textContent.includes(target), state);
}

test('Windows desktop creates, connects, edits, saves screenshots, syncs and restores to a second device', { timeout: 110000 }, async (t) => {
  const ssh = await sshFixture();
  const dav = await davFixture();
  t.after(() => { ssh.close(); dav.close(); });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-desktop-'));
  const one = await openDesktop(path.join(temp, 'A'), t);
  const { page } = one;

  await page.getByRole('heading', { name: '创建本地仓库', ...exact }).waitFor();
  await page.locator('input[name=master]').fill(master);
  await page.locator('input[name=confirm]').fill(master);
  await btn(page, '创建仓库').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });

  await btn(page, '＋ 分组').click();
  await page.getByLabel('分组名称').fill('本地运维');
  await page.locator('dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await profileForm(page, { ...ssh.profiles.direct, group: '本地运维' });
  await profileForm(page, { ...ssh.profiles.jump, group: '本地运维' });
  await profileForm(page, { ...ssh.profiles.target, group: '本地运维', jump: '共享跳板' });
  await profileForm(page, { ...ssh.profiles.target, name: '第二目标', group: '本地运维', jump: '共享跳板' });
  await connect(page, '直连主机');
  await terminalCommand(page, 'echo direct');
  const directEditor = page.locator('.editor-input:visible');
  await page.locator('#file-rows button[title="readme.txt"]').dblclick();
  await directEditor.fill('新草稿 direct\n');
  await directEditor.evaluate((field) => field.setSelectionRange(2, 4));
  await btn(page, '移到独立标签').click();
  assert.equal(await directEditor.inputValue(), '新草稿 direct\n');
  assert.deepEqual(await directEditor.evaluate((field) => [field.selectionStart, field.selectionEnd]), [2, 4]);
  await btn(page, '与终端分屏').click();
  assert.deepEqual(await directEditor.evaluate((field) => [field.selectionStart, field.selectionEnd]), [2, 4]);

  await connect(page, '跳板目标');
  await terminalCommand(page, 'echo via-jump');
  await page.locator('#file-rows button[title="readme.txt"]').dblclick();
  assert.equal(await directEditor.inputValue(), 'target text\n');
  await page.locator('#tabs .tab-main').filter({ hasText: 'readme.txt · 直连主机' }).click();
  assert.equal(await directEditor.inputValue(), '新草稿 direct\n');
  assert.deepEqual(await directEditor.evaluate((field) => [field.selectionStart, field.selectionEnd]), [2, 4]);
  await btn(page, '保存').click();
  await page.waitForFunction(() => document.querySelector('#notification').textContent.includes('已保存 readme.txt'));
  assert.equal(ssh.direct.files.get('/home/readme.txt').bytes.toString(), '新草稿 direct\n');

  await page.locator('#tabs .tab-main').filter({ hasText: /^● 跳板目标$/ }).click();
  await page.getByLabel('跟随终端目录').check();
  await terminalCommand(page, 'cd docs');
  await page.waitForFunction(() => document.querySelector('#sftp-path').value === '/home/docs');
  await page.locator('#file-rows button[title="child.txt"]').waitFor();
  await page.getByRole('searchbox', { name: '搜索当前目录' }).fill('unmatched');
  await page.getByText('当前目录没有匹配的文件。', exact).waitFor();
  await page.getByRole('searchbox', { name: '搜索当前目录' }).fill('');

  await page.evaluate(() => {
    const term = activeSession().term;
    const buffer = term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i).translateToString(true);
      if (line.startsWith('received: cd docs')) { term.select(0, i, line.length); return; }
    }
  });
  await btn(page, '选区追加到备忘录').click();
  const note = page.getByLabel('Markdown 备忘录');
  const appended = await note.inputValue();
  assert.match(appended, /received: cd docs/);
  await note.fill('# 本地测试\n\n' + appended);
  await note.evaluate((field, base64) => {
    field.setSelectionRange(field.value.length, field.value.length);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], 'capture.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, png);
  await page.waitForFunction(() => document.querySelector('#note-text').value.includes('syncssh-image:'));
  await btn(page, '保存备忘录').click();
  await page.getByText('备忘录已保存', exact).waitFor();
  await seeImage(page);
  await page.getByRole('heading', { name: '本地测试', ...exact }).waitFor();
  const exportPath = path.join(temp, 'memo.html');
  await one.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await btn(page, '导出为 HTML').click();
  await page.getByText('备忘录已导出为 HTML', exact).waitFor();
  const exported = await fs.readFile(exportPath, 'utf8');
  assert.ok(exported.includes('本地测试') && exported.includes('data:image/png;base64,'));


  await btn(page, '选项').click();
  await page.getByRole('menuitem', { name: /同步设置/ }).click();
  await davForm(page, { ...dav.credentials, minutes: 0 });
  await btn(page, '保存并同步').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await pulse(page, 'WebDAV 已同步');
  assert.equal(dav.objects.size, 8);

  dav.gate.offline = true;
  await btn(page, '编辑').click();
  await note.fill((await note.inputValue()) + '\n离线补传');
  await btn(page, '保存备忘录').click();
  await pulse(page, '同步失败');
  assert.equal(dav.objects.size, 8);
  dav.gate.offline = false;
  await page.waitForFunction(() => document.querySelector('#footer-sync').textContent === 'WebDAV 已同步', null, { timeout: 16000 });
  assert.equal(dav.objects.size, 9);
  await btn(page, '立即同步').click();
  await pulse(page, 'WebDAV 已同步');
  assert.equal(dav.objects.size, 9);

  const two = await openDesktop(path.join(temp, 'B'), t);
  const p2 = two.page;
  await btn(p2, '从 WebDAV 恢复').click();
  await davForm(p2, { ...dav.credentials, minutes: 1 });
  await btn(p2, '恢复仓库').click();
  await p2.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(dav.objects.size, 9);
  await p2.getByText('本地运维', exact).waitFor();
  await btn(p2, '备忘录').click();
  const noteServer = p2.getByLabel('备忘录所属服务器');
  const targetOption = noteServer.locator('option').filter({ hasText: '跳板目标' });
  await noteServer.selectOption(await targetOption.getAttribute('value'));
  assert.match(await p2.getByLabel('Markdown 备忘录').inputValue(), /离线补传/);
  assert.equal(await p2.locator('#footer-ssh').textContent(), '● 未连接');
  await seeImage(p2);
  await btn(p2, '服务器').click();
  await connect(p2, '跳板目标');
  await terminalCommand(p2, 'echo restored-key');
  await connect(p2, '第二目标');
  await connect(p2, '直连主机');
  await terminalCommand(p2, 'echo restored-password');
  assert.equal(ssh.counters.forwarded, 3);
  assert.equal(ssh.counters.keyLogins, 3);
  for (const entry of [one, two]) {
    const prompts = await entry.page.evaluate(() => window.testTrustPrompts);
    assert.deepEqual(new Set(prompts.map(({ host }) => host.split(' · ')[1].split('  [')[0])),
      new Set(['直连主机', '共享跳板', '跳板目标']));
    assert.ok(prompts.every((prompt) => prompt.detail.includes('SHA256:')));
  }
  if (process.env.SYNCSSH_SCREENSHOT) await p2.screenshot({ path: process.env.SYNCSSH_SCREENSHOT });

  await btn(page, '服务器').click();
  await btn(page, '＋ 分组').click();
  await page.getByLabel('分组名称').fill('定时接收验证');
  await page.locator('dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await pulse(page, 'WebDAV 已同步');
  assert.equal(dav.objects.size, 10);
  await p2.waitForFunction(() => groups().some((group) => liveVersion(group).value.name === '定时接收验证'), null, { timeout: 65000 });
  t.after(() => fs.rm(temp, { recursive: true, force: true }).catch(() => {}));
});

test('v1 desktop implements connection probes, server organization, host UI, remote actions, shell tools, monitoring and alarms', { timeout: 55000 }, async (t) => {
  const ssh = await sshFixture();
  const dav = await davFixture();
  t.after(() => { ssh.close(); dav.close(); });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-v1-'));
  const { page } = await openDesktop(path.join(temp, 'A'), t);
  await page.locator('input[name=master]').fill(master);
  await page.locator('input[name=confirm]').fill(master);
  await btn(page, '创建仓库').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#system-clock').textContent(), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(await page.locator('#system-date').textContent(), /年.*月.*日/);
  assert.match(await page.locator('#system-zone').textContent(), /UTC[+−]\d\d:\d\d/);
  const separator = page.getByRole('separator', { name: '调整左区宽度' });
  const beforeWidth = Number(await separator.getAttribute('aria-valuenow'));
  await separator.press('ArrowRight');
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), beforeWidth + 12);
  assert.equal(await page.evaluate(() => pref('sidebar-width', 0)), beforeWidth + 12);

  await btn(page, '选项').click();
  await page.getByRole('menuitem', { name: /同步设置/ }).click();
  await davForm(page, dav.credentials);
  await btn(page, '测试连接').click();
  await page.getByText('WebDAV 读写测试通过，可以创建同步仓库。', exact).waitFor();
  assert.deepEqual([...dav.dirs], ['/dav/']);
  assert.equal(dav.objects.size, 0);
  await btn(page, '取消').click();

  await btn(page, '＋ 新建连接').click();
  const form = page.locator('#dialog form');
  const profile = ssh.profiles.direct;
  for (const field of ['name', 'host', 'port', 'username', 'password']) await form.locator('[name=' + field + ']').fill(String(profile[field]));
  const group = form.locator('[name=group]');
  assert.equal(await group.locator('option').first().textContent(), '新建分组');
  await group.selectOption('__new__');
  await form.getByLabel('新分组名称').fill('收纳组');
  await form.locator('[name=location]').selectOption('JP');
  await btn(page, '显示密码').click();
  assert.equal(await form.locator('[name=password]').getAttribute('type'), 'text');
  await btn(page, '隐藏密码').click();
  await btn(page, '测试连接').click();
  await page.getByText('SSH 认证成功。', exact).waitFor();
  await btn(page, '保存连接').click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await serverButton(page, '直连主机').getByText('JP（日本）', exact).waitFor();
  await btn(page, '＋ 分组').click();
  await page.getByLabel('分组名称').fill('目标组');
  await page.locator('#dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await btn(page, '收纳组').click();
  await serverButton(page, '直连主机').waitFor({ state: 'hidden' });
  await btn(page, '收纳组').click();
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.server-row')].find((item) => item.textContent.includes('直连主机'));
    const target = [...document.querySelectorAll('.group-toggle')].find((item) => item.textContent === '目标组');
    const dataTransfer = new DataTransfer();
    for (const [node, type] of [[row, 'dragstart'], [target, 'dragover'], [target, 'drop'], [row, 'dragend']]) {
      node.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
    }
  });
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.server-row')].find((item) => item.textContent.includes('直连主机'));
    return row?.previousElementSibling.textContent.includes('目标组');
  });
  await page.locator('.server-row', { hasText: '直连主机' }).locator('[title=连接设置]').click();
  await page.locator('#dialog').getByRole('button', { name: '复制', ...exact }).click();
  await serverButton(page, '副本1').waitFor();

  ssh.direct.files.set('/home/.hidden.txt', { bytes: Buffer.from('hidden') });
  const directServer = serverButton(page, '直连主机').first();
  await directServer.click();
  assert.equal(await directServer.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => sessions.size), 0);
  await directServer.dblclick();
  await page.locator('#file-rows button[title="readme.txt"]').waitFor();
  assert.match(await page.locator('#footer-ssh').textContent(), /已连接 · \d\d:\d\d:\d\d/);
  const prompts = await page.evaluate(() => window.testTrustPrompts);
  assert.equal(prompts.length, 2, 'unsaved connection test did not permanently pin the host');
  assert.ok(prompts.every(({ detail }) => detail === ssh.direct.hostFingerprint));

  const hidden = page.locator('#file-rows [title=".hidden.txt"]');
  await hidden.waitFor();
  await btn(page, '文件列表选项').click();
  await page.getByRole('menuitem', { name: /显示隐藏文件/ }).click();
  await hidden.waitFor({ state: 'hidden' });
  const sessionTab = page.locator('#tabs .tab-main').filter({ hasText: '直连主机' });
  await sessionTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制终端' }).click();
  await page.waitForFunction(() => sessions.size === 2 && [...sessions.values()].every((s) => s.status === '已连接'));
  await sessionTab.last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重连' }).click();
  await page.waitForFunction(() => sessions.size === 2 && activeSession()?.status === '已连接');

  await btn(page, '根目录').click();
  await page.waitForFunction(() => document.querySelector('#sftp-path').value === '/');
  await page.locator('#file-rows button[title="home"]').dblclick();
  await page.waitForFunction(() => document.querySelector('#sftp-path').value === '/home');
  await btn(page, '新建文件').click();
  await page.getByLabel('文件名称').fill('temp.txt');
  await page.locator('#dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.locator('#tree button[title="/home/temp.txt"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('新名称').fill('renamed.txt');
  await page.locator('#dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  const renamed = page.locator('#file-rows button[title="renamed.txt"]');
  await renamed.click();
  assert.ok((await page.locator('#file-rows tr.selected').textContent()).includes('0644'));
  await btn(page, '文件列表选项').click();
  await page.getByRole('menuitem', { name: /所有者/ }).click();
  assert.ok((await page.locator('#file-rows tr.selected').textContent()).includes('1000'));
  await page.locator('#file-headings [data-column=name] button').click();
  assert.equal(await page.locator('#file-headings [data-column=name]').getAttribute('aria-sort'), 'descending');
  await btn(page, '更多').click();
  await page.getByRole('menuitem', { name: '更改权限' }).click();
  await page.getByLabel('八进制权限（如 644、755）').fill('600');
  await page.locator('#dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(ssh.direct.files.get('/home/renamed.txt').mode, 0o600);
  await renamed.dblclick();
  await btn(page, '关闭').click();
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', ...exact }).click();
  await btn(page, '确认删除').click();
  await renamed.waitFor({ state: 'hidden' });

  await btn(page, '多行命令').click();
  await btn(page, '接入 Bash').click();
  await page.getByRole('textbox', { name: '多行命令内容' }).fill('printf first\nprintf second');
  await btn(page, '执行并收起').click();
  await page.locator('#terminal-tool-panel').waitFor({ state: 'hidden' });
  await terminalCommand(page, 'echo history');
  await btn(page, '最近 20 条命令').click();
  const marker = page.locator('#terminal-tool-panel button').filter({ hasText: 'echo history' });
  await marker.waitFor();
  const before = ssh.counters.keys;
  await marker.click();
  await page.waitForFunction(() => document.querySelector('#terminal-tool-panel').hidden);
  await page.waitForTimeout(200);
  assert.equal(ssh.counters.keys - before, 'echo history'.length);

  await btn(page, '所有服务器状态监控').click();
  const card = page.locator('#monitor-list .monitor-card').filter({ has: page.getByRole('heading', { name: '直连主机', ...exact }) });
  await card.getByRole('button', { name: '安装并启用' }).click();
  await page.getByText('/home/fixture/.SyncSSH', { exact: false }).waitFor();
  await page.locator('#dialog').getByRole('button', { name: '安装并启用' }).click();
  await card.getByText('在线', exact).waitFor();
  assert.equal(ssh.counters.installs, 1);
  await btn(page, '状态').click();
  await page.locator('#status canvas[aria-label=CPU实时曲线]').waitFor();
  await btn(page, '停用监控').click();
  await page.locator('#status').getByText('未启用', exact).waitFor();

  await btn(page, '选项').click();
  await page.getByRole('menuitem', { name: /底色/ }).click();
  await btn(page, '纯黑绿字').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'matrix');
  await btn(page, '选项').click();
  await page.getByRole('menuitem', { name: /自定义背景/ }).click();
  await btn(page, '浅绿背景').click();
  assert.equal(await page.locator('#session-area').getAttribute('data-background'), 'mint');
  assert.equal(await page.locator('.terminal-container:visible .xterm-viewport').evaluate((viewport) => getComputedStyle(viewport).backgroundColor), 'rgba(0, 0, 0, 0)');

  await btn(page, '选项').click();
  await page.getByRole('menuitem', { name: /闹钟/ }).click();
  const alarm = page.getByLabel('系统时间闹钟');
  const future = new Date(Date.now() + 120000);
  await alarm.fill([future.getHours(), future.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':'));
  await page.getByLabel('工作间隔（分钟）').fill('45');
  await page.locator('#dialog').getByRole('button', { name: '保存', ...exact }).click();
  await page.locator('#alarm-countdown').waitFor();
  await page.evaluate(() => {
    clockSettings.nextAlarm = Date.now() - 1;
    clockSettings.breakAt = Date.now() - 1;
    tickClock();
  });
  await page.locator('#rest-dialog[open]').waitFor();
  assert.match(await page.locator('#rest-dialog').evaluate((el) => getComputedStyle(el, '::backdrop').backdropFilter), /blur/);
  await page.keyboard.press('Escape');
  await page.locator('#rest-dialog').waitFor({ state: 'hidden' });
  await page.locator('#alarm-toast').waitFor();
  await page.waitForFunction(() => document.querySelector('#alarm-sound').currentTime > 0.02);
  assert.equal(await page.locator('#alarm-sound').evaluate((sound) => sound.duration), 20);
  await btn(page, '关闭提醒').click();
  t.after(() => fs.rm(temp, { recursive: true, force: true }).catch(() => {}));
});

test('v1.2 desktop queues a batch and restores an encrypted draft after restart with conflict copy', { timeout: 40000 }, async (t) => {
  const ssh = await sshFixture();
  t.after(ssh.close);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-v12-'));
  const profilePath = path.join(temp, 'profile');
  const download = path.join(temp, 'downloads');
  await fs.mkdir(download);
  ssh.direct.files.set('/home/extra.txt', { bytes: Buffer.from('extra') });
  const first = await openDesktop(profilePath, t);
  const p = first.page;
  await p.locator('input[name=master]').fill(master);
  await p.locator('input[name=confirm]').fill(master);
  await btn(p, '创建仓库').click();
  await profileForm(p, ssh.profiles.direct);
  await connect(p, '直连主机');
  await first.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, download);
  await p.locator('#file-rows [title="readme.txt"]').click();
  await p.locator('#file-rows [title="extra.txt"]').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await btn(p, '下载').click();
  await p.locator('#transfer-toggle').click();
  await p.waitForFunction(() => document.querySelectorAll('#transfer-list .transfer-row').length === 2
    && [...document.querySelectorAll('#transfer-list .transfer-state')].every((node) => node.textContent.startsWith('完成')));
  assert.equal(await fs.readFile(path.join(download, 'extra.txt'), 'utf8'), 'extra');
  assert.equal(await fs.readFile(path.join(download, 'readme.txt'), 'utf8'), 'direct text\n');

  await p.locator('#file-rows [title="readme.txt"]').dblclick();
  const draft = 'local unsaved text from v1.2';
  await p.getByLabel('编辑 /home/readme.txt', exact).fill(draft);
  await btn(p, '草稿 · 1').waitFor();
  const encrypted = await fs.readFile(path.join(profilePath, 'vault.json'), 'utf8');
  assert.ok(!encrypted.includes(draft));
  await first.app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 25); });
  await p.waitForEvent('close');
  ssh.direct.files.get('/home/readme.txt').bytes = Buffer.from('remote edited on another machine\n');

  const second = await openDesktop(profilePath, t);
  const restored = second.page;
  await restored.locator('input[name=master]').fill(master);
  await btn(restored, '解锁').click();
  await btn(restored, '草稿 · 1').click();
  await btn(restored, '恢复').click();
  assert.equal(await restored.getByLabel('编辑 /home/readme.txt', exact).inputValue(), draft);
  await btn(restored, '比较与另存').click();
  assert.equal(await restored.getByLabel('远端现有内容', exact).inputValue(), 'remote edited on another machine\n');
  await btn(restored, '另存为远程副本').click();
  await restored.locator('#dialog button').filter({ hasText: /^保存$/ }).click();
  await restored.locator('#dialog').waitFor({ state: 'hidden' });
  assert.equal(ssh.direct.files.get('/home/readme.txt').bytes.toString(), 'remote edited on another machine\n');
  assert.equal(ssh.direct.files.get('/home/readme.txt.copy').bytes.toString(), draft);
  t.after(() => fs.rm(temp, { recursive: true, force: true }).catch(() => {}));
});
