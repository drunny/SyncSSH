
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const path = require('node:path').posix;
const { Server, utils } = require('ssh2');
const { STATUS_CODE: status, OPEN_MODE: mode } = utils.sftp;
const { fingerprint } = require('../src/ssh.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function davFixture() {
  const objects = new Map();
  const calls = [];
  const gate = { offline: false };
  const expected = 'Basic ' + Buffer.from('fixture:dav-only').toString('base64');
  const dirs = new Set(['/dav/']);
  const server = http.createServer(async (req, res) => {
    const done = (code, body = '') => { res.writeHead(code); res.end(body); };
    const method = req.method;
    const url = req.url;
    calls.push([method, url]);
    if (gate.offline) return done(503);
    if (req.headers.authorization !== expected) return done(401);
    if (!url.startsWith('/dav/')) return done(404);
    if (method === 'MKCOL' && url.endsWith('/')) {
      if (dirs.has(url)) return done(405);
      if (!dirs.has(url.slice(0, url.slice(0, -1).lastIndexOf('/') + 1))) return done(409);
      dirs.add(url);
      return done(201);
    }
    if (method === 'GET') return objects.has(url) ? done(200, objects.get(url)) : done(404);
    if (method === 'PROPFIND' && req.headers.depth === '1') {
      if (!dirs.has(url)) return done(404);
      const listing = [url, ...[...objects.keys()].filter((name) => name.startsWith(url))].map((href) =>
        '<D:response><D:href>' + href + '</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status><D:prop/></D:propstat></D:response>'
      ).join('');
      return done(207, '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' + listing + '</D:multistatus>');
    }
    if (method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(url, Buffer.concat(chunks).toString('utf8'));
      return done(201);
    }
    if (method === 'MOVE') {
      if (!objects.has(url) || req.headers.overwrite !== 'F') return done(400);
      const dest = new URL(req.headers.destination).pathname;
      if (objects.has(dest)) return done(412);
      objects.set(dest, objects.get(url));
      objects.delete(url);
      return done(201);
    }
    if (method === 'DELETE') return done(objects.delete(url) || dirs.delete(url) ? 204 : 404);
    done(405);
  });
  const port = await listen(server);
  return {
    credentials: { url: 'http://127.0.0.1:' + port + '/dav/', username: 'fixture', password: 'dav-only',
      minutes: 5, onChange: true },
    objects, calls, gate, dirs,
    close: () => { server.closeAllConnections(); server.close(); }
  };
}

function encodeString(value) {
  const data = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function enableRename(client) {
  // ssh2's SFTP server emits a bare v3 greeting. Add a real protocol extension for the fixture.
  const protocol = client._protocol;
  const channelData = protocol.channelData;
  protocol.channelData = function (recipient, data) {
    if (data.length === 9 && data[4] === 2 && data.readUInt32BE(5) === 3) {
      const extended = Buffer.concat([Buffer.from(data), encodeString('posix-rename@openssh.com'), encodeString('1')]);
      extended.writeUInt32BE(extended.length - 4);
      return channelData.call(this, recipient, extended);
    }
    return channelData.call(this, recipient, data);
  };
}
function backend(initial) {
  const files = new Map([
    ['/', { dir: true }], ['/home', { dir: true }], ['/home/docs', { dir: true }],
    ['/home/readme.txt', { bytes: Buffer.from(initial) }],
    ['/home/docs/child.txt', { bytes: Buffer.from('child\n') }]
  ]);
  const attrs = (file) => ({ size: file.bytes?.length || 0, uid: 1000, gid: 1000,
    mode: (file.dir ? 0o040000 : 0o100000) | (file.mode ?? 0o644), atime: 1700000000, mtime: 1700000000 });
  function attach(sftp) {
    const handles = new Map();
    let next = 1;
    const canonical = (file) => path.resolve('/home', file);
    const get = (token) => token.length === 4 ? handles.get(token.readUInt32BE(0)) : null;
    const answer = (id, handle) => {
      const key = next++;
      handles.set(key, handle);
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(key);
      sftp.handle(id, buffer);
    };
    const ok = (id) => sftp.status(id, status.OK);
    const missing = (id) => sftp.status(id, status.NO_SUCH_FILE);
    const fail = (id) => sftp.status(id, status.FAILURE);
    const attr = (id, name) => {
      const file = files.get(canonical(name));
      if (file) sftp.attrs(id, attrs(file));
      else missing(id);
    };
    sftp.on('REALPATH', (id, name) => {
      const filename = canonical(name);
      if (files.has(filename)) sftp.name(id, [{ filename, longname: filename, attrs: attrs(files.get(filename)) }]);
      else missing(id);
    });
    sftp.on('STAT', attr).on('LSTAT', attr);
    sftp.on('OPENDIR', (id, name) => {
      const dir = canonical(name);
      if (files.get(dir)?.dir) answer(id, { dir });
      else fail(id);
    });
    sftp.on('READDIR', (id, token) => {
      const handle = get(token);
      if (!handle?.dir) return fail(id);
      if (handle.finished) return sftp.status(id, status.EOF);
      handle.finished = true;
      const entries = [...files].filter(([file]) => file !== handle.dir && path.dirname(file) === handle.dir);
      if (!entries.length) return sftp.status(id, status.EOF);
      sftp.name(id, entries.map(([file, info]) => ({ filename: path.basename(file), longname: file, attrs: attrs(info) })));
    });
    sftp.on('OPEN', (id, name, flags, requested) => {
      const key = canonical(name);
      let file = files.get(key);
      if (file?.dir || (file && flags & mode.EXCL)) return fail(id);
      if (!file && flags & mode.CREAT && files.get(path.dirname(key))?.dir) {
        file = { bytes: Buffer.alloc(0), mode: requested.mode ?? 0o644 };
        files.set(key, file);
      }
      if (file) answer(id, { file });
      else missing(id);
    });
    sftp.on('CLOSE', (id, token) => { handles.delete(token.readUInt32BE(0)); ok(id); });
    sftp.on('FSTAT', (id, token) => {
      const { file } = get(token) || {};
      if (file) sftp.attrs(id, attrs(file)); else fail(id);
    });
    sftp.on('FSETSTAT', (id, token, nextAttrs) => {
      const { file } = get(token) || {};
      if (!file) return fail(id);
      if (nextAttrs.mode !== undefined) file.mode = nextAttrs.mode;
      ok(id);
    });
    sftp.on('READ', (id, token, offset, length) => {
      const { file } = get(token) || {};
      if (!file) return fail(id);
      if (offset >= file.bytes.length) return sftp.status(id, status.EOF);
      sftp.data(id, file.bytes.subarray(offset, offset + length));
    });
    sftp.on('WRITE', (id, token, offset, data) => {
      const { file } = get(token) || {};
      if (!file) return fail(id);
      if (offset + data.length > file.bytes.length) {
        const grown = Buffer.alloc(offset + data.length);
        file.bytes.copy(grown);
        file.bytes = grown;
      }
      data.copy(file.bytes, offset);
      ok(id);
    });
    sftp.on('MKDIR', (id, name) => {
      const key = canonical(name);
      if (files.has(key)) return fail(id);
      files.set(key, { dir: true });
      ok(id);
    });
    sftp.on('RENAME', (id, old, next) => {
      const source = canonical(old);
      const dest = canonical(next);
      if (!files.has(source) || files.has(dest)) return fail(id);
      for (const [name, value] of [...files]) {
        if (name === source || name.startsWith(source + '/')) {
          files.delete(name);
          files.set(dest + name.slice(source.length), value);
        }
      }
      ok(id);
    });
    sftp.on('SETSTAT', (id, name, requested) => {
      const file = files.get(canonical(name));
      if (!file) return missing(id);
      file.mode = requested.mode;
      ok(id);
    });
    sftp.on('RMDIR', (id, name) => {
      const dir = canonical(name);
      if ([...files.keys()].some((entry) => entry.startsWith(dir + '/'))) return fail(id);
      files.delete(dir);
      ok(id);
    });
    sftp.on('REMOVE', (id, name) => files.delete(canonical(name)) ? ok(id) : missing(id));
    sftp.on('EXTENDED', (id, extension, payload) => {
      if (extension !== 'posix-rename@openssh.com') return sftp.status(id, status.OP_UNSUPPORTED);
      const length = payload.readUInt32BE(0);
      const old = canonical(payload.toString('utf8', 4, 4 + length));
      const dest = canonical(payload.toString('utf8', 8 + length));
      if (!files.has(old)) return missing(id);
      files.set(dest, files.get(old));
      files.delete(old);
      ok(id);
    });
  }
  return { files, attach };
}

async function sshFixture() {
  const userKey = utils.generateKeyPairSync('ed25519', { cipher: 'aes256-ctr', passphrase: 'test-key-only' });
  const publicKey = utils.parseKey(userKey.public);
  const connections = new Set();
  const sampleTimers = new Set();
  const counters = { forwarded: 0, keyLogins: 0, passwordLogins: 0, keys: 0, resizes: 0, installs: 0, samples: 0 };
  const jump = await serve('jump');
  const direct = await serve('direct');
  const target = await serve('target');
  async function serve(kind) {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const hostFingerprint = fingerprint(utils.parseKey(hostKey.public).getPublicSSH());
    const storage = backend(kind + ' text\n');
    let installed = false;
    const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      connections.add(client);
      client.on('close', () => connections.delete(client));
      client.on('error', () => {});
      enableRename(client);
      client.on('authentication', (ctx) => {
        if (ctx.username !== 'fixture') return ctx.reject();
        if (kind !== 'target' && ctx.method === 'password' && ctx.password === 'ssh-only') {
          counters.passwordLogins++;
          return ctx.accept();
        }
        if (kind === 'target' && ctx.method === 'publickey' && publicKey.getPublicSSH().equals(ctx.key.data)
          && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) {
          if (ctx.signature) counters.keyLogins++;
          return ctx.accept();
        }
        ctx.reject(kind === 'target' ? ['publickey'] : ['password']);
      });
      client.on('tcpip', (accept, reject, info) => {
        if (kind !== 'jump' || info.destIP !== 'target.test.invalid' || info.destPort !== target.port) return reject();
        const peer = net.connect(target.port, '127.0.0.1');
        peer.once('error', () => reject());
        peer.once('connect', () => {
          counters.forwarded++;
          const channel = accept();
          const stop = () => { peer.destroy(); channel.destroy(); };
          peer.on('error', stop).on('close', stop);
          channel.on('error', stop).on('close', stop);
          channel.pipe(peer).pipe(channel);
        });
      });
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('window-change', (acceptResize) => { counters.resizes++; acceptResize?.(); });
        session.on('sftp', (acceptSftp) => storage.attach(acceptSftp()));
        session.on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec();
          channel.on('error', () => {});
          const done = (status) => { channel.exit(status); channel.end(); };
          if (info.command.includes('id -u')) {
            channel.write('/home/fixture/.SyncSSH\n');
            done(0);
          } else if (info.command.includes('mktemp')) {
            let script = '';
            channel.on('data', (data) => { script += data; });
            channel.once('end', () => {
              installed = script.includes('/proc/stat');
              if (installed) counters.installs++;
              done(installed ? 0 : 1);
            });
          } else if (installed && info.command.includes('metrics-v1.sh')) {
            let sample = 0;
            const tick = () => {
              sample++;
              counters.samples++;
              channel.write([sample * 3, 1000 + sample * 50, 300 + sample * 20, 8000, 4000, 10000, 6000,
                1000 + sample * 100, 4000 + sample * 300, 5000 + sample * 100, 1000 + sample * 300, 0.25, 3600].join(' ') + '\n');
            };
            tick();
            const timer = setInterval(tick, 300);
            sampleTimers.add(timer);
            channel.once('close', () => { clearInterval(timer); sampleTimers.delete(timer); });
          } else done(1);
        });
        session.on('shell', (acceptShell) => {
          const terminal = acceptShell();
          terminal.on('error', () => {});
          terminal.write(kind + ' ready\r\n$ ');
          let line = '';
          let oscToken;
          terminal.on('data', (bytes) => {
            const chunk = bytes.toString();
            counters.keys += bytes.length;
            for (const char of chunk) {
              if (char === '\r' || char === '\n') {
                const shellEvent = (message) => terminal.write('\u001b]777;syncssh;' + oscToken + ';' + message + '\u0007');
                if (line.startsWith('if [ -n "$BASH_VERSION"')) {
                  const packed = line.match(/printf %s ([a-z0-9+/=]+)/i)?.[1];
                  oscToken = packed && Buffer.from(packed, 'base64').toString().match(/syncssh;([0-9a-f-]{36});/)?.[1];
                  if (oscToken) { shellEvent('R'); shellEvent('E;0'); }
                } else if (oscToken && line) {
                  shellEvent('B');
                  shellEvent('H;' + Buffer.from(line).toString('base64'));
                  shellEvent('E;0');
                }
                if (line === 'cd docs') terminal.write('\u001b]7;file://fixture/home/docs\u0007');
                terminal.write('\r\nreceived: ' + line + '\r\n$ ');
                line = '';
              } else {
                line += char;
                terminal.write(char);
              }
            }
          });
        });
      });
    });
    const port = await listen(server);
    return { port, hostFingerprint, ...storage, server };
  }
  const login = { username: 'fixture', password: 'ssh-only', auth: 'password', host: '127.0.0.1' };
  return {
    direct, jump, target, counters, userKey,
    profiles: {
      direct: { ...login, port: direct.port, name: '直连主机' },
      jump: { ...login, port: jump.port, name: '共享跳板' },
      target: { username: 'fixture', auth: 'key', host: 'target.test.invalid', port: target.port, name: '跳板目标',
        privateKey: userKey.private, passphrase: 'test-key-only' }
    },
    close() {
      for (const timer of sampleTimers) clearInterval(timer);
      for (const connection of connections) connection._sock.destroy();
      for (const endpoint of [direct, jump, target]) endpoint.server.close();
    }
  };
}
module.exports = { davFixture, sshFixture };
