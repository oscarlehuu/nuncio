/// <reference types="vite/client" />

/**
 * Virtual module provided by the `nuncio-changelog-loader` Vite plugin
 * (see apps/web/vite.config.ts). Returns the raw text of the repo-root
 * CHANGELOG.md at build/dev-start time.
 */
declare module 'virtual:changelog' {
  const changelogRaw: string;
  export default changelogRaw;
}
