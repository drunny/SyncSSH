const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);

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

async function build() {
  if (process.platform !== 'win32') throw new Error('Run the Windows build on Windows.');
  const root = path.resolve(__dirname, '..');
  const manifest = require('../package.json');
  const executable = require('electron');
  const runtime = path.dirname(executable);
  const baseName = 'SyncSSH-win32-' + process.arch;
  const output = await releaseDirectory(root, manifest.version, process.argv[2]);
  const target = path.join(output, baseName);
  await fs.mkdir(target);
  await fs.cp(runtime, target, { recursive: true, filter: (file) => path.basename(file) !== 'default_app.asar' });
  await fs.rename(path.join(target, path.basename(executable)), path.join(target, 'SyncSSH.exe'));

  const app = path.join(target, 'resources', 'app');
  await fs.mkdir(app, { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  await fs.copyFile(path.join(root, 'package.json'), path.join(app, 'package.json'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) await fs.copyFile(path.join(root, file), path.join(target, file));

  const { packages } = require('../package-lock.json');
  for (const [source, metadata] of Object.entries(packages)) {
    if (!source.startsWith('node_modules/') || metadata.dev) continue;
    try {
      await fs.cp(path.join(root, source), path.join(app, source), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT' || !(metadata.optional || metadata.devOptional)) throw error;
    }
  }
  const zipName = 'SyncSSH-v' + manifest.version + '-win32-' + process.arch + '.zip';
  const zip = path.join(output, zipName);
  await run('tar.exe', ['-a', '-cf', zip, '-C', output, baseName], { windowsHide: true });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), hash.digest('hex') + '  ' + zipName + '\n');
  console.log(path.join(target, 'SyncSSH.exe'));
  console.log(zip);
}

build().catch((error) => { console.error(error.message); process.exitCode = 1; });
