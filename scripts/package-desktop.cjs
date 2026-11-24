const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = (command, args, options = {}) =>
  promisify(execFile)(command, args, { windowsHide: true, ...options });

async function releaseDirectory(root, version, explicit) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) throw new Error('Use a numeric major.minor.patch version to build a release.');
  const [, major, minor, patch] = parsed;
  const folder = 'dist' + major + '.' + minor + (patch === '0' ? '' : '.' + patch);
  if (explicit && explicit !== folder) throw new Error('This version must be built in ' + folder + '.');
  const directory = path.join(root, folder);
  try { await fs.mkdir(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(folder + ' already exists. Release directories are preserved.');
    throw error;
  }
  return directory;
}

async function copyApp(root, target) {
  await fs.mkdir(target, { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(target, 'src'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    await fs.copyFile(path.join(root, file), path.join(target, file));
  }
  const { packages } = require('../package-lock.json');
  for (const [source, metadata] of Object.entries(packages)) {
    if (!source.startsWith('node_modules/') || metadata.dev) continue;
    try {
      const base = path.join(root, source);
      await fs.cp(base, path.join(target, source), {
        recursive: true,
        filter: (entry) => {
          const parts = path.relative(base, entry).split(path.sep);
          return !entry.endsWith('.map') && !['test', 'tests', 'benchmark', 'benchmarks'].includes(parts[0]);
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT' || !(metadata.optional || metadata.devOptional)) throw error;
    }
  }
}

async function windows(root, output, runtime, version) {
  const folder = 'SyncSSH-win32-' + process.arch;
  const target = path.join(output, folder);
  await fs.cp(runtime, target, { recursive: true, filter: (file) => path.basename(file) !== 'default_app.asar' });
  await fs.rename(path.join(target, 'electron.exe'), path.join(target, 'SyncSSH.exe'));
  await copyApp(root, path.join(target, 'resources', 'app'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) await fs.copyFile(path.join(root, file), path.join(target, file));
  const asset = path.join(output, 'SyncSSH-v' + version + '-win32-' + process.arch + '.zip');
  try {
    await run('7z', ['a', '-tzip', '-mm=Deflate', '-mx=9', '-mtc=off', asset, folder], { cwd: output });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run('tar.exe', ['-a', '-cf', asset, '-C', output, folder]);
  }
  return asset;
}

async function linux(root, output, runtime, version) {
  if (process.arch !== 'x64') throw new Error('The Linux release target is Ubuntu x64.');
  const staging = path.join(output, 'deb-root');
  const target = path.join(staging, 'opt', 'SyncSSH');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(runtime, target, { recursive: true, filter: (file) => path.basename(file) !== 'default_app.asar' });
  await fs.rename(path.join(target, 'electron'), path.join(target, 'syncssh'));
  await fs.chmod(path.join(target, 'chrome-sandbox'), 0o4755);
  await copyApp(root, path.join(target, 'resources', 'app'));
  const apps = path.join(staging, 'usr', 'share', 'applications');
  await fs.mkdir(apps, { recursive: true });
  await fs.writeFile(path.join(apps, 'syncssh.desktop'), '[Desktop Entry]\nName=SyncSSH\nComment=SSH and SFTP client\n' +
    'Exec=/opt/SyncSSH/syncssh\nTerminal=false\nType=Application\nCategories=Network;RemoteAccess;\n');
  await fs.mkdir(path.join(staging, 'DEBIAN'));
  await fs.writeFile(path.join(staging, 'DEBIAN', 'control'), 'Package: syncssh\nVersion: ' + version + '\n' +
    'Section: net\nPriority: optional\nArchitecture: amd64\nMaintainer: Wypum\n' +
    'Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libnspr4, libasound2t64 | libasound2, libgbm1, libxss1, libxtst6, libxdamage1, libxkbcommon0, libatspi2.0-0t64 | libatspi2.0-0\n' +
    'Description: SyncSSH desktop client for SSH, SFTP and encrypted WebDAV synchronization\n');
  const asset = path.join(output, 'SyncSSH-v' + version + '-ubuntu-amd64.deb');
  await run('dpkg-deb', ['--root-owner-group', '-Zxz', '-z9', '--build', staging, asset]);
  return asset;
}

async function mac(root, output, executable, version) {
  if (process.arch !== 'arm64') throw new Error('The macOS preview target is Apple Silicon.');
  const staging = path.join(output, 'mac-preview');
  await fs.mkdir(staging);
  const bundle = path.join(staging, 'SyncSSH.app');
  await run('ditto', [path.resolve(executable, '..', '..', '..'), bundle]);
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const [key, value] of Object.entries({ CFBundleIdentifier: 'app.syncssh.client',
    CFBundleName: 'SyncSSH', CFBundleDisplayName: 'SyncSSH', CFBundleShortVersionString: version, CFBundleVersion: version })) {
    await run('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist])
      .catch(() => run('/usr/libexec/PlistBuddy', ['-c', 'Add :' + key + ' string ' + value, plist]));
  }
  const resources = path.join(bundle, 'Contents', 'Resources');
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  await copyApp(root, path.join(resources, 'app'));
  await run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
  await run('codesign', ['--verify', '--deep', '--strict', bundle]);
  const asset = path.join(output, 'SyncSSH-v' + version + '-macos-arm64-preview.dmg');
  await run('hdiutil', ['create', '-volname', 'SyncSSH Preview', '-srcfolder', staging, '-format', 'UDZO', asset]);
  return asset;
}

async function build({ winOnly = false } = {}) {
  if (winOnly && process.platform !== 'win32') throw new Error('Run the Windows build on Windows.');
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const executable = require('electron');
  const runtime = path.dirname(executable);
  const output = await releaseDirectory(root, version, process.argv[2]);
  const builds = {
    win32: () => windows(root, output, runtime, version),
    linux: () => linux(root, output, runtime, version),
    darwin: () => mac(root, output, executable, version)
  };
  if (!builds[process.platform]) throw new Error('Unsupported packaging host.');
  const asset = await builds[process.platform]();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(asset)) hash.update(chunk);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), hash.digest('hex') + '  ' + path.basename(asset) + '\n');
  console.log(asset);
}

function main(options) {
  build(options).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
if (require.main === module) main();
module.exports = { main };
