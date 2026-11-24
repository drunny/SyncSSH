
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { Vault, index, uuid } = require('../src/vault.cjs');
const { Dav, openRepository, synchronize, restore } = require('../src/dav.cjs');
const { Sessions } = require('../src/ssh.cjs');
const { TransferQueue } = require('../src/transfers.cjs');
const { davFixture, sshFixture } = require('./fixtures.cjs');

const master = 'a unique fixture master phrase';
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait(20);
  }
  assert.ok(check(), 'expected condition before timeout');
}

test('password/direct, encrypted key via jump, host rejection before login, PTY and SFTP on both paths', { timeout: 15000 }, async (t) => {
  const fixture = await sshFixture();
  const pins = new Map([
    [fixture.direct.port, fixture.direct.hostFingerprint], [fixture.jump.port, fixture.jump.hostFingerprint],
    [fixture.target.port, fixture.target.hostFingerprint]
  ]);
  const accepted = [];
  let output = '';
  const sessions = new Sessions({
    trust: async (profile, key) => {
      if (pins.get(profile.port) !== key) throw new Error('指纹不匹配');
      accepted.push(profile.port);
    },
    emit: (type, data) => {
      if (type !== 'output') return;
      output += data.data.toString();
      sessions.acknowledge(data.id, data.data.length);
    }
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-files-'));
  t.after(async () => {
    for (const id of sessions.sessions.keys()) sessions.disconnect(id);
    fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const { profiles, counters } = fixture;
  for (const [id, profile, jump] of [['direct', profiles.direct], ['jumped', profiles.target, profiles.jump]]) {
    await sessions.connect(id, profile, jump);
    sessions.input(id, 'hello ' + id + '\r');
    sessions.resize(id, 100, 30);
    await eventually(() => output.includes('received: hello ' + id));
    const listing = await sessions.files(id, 'list', '.');
    assert.equal(listing.dir, '/home');
    assert.deepEqual(listing.entries.map(({ name }) => name), ['docs', 'readme.txt']);
    const origin = await sessions.files(id, 'read', '/home/readme.txt');
    const content = '汉字 and updated ' + id + '\n';
    const revision = await sessions.files(id, 'save', origin.path, { revision: origin.revision, content });
    assert.deepEqual(await sessions.files(id, 'read', origin.path), { path: origin.path, revision, content });
    await assert.rejects(sessions.files(id, 'save', origin.path, { revision: origin.revision, content: 'stale' }), /远程文件已修改/);
    await sessions.files(id, 'mkdir', '/home/newdir');
    const local = path.join(root, 'download-' + id);
    await sessions.files(id, 'download', origin.path, { local });
    assert.equal(await fs.readFile(local, 'utf8'), content);
    await assert.rejects(sessions.files(id, 'download', origin.path, { local }));
    assert.equal(await fs.readFile(local, 'utf8'), content);
    await sessions.files(id, 'upload', '/home/newdir/upload.txt', { local });
    await assert.rejects(sessions.files(id, 'upload', '/home/newdir/upload.txt', { local }));
    assert.equal((await sessions.files(id, 'read', '/home/newdir/upload.txt')).content, content);
    sessions.disconnect(id);
  }
  assert.deepEqual(accepted, [fixture.direct.port, fixture.jump.port, fixture.target.port]);
  assert.equal(counters.forwarded, 1);
  assert.equal(counters.keyLogins, 1);
  assert.equal(counters.passwordLogins, 2);
  assert.equal(counters.resizes, 2);
  pins.set(fixture.target.port, 'changed');
  await assert.rejects(sessions.connect('target-mismatch', profiles.target, profiles.jump), /指纹不匹配/);
  assert.equal(counters.keyLogins, 1);
  pins.set(fixture.jump.port, 'changed');
  await assert.rejects(sessions.connect('jump-mismatch', profiles.target, profiles.jump), /指纹不匹配/);
  assert.equal(counters.forwarded, 2);
  assert.equal(counters.passwordLogins, 3);
});

test('WebDAV encryption, non-destructive initialization, encrypted restore and concurrent/offline merge', { timeout: 30000 }, async (t) => {
  const dav = await davFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-vault-'));
  t.after(async () => { dav.close(); await fs.rm(root, { recursive: true, force: true }); });
  const local = new Vault(path.join(root, 'first.json'));
  const server = 'server:' + uuid();
  const group = 'group:' + uuid();
  const note = 'note:' + server.split(':')[1];
  const image = 'image:' + uuid();
  const jump = 'server:' + uuid();
  const target2 = 'server:' + uuid();
  const profile = { name: 'private-server-label', host: 'secret-host', auth: 'key',
    privateKey: 'private-rsa-test-payload', password: 'sample-ssh-password', passphrase: 'sample-key-passphrase',
    jump: jump.split(':')[1], group: group.split(':')[1] };
  await local.create(master);
  const first = await openRepository(new Dav(dav.credentials), master, true);
  await local.transact((draft) => { draft.sync = { ...dav.credentials, marker: first.marker }; });
  await local.update([
    { record: group, value: { name: 'private-group-label' } },
    { record: jump, value: { name: 'private-gateway', auth: 'password', password: 'sample-jump-password' } },
    { record: server, value: profile },
    { record: target2, value: { ...profile, name: 'private-server-second' } },
    { record: image, value: { mime: 'image/png', data: 'fake-image-payload' } },
    { record: note, value: { text: 'private-image-note ' + image } }
  ]);
  assert.deepEqual(await synchronize(local, first), { pulled: 0, pushed: 6 });
  const remoteCopy = new Map(dav.objects);
  const combined = [...dav.objects.values()].join('\n') + await fs.readFile(local.file, 'utf8');
  for (const value of ['private-server-label', 'sample-ssh-password', 'private-rsa-test-payload', 'private-image-note',
    'fake-image-payload', 'secret-host', 'dav-only', master]) assert.ok(!combined.includes(value), value);
  await assert.rejects(restore(dav.credentials, 'wrong master password'), /主密码错误/);
  await assert.rejects(openRepository(new Dav(dav.credentials), master, true), /已经有/);
  assert.deepEqual(dav.objects, remoteCopy);

  const second = await restore(dav.credentials, master);
  let restored = new Vault(path.join(root, 'second.json'));
  await restored.create(master, second.state);
  assert.deepEqual(index(restored.state.events).get(server)[0].value, profile);
  assert.equal(index(restored.state.events).get(target2)[0].value.jump, profile.jump);
  assert.equal(index(restored.state.events).get(image)[0].value.data, 'fake-image-payload');
  await assert.rejects(new Vault(restored.file).open('wrong master password'), /主密码错误/);

  dav.gate.offline = true;
  await local.update([{ record: note, value: { text: 'edited device A' } }]);
  await restored.update([{ record: note, value: { text: 'edited device B' } },
    { record: group, value: { name: 'renamed on B' } }]);
  await local.update([{ record: target2, value: { ...profile, name: 'renamed on A' } }]);
  await assert.rejects(synchronize(restored, second.repository), /503/);
  restored = new Vault(restored.file);
  await restored.open(master);
  dav.gate.offline = false;
  await Promise.all([synchronize(local, first), synchronize(restored, second.repository)]);
  await Promise.all([synchronize(local, first), synchronize(restored, second.repository)]);
  for (const vault of [local, restored]) {
    const versions = index(vault.state.events);
    assert.deepEqual(versions.get(note).map(({ value }) => value.text).sort(), ['edited device A', 'edited device B']);
    assert.equal(versions.get(group)[0].value.name, 'renamed on B');
    assert.equal(versions.get(target2)[0].value.name, 'renamed on A');
  }
  const heads = index(local.state.events).get(note);
  await local.update([{ record: note, value: heads[0].value, parents: heads.map(({ id }) => id) }]);
  await synchronize(local, first);
  await synchronize(restored, second.repository);
  assert.equal(index(restored.state.events).get(note).length, 1);

  const existing = [...dav.objects].find(([name]) => !name.endsWith('repository.json'));
  dav.objects.delete(existing[0]);
  await assert.rejects(synchronize(local, first), /远端缺少/);
  dav.objects.set(existing[0], JSON.stringify({ data: Buffer.alloc(64, 1).toString('base64') }));
  await assert.rejects(restore(dav.credentials, master), /加密数据损坏/);
});

test('two initial creators cannot replace the repository marker', { timeout: 10000 }, async (t) => {
  const dav = await davFixture();
  t.after(dav.close);
  const outcomes = await Promise.allSettled([
    openRepository(new Dav(dav.credentials), master, true),
    openRepository(new Dav(dav.credentials), 'another master password', true)
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(dav.objects.size, 1);
});

test('queued SFTP jobs recover verified partial files, reject mismatches and avoid replacing destinations', { timeout: 25000 }, async (t) => {
  const fixture = await sshFixture();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'syncssh-queue-'));
  const input = path.join(folder, 'input.bin');
  const content = Buffer.alloc(780 * 1024);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  await fs.writeFile(input, content);
  let dropId;
  let interruptedAt = 0;
  let resumedAt = 0;
  let observedWaiting = false;
  let damage = false;
  const queue = new TransferQueue({
    trust: async (profile, fingerprint) => {
      assert.equal(fingerprint, [fixture.direct, fixture.jump, fixture.target]
        .find(({ port }) => profile.port === port).hostFingerprint);
    },
    emit: (job) => {
      if (job.id !== dropId) return;
      if (!interruptedAt && job.state === 'running' && job.done > 0) {
        interruptedAt = job.done;
        fixture.disconnectAll();
      } else if (job.state === 'waiting') {
        observedWaiting = true;
        if (damage) {
          const partial = fixture.direct.files.get(queue.jobs.get(job.id).part);
          if (partial?.bytes.length) partial.bytes[0] ^= 0xff;
        }
      } else if (observedWaiting && job.state === 'running' && job.done > 0) resumedAt ||= job.done;
    }
  });
  t.after(async () => {
    queue.close();
    fixture.close();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const direct = fixture.profiles.direct;
  const state = (id) => queue.jobs.get(id)?.state;
  const settle = async (id) => {
    for (let i = 0; i < 380; i++) {
      if (['complete', 'failed', 'canceled'].includes(state(id))) return state(id);
      await wait(30);
    }
    assert.fail('unfinished transfer: ' + JSON.stringify(queue.snapshot()));
  };
  dropId = queue.add('upload', direct, null, '/home/upload.bin', input);
  assert.equal(await settle(dropId), 'complete', JSON.stringify(queue.snapshot()));
  assert.ok(observedWaiting && interruptedAt > 0 && resumedAt >= interruptedAt);
  assert.deepEqual(fixture.direct.files.get('/home/upload.bin').bytes, content);

  const destination = path.join(folder, 'download.bin');
  interruptedAt = resumedAt = 0;
  observedWaiting = false;
  dropId = queue.add('download', direct, null, '/home/upload.bin', destination);
  assert.equal(await settle(dropId), 'complete', JSON.stringify(queue.snapshot()));
  assert.ok(observedWaiting && resumedAt >= interruptedAt);
  assert.deepEqual(await fs.readFile(destination), content);

  interruptedAt = resumedAt = 0;
  observedWaiting = false;
  damage = true;
  dropId = queue.add('upload', direct, null, '/home/damaged.bin', input);
  assert.equal(await settle(dropId), 'failed', JSON.stringify(queue.snapshot()));
  assert.match(queue.jobs.get(dropId).message, /不一致/);
  assert.equal(fixture.direct.files.has('/home/damaged.bin'), false);
  await queue.change(dropId, 'cancel');

  const blocked = queue.add('download', direct, null, '/home/readme.txt', destination);
  assert.equal(await settle(blocked), 'failed');
  assert.deepEqual(await fs.readFile(destination), content);
});
