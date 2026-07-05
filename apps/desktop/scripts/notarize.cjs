// Notarize the signed .app via Apple's notarytool using an App Store Connect API key.
//
// Requires three env vars (skips notarization if any is missing, so unsigned local
// builds still succeed):
//   APPLE_API_KEY     — path to the AuthKey_XXXX.p8 file
//   APPLE_API_KEY_ID  — the key id (the XXXX in the filename)
//   APPLE_API_ISSUER  — the issuer id (UUID from App Store Connect)
const path = require('node:path');

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('[notarize] APPLE_API_KEY / _KEY_ID / _ISSUER not all set — skipping notarization');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  const { notarize } = require('@electron/notarize');
  console.log(`[notarize] submitting ${appPath} to notarytool…`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  });
  console.log('[notarize] accepted + stapled');
};
