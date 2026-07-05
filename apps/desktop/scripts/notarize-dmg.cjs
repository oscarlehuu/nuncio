// Notarize + staple the .dmg installer itself (afterSign only notarizes/staples the
// .app, so the .dmg wrapper otherwise ships without its own ticket). The .app inside
// is already notarized, so this is a quick re-scan. No-op without the API-key env.
const { execFileSync } = require('node:child_process');

exports.default = async function afterAllArtifactBuild(context) {
  if (process.platform !== 'darwin') return [];

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('[notarize-dmg] APPLE_API_* not set — skipping .dmg notarization');
    return [];
  }

  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] submitting ${dmg}…`);
    execFileSync(
      'xcrun',
      ['notarytool', 'submit', dmg, '--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER, '--wait'],
      { stdio: 'inherit' },
    );
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    console.log(`[notarize-dmg] stapled ${dmg}`);
  }
  return [];
};
