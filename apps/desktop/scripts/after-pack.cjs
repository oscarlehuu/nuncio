// Sign the bundled server binary before electron-builder seals + notarizes the app.
//
// The `nuncio-server` binary lives in Resources and is not a recognized Electron
// helper, so electron-builder won't sign it — an unsigned nested Mach-O fails
// notarization. We codesign it here with the hardened runtime + JIT entitlements.
//
// No-op when no Developer ID identity is available (unsigned local builds), so the
// same config still produces a runnable app for plumbing tests.
const { execFileSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

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
    console.log('[after-pack] no Developer ID identity — leaving server binary unsigned');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const binPath = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'nuncio-server');
  if (!fs.existsSync(binPath)) {
    console.warn(`[after-pack] server binary not found at ${binPath}`);
    return;
  }

  const entitlements = path.join(context.packager.info.projectDir, 'build', 'entitlements.mac.plist');
  console.log(`[after-pack] codesigning nuncio-server with "${identity}"`);
  execFileSync(
    'codesign',
    ['--force', '--sign', identity, '--options', 'runtime', '--entitlements', entitlements, '--timestamp', binPath],
    { stdio: 'inherit' },
  );
};
