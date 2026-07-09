// Sign the bundled Bun runtime and every nested Mach-O in the staged server
// tree before electron-builder seals + notarizes the app.
//
// Resources/bun and the native executables inside Resources/server/node_modules
// (e.g. @cursor/sdk platform packages ship `cursorsandbox` and `rg`) are not
// recognized Electron helpers, so electron-builder won't sign them — any
// unsigned nested Mach-O fails notarization. We codesign each with the hardened
// runtime + JIT entitlements.
//
// No-op when no Developer ID identity is available (unsigned local builds), so the
// same config still produces a runnable app for plumbing tests.
const { execFileSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Mach-O magic numbers: 32/64-bit, both endiannesses, and fat/universal.
const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Regular files under root that carry a Mach-O header (symlinks skipped). */
function findMachOFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && isMachO(p)) out.push(p);
    }
  }
  return out;
}

function resolveIdentity() {
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return null;
  // CI passes the exact identity (SHA-1 hash) via CSC_NAME; locally, auto-detect.
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  try {
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
    const match = out.match(/"(Developer ID Application:[^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const identity = resolveIdentity();
  if (!identity) {
    console.log('[after-pack] no Developer ID identity — leaving bun runtime + nested binaries unsigned');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const resources = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
  const bunPath = path.join(resources, 'bun');
  const serverModules = path.join(resources, 'server', 'node_modules');
  // With an identity present, a missing runtime means the resource staging broke —
  // fail the build instead of shipping an app that cannot spawn its daemon.
  if (!fs.existsSync(bunPath)) {
    throw new Error(`[after-pack] bun runtime not found at ${bunPath} — resource staging is broken`);
  }

  const targets = [
    ...(fs.existsSync(serverModules) ? findMachOFiles(serverModules) : []),
    bunPath, // sign the spawning runtime last
  ];
  const entitlements = path.join(context.packager.info.projectDir, 'build', 'entitlements.mac.plist');
  console.log(`[after-pack] codesigning ${targets.length} nested Mach-O binaries with "${identity}"`);
  for (const target of targets) {
    console.log(`[after-pack]   ${path.relative(resources, target)}`);
    execFileSync(
      'codesign',
      ['--force', '--sign', identity, '--options', 'runtime', '--entitlements', entitlements, '--timestamp', target],
      { stdio: 'inherit' },
    );
  }
};
