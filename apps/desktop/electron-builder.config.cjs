// Build config for the packaged Nuncio desktop app.
//
// One config, two channels selected by NUNCIO_CHANNEL (dev | stable):
//   - stable → "Nuncio",     appId dev.nuncio.desktop,     tracks GitHub `latest`
//   - dev    → "Nuncio Dev",  appId dev.nuncio.desktop.dev, tracks GitHub `dev` prereleases
// Distinct appId/productName means dev and stable install side by side with
// separate userData (and therefore separate SQLite data dirs).
//
// The self-contained server binary + web bundle are produced by
// scripts/build-resources.mjs into ./build-resources before packaging.

const isDev = process.env.NUNCIO_CHANNEL === 'dev';

module.exports = {
  appId: isDev ? 'dev.nuncio.desktop.dev' : 'dev.nuncio.desktop',
  productName: isDev ? 'Nuncio Dev' : 'Nuncio',
  copyright: 'Copyright © 2026 Nuncio',
  directories: {
    output: `dist/${isDev ? 'dev' : 'stable'}`,
    buildResources: 'build',
  },
  files: ['src/**/*', 'package.json', '!test/**', '!**/*.spec.js'],
  extraResources: [
    { from: 'build-resources/nuncio-server', to: 'nuncio-server' },
    { from: 'build-resources/web/dist', to: 'web/dist' },
    // Menu-bar tray icons, loaded at runtime from resourcesPath/build in the
    // packaged app (a source checkout reads them from ./build directly).
    { from: 'build/trayTemplate.png', to: 'build/trayTemplate.png' },
    { from: 'build/trayTemplate@2x.png', to: 'build/trayTemplate@2x.png' },
  ],
  asar: true,
  mac: {
    category: 'public.app-category.developer-tools',
    // zip is required alongside dmg so electron-updater can apply deltas.
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      // The UI is served by the loopback daemon; permit local networking under ATS.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  dmg: {
    title: '${productName} ${version}',
  },
  publish: {
    provider: 'github',
    owner: 'oscarlehuu',
    repo: 'nuncio',
    channel: isDev ? 'dev' : 'latest',
    releaseType: isDev ? 'prerelease' : 'release',
  },
  // Sign the bundled server binary (afterPack) before the app is sealed, then
  // notarize + staple the .app (afterSign). Auto-update ships the stapled .app
  // inside the .zip, so the .dmg wrapper itself is left un-stapled (the app it
  // installs is still notarized, so it opens cleanly).
  afterPack: './scripts/after-pack.cjs',
  afterSign: './scripts/notarize.cjs',
};
