const LEGACY_BROWSER_RUNTIME_INSTRUCTIONS =
  'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';

const CURSOR_BOOTSTRAP_START = '<nuncio-runtime-bootstrap version="1">';
const CURSOR_USER_REQUEST = '</nuncio-runtime-bootstrap>\n\n<nuncio-user-request>';

export function decodeNuncioTransportUserText(text: string): string {
  if (text.startsWith(`${CURSOR_BOOTSTRAP_START}\n`)) {
    const marker = `\n${CURSOR_USER_REQUEST}\n`;
    const requestIndex = text.indexOf(marker);
    if (requestIndex >= 0) return text.slice(requestIndex + marker.length);
  }

  const legacySuffix = `\n\n${LEGACY_BROWSER_RUNTIME_INSTRUCTIONS}`;
  if (text.endsWith(legacySuffix)) return text.slice(0, -legacySuffix.length);

  return text;
}
