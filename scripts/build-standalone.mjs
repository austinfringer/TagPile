#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { inject } = require('postject/dist/api.js');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = join(repoRoot, 'dist');
const cacheDir = join(distDir, '.cache');
const workDir = join(distDir, '.work');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(repoRoot, 'server/package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));

const version = serverPkg.version || rootPkg.version || '0.0.0';
const nodeVersion = process.version; // e.g. v24.20.0

const ALL_TARGETS = [
  {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    nodeDistName: `node-${nodeVersion}-linux-x64`,
    nodeArchiveExt: 'tar.xz',
    nodeBinRelPath: 'bin/node',
    outputBinName: 'tagpile',
    sharpPkgName: '@img/sharp-linux-x64',
    libvipsPkgName: '@img/sharp-libvips-linux-x64',
    sqlitePrebuild: 'linux-x64.node',
  },
  {
    id: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    nodeDistName: `node-${nodeVersion}-win-x64`,
    nodeArchiveExt: 'zip',
    nodeBinRelPath: 'node.exe',
    outputBinName: 'tagpile.exe',
    sharpPkgName: '@img/sharp-win32-x64',
    libvipsPkgName: null,
    sqlitePrebuild: 'win32-x64.node',
  },
  {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    nodeDistName: `node-${nodeVersion}-darwin-arm64`,
    nodeArchiveExt: 'tar.gz',
    nodeBinRelPath: 'bin/node',
    outputBinName: 'tagpile',
    sharpPkgName: '@img/sharp-darwin-arm64',
    libvipsPkgName: '@img/sharp-libvips-darwin-arm64',
    sqlitePrebuild: 'darwin-arm64.node',
  },
  {
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    nodeDistName: `node-${nodeVersion}-darwin-x64`,
    nodeArchiveExt: 'tar.gz',
    nodeBinRelPath: 'bin/node',
    outputBinName: 'tagpile',
    sharpPkgName: '@img/sharp-darwin-x64',
    libvipsPkgName: '@img/sharp-libvips-darwin-x64',
    sqlitePrebuild: 'darwin-x64.node',
  },
];

function parseTargetFilter() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--target='));
  if (targetArg) {
    const requested = targetArg
      .slice('--target='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.includes('host')) {
      const hostId = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
      return ALL_TARGETS.filter((t) => t.id === hostId);
    }
    return ALL_TARGETS.filter((t) => requested.includes(t.id) || requested.includes(t.platform));
  }
  return ALL_TARGETS;
}

function collectFilesRecursive(dir, baseDir = dir) {
  const results = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(results, collectFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      const rel = relative(baseDir, full).split('\\').join('/');
      results[rel] = full;
    }
  }
  return results;
}

/** Downloads `url` to `destPath` unless the file is cached. When `expected` is set, the file
 *  (new or cached) must have that digest, `{ algorithm, digest }` with a base64 or hex digest;
 *  a file that does not match is deleted and the build stops. */
async function downloadFile(url, destPath, expected) {
  if (!existsSync(destPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    console.log(`  Downloading ${url}...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
  }
  if (expected) {
    const encoding = /^[0-9a-f]+$/.test(expected.digest) ? 'hex' : 'base64';
    const actual = createHash(expected.algorithm).update(readFileSync(destPath)).digest(encoding);
    if (actual !== expected.digest) {
      rmSync(destPath, { force: true });
      throw new Error(
        `Checksum mismatch for ${url}: expected ${expected.algorithm} ${expected.digest}, got ${actual}`,
      );
    }
  }
}

/** The SHA-256 of a Node.js release file, from the release's `SHASUMS256.txt`. */
async function nodeArchiveSha256(archiveName) {
  const sumsPath = join(cacheDir, 'archives', `SHASUMS256-${nodeVersion}.txt`);
  await downloadFile(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, sumsPath);
  for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name === archiveName) return digest;
  }
  throw new Error(`${archiveName} is not in SHASUMS256.txt for Node.js ${nodeVersion}`);
}

/** The lockfile entry (version and `sha512-...` integrity) of an npm package. */
function lockedPackage(pkgName) {
  const entry = lockfile.packages?.[`node_modules/${pkgName}`];
  if (!entry?.version || !entry.integrity?.startsWith('sha512-')) {
    throw new Error(`package-lock.json has no version and sha512 integrity for ${pkgName}`);
  }
  return { version: entry.version, sha512: entry.integrity.slice('sha512-'.length) };
}

async function ensureNodeBinary(target) {
  const cachedBin = join(cacheDir, 'node', target.id, target.outputBinName);
  if (existsSync(cachedBin)) {
    return cachedBin;
  }

  mkdirSync(dirname(cachedBin), { recursive: true });

  if (target.platform === process.platform && target.arch === process.arch) {
    copyFileSync(process.execPath, cachedBin);
    if (process.platform !== 'win32') chmodSync(cachedBin, 0o755);
    return cachedBin;
  }

  const archiveName = `${target.nodeDistName}.${target.nodeArchiveExt}`;
  const archivePath = join(cacheDir, 'archives', archiveName);
  const url = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;
  await downloadFile(url, archivePath, {
    algorithm: 'sha256',
    digest: await nodeArchiveSha256(archiveName),
  });

  const extractDir = join(cacheDir, 'node-extract', target.id);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (target.nodeArchiveExt === 'zip') {
    execFileSync('unzip', [
      '-q',
      archivePath,
      `${target.nodeDistName}/${target.nodeBinRelPath}`,
      '-d',
      extractDir,
    ]);
  } else {
    execFileSync('tar', [
      '-xf',
      archivePath,
      '-C',
      extractDir,
      `${target.nodeDistName}/${target.nodeBinRelPath}`,
    ]);
  }

  const extractedBin = join(extractDir, target.nodeDistName, target.nodeBinRelPath);
  copyFileSync(extractedBin, cachedBin);
  rmSync(extractDir, { recursive: true, force: true });
  if (target.platform !== 'win32') chmodSync(cachedBin, 0o755);
  return cachedBin;
}

/** Copies an npm package into `destDir`: from `node_modules` when npm installed it for this
 *  host, otherwise from the registry tarball at the version and integrity in the lockfile. */
async function ensureNpmPackageDir(pkgName, destDir) {
  const localDir = join(repoRoot, 'node_modules', ...pkgName.split('/'));
  if (existsSync(localDir)) {
    mkdirSync(dirname(destDir), { recursive: true });
    cpSync(localDir, destDir, { recursive: true });
    return;
  }

  const locked = lockedPackage(pkgName);
  const shortName = pkgName.split('/').pop();
  const tgzName = `${shortName}-${locked.version}.tgz`;
  const cachedTgz = join(cacheDir, 'npm', tgzName);
  const url = `https://registry.npmjs.org/${pkgName}/-/${tgzName}`;
  await downloadFile(url, cachedTgz, { algorithm: 'sha512', digest: locked.sha512 });

  const tmpExtract = join(cacheDir, 'npm-extract', `${shortName}-${Date.now()}`);
  mkdirSync(tmpExtract, { recursive: true });
  execFileSync('tar', ['-xzf', cachedTgz, '-C', tmpExtract]);
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(join(tmpExtract, 'package'), destDir, { recursive: true });
  rmSync(tmpExtract, { recursive: true, force: true });
}

function stageNodeModules(target, stageDir) {
  const nm = join(stageDir, 'node_modules');
  mkdirSync(nm, { recursive: true });

  // 1. better-sqlite3 (only lib/, package.json, LICENSE, and the single target prebuild)
  const sqliteSrc = join(repoRoot, 'node_modules/better-sqlite3');
  const sqliteDest = join(nm, 'better-sqlite3');
  mkdirSync(join(sqliteDest, 'prebuilds'), { recursive: true });
  cpSync(join(sqliteSrc, 'lib'), join(sqliteDest, 'lib'), { recursive: true });
  copyFileSync(join(sqliteSrc, 'package.json'), join(sqliteDest, 'package.json'));
  copyFileSync(join(sqliteSrc, 'LICENSE'), join(sqliteDest, 'LICENSE'));
  copyFileSync(
    join(sqliteSrc, 'prebuilds', target.sqlitePrebuild),
    join(sqliteDest, 'prebuilds', target.sqlitePrebuild),
  );

  // 2. sharp (only CJS dist files, package.json, LICENSE) + its small pure-JS dependencies
  const sharpSrc = join(repoRoot, 'node_modules/sharp');
  const sharpDest = join(nm, 'sharp');
  mkdirSync(join(sharpDest, 'dist'), { recursive: true });
  for (const entry of readdirSync(join(sharpSrc, 'dist'))) {
    if (entry.endsWith('.cjs')) {
      copyFileSync(join(sharpSrc, 'dist', entry), join(sharpDest, 'dist', entry));
    }
  }
  copyFileSync(join(sharpSrc, 'package.json'), join(sharpDest, 'package.json'));
  copyFileSync(join(sharpSrc, 'LICENSE'), join(sharpDest, 'LICENSE'));

  for (const dep of ['@img/colour', 'detect-libc', 'semver']) {
    const depSrc = join(repoRoot, 'node_modules', ...dep.split('/'));
    const depDest = join(nm, ...dep.split('/'));
    mkdirSync(dirname(depDest), { recursive: true });
    cpSync(depSrc, depDest, {
      recursive: true,
      filter: (src) => !src.endsWith('.d.ts') && !src.endsWith('.md'),
    });
  }
}

function writeLaunchersAndDocs(target, stageDir) {
  const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8').replace(
    'NODE_ENV=development',
    'NODE_ENV=production',
  );
  writeFileSync(join(stageDir, '.env.example'), envExample);
  copyFileSync(join(repoRoot, 'LICENSE'), join(stageDir, 'LICENSE'));

  if (target.platform === 'win32') {
    const bat = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'set NODE_ENV=production',
      'set OPEN_BROWSER=1',
      '"%~dp0tagpile.exe"',
      'pause',
      '',
    ].join('\r\n');
    writeFileSync(join(stageDir, 'start-tagpile.bat'), bat);
  } else if (target.platform === 'darwin') {
    const commandScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'cd "$DIR"',
      'export NODE_ENV=production',
      'export OPEN_BROWSER=1',
      'exec "$DIR/tagpile"',
      '',
    ].join('\n');
    const cmdPath = join(stageDir, 'start-tagpile.command');
    writeFileSync(cmdPath, commandScript);
    chmodSync(cmdPath, 0o755);

    const shPath = join(stageDir, 'start-tagpile.sh');
    writeFileSync(shPath, commandScript);
    chmodSync(shPath, 0o755);
  } else {
    const shScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'cd "$DIR"',
      'export NODE_ENV=production',
      'export OPEN_BROWSER=1',
      'exec "$DIR/tagpile"',
      '',
    ].join('\n');
    const shPath = join(stageDir, 'start-tagpile.sh');
    writeFileSync(shPath, shScript);
    chmodSync(shPath, 0o755);

    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=TagPile',
      'Comment=Start TagPile Server and open web UI',
      'Exec=sh -c \'cd "$(dirname "$1")" && ./start-tagpile.sh\' _ %k',
      'Terminal=true',
      'Categories=Utility;',
      '',
    ].join('\n');
    const desktopPath = join(stageDir, 'TagPile.desktop');
    writeFileSync(desktopPath, desktopEntry);
    chmodSync(desktopPath, 0o755);
  }

  const readme = `# TagPile Standalone (${target.id})

Version: ${version}

## Quick Start

1. Extract this zip archive to any folder.
2. Start TagPile:
   - **Windows**: Double-click \`start-tagpile.bat\` (or run \`tagpile.exe\`).
   - **macOS**: Double-click \`start-tagpile.command\` (or run \`./start-tagpile.sh\`).
   - **Linux**: Run \`./start-tagpile.sh\` (or launch \`TagPile.desktop\`).
3. Your default browser will open \`http://localhost:3000\`.
4. On first boot, check the terminal output for your one-time **Invitation code** to create the initial admin account.

## Configuration

TagPile stores its SQLite databases in \`./data/\` next to the executable by default.
To customize settings (such as \`PORT\`, \`HOST\`, or \`DATABASE_PATH\`), copy \`.env.example\` to \`.env\` in this folder and edit the values.

- Set \`LIBRARY_ROOTS\` to the directories that hold your files. Until you set it, no library can be created.
- By default TagPile speaks plain HTTP on all network interfaces. On a network that you do not trust, set \`TLS_CERT_FILE\` and \`TLS_KEY_FILE\` to serve HTTPS, or set \`HOST=127.0.0.1\` to accept connections from this computer only.

Full documentation: https://github.com/austinfringer/TagPile#readme
`;
  writeFileSync(join(stageDir, 'README.txt'), readme);
}

async function main() {
  const targets = parseTargetFilter();
  if (targets.length === 0) {
    throw new Error('No matching build targets selected.');
  }

  console.log(`Building TagPile standalone (${targets.map((t) => t.id).join(', ')})...`);

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  // Step 1: Build client
  console.log('1. Building client assets...');
  execFileSync('npm', ['run', 'build', '-w', 'client'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const clientDistDir = join(repoRoot, 'client/dist');
  const seaAssets = collectFilesRecursive(clientDistDir);

  // Step 2: Bundle server JS into a single CJS file with esbuild
  console.log('2. Bundling server into single CommonJS bundle...');
  const bundlePath = join(workDir, 'server-bundle.cjs');
  await esbuild.build({
    entryPoints: [join(repoRoot, 'server/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: bundlePath,
    external: ['better-sqlite3', 'sharp'],
    plugins: [
      {
        name: 'sea-externals',
        setup(build) {
          build.onResolve({ filter: /^(better-sqlite3|sharp)$/ }, (args) => ({
            path: args.path,
            namespace: 'sea-external',
          }));
          build.onLoad({ filter: /.*/, namespace: 'sea-external' }, (args) => ({
            contents: `module.exports = require("node:module").createRequire(process.execPath)(${JSON.stringify(args.path)});`,
            loader: 'js',
          }));
        },
      },
    ],
    define: {
      __TAGPILE_VERSION__: JSON.stringify(version),
      'import.meta.url': '"file:///sea/index.js"',
    },
    logLevel: 'warning',
  });

  // Step 3: Build SEA preparation blob
  console.log('3. Generating Node SEA preparation blob...');
  const seaBlobPath = join(workDir, 'sea-prep.blob');
  const seaConfigPath = join(workDir, 'sea-config.json');
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        assets: seaAssets,
      },
      null,
      2,
    ),
  );

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const seaBlobBuffer = readFileSync(seaBlobPath);

  // Step 4: Package each target OS
  for (const target of targets) {
    console.log(`4. Packaging target: ${target.id}...`);
    const stageRoot = join(workDir, `stage-${target.id}`);
    const bundleFolderName = `tagpile-${target.id}`;
    const stageDir = join(stageRoot, bundleFolderName);
    rmSync(stageRoot, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    const baseNodeBin = await ensureNodeBinary(target);
    const outBinPath = join(stageDir, target.outputBinName);
    copyFileSync(baseNodeBin, outBinPath);
    if (target.platform !== 'win32') {
      chmodSync(outBinPath, 0o755);
    }

    // On macOS, remove existing signature before injecting SEA blob if codesign is present
    if (target.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--remove-signature', outBinPath], { stdio: 'ignore' });
      } catch {
        // codesign not available on non-macOS hosts
      }
    }

    await inject(outBinPath, 'NODE_SEA_BLOB', seaBlobBuffer, {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      machoSegmentName: target.platform === 'darwin' ? 'NODE_SEA' : undefined,
    });

    if (target.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--sign', '-', outBinPath], { stdio: 'ignore' });
      } catch {
        // codesign not available on non-macOS hosts
      }
    }

    if (target.platform !== 'win32') {
      chmodSync(outBinPath, 0o755);
    }

    // Stage native addons
    stageNodeModules(target, stageDir);
    for (const pkgName of [target.sharpPkgName, target.libvipsPkgName].filter(Boolean)) {
      await ensureNpmPackageDir(pkgName, join(stageDir, 'node_modules', ...pkgName.split('/')));
    }

    writeLaunchersAndDocs(target, stageDir);

    const zipName = `tagpile-v${version}-${target.id}.zip`;
    const zipPath = join(distDir, zipName);
    rmSync(zipPath, { force: true });

    execFileSync('zip', ['-r', '-q', zipPath, bundleFolderName], {
      cwd: stageRoot,
      stdio: 'inherit',
    });

    console.log(`   Created ${relative(repoRoot, zipPath)}`);
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log('Standalone build complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
