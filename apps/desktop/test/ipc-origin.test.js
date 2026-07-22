const { describe, expect, test } = require('bun:test');
const {
  assertTrustedLocalRenderer,
  isTrustedLocalRendererUrl,
  rendererUrl,
} = require('../src/ipc-origin.js');

describe('desktop IPC renderer origin', () => {
  test('accepts only the exact configured HTTP(S) origin', () => {
    const trusted = ['http://127.0.0.1:43127/app', 'https://localhost:4443/'];

    for (const url of [
      'http://127.0.0.1:43127/',
      'http://127.0.0.1:43127/session/1?tab=terminal#latest',
      'https://localhost:4443/settings',
    ]) {
      expect(isTrustedLocalRendererUrl(url, trusted)).toBe(true);
    }

    for (const url of [
      '',
      'not a url',
      'http://127.0.0.1:0/',
      'http://127.0.0.1:43126/',
      'http://127.0.0.1:43128/',
      'https://127.0.0.1:43127/',
      'http://localhost:43127/',
      'http://127.0.0.1:4444/',
      'data:text/html,hello',
      'https://attacker.example/',
      'https://localhost.attacker.example/',
      'https://localhost@attacker.example/',
    ]) {
      expect(isTrustedLocalRendererUrl(url, trusted)).toBe(false);
    }
  });

  test('accepts only the exact approved app file', () => {
    const appFile = 'file:///Applications/Nuncio.app/Contents/Resources/web/dist/index.html';

    expect(isTrustedLocalRendererUrl(`${appFile}?section=mobile#settings`, [appFile])).toBe(true);
    expect(
      isTrustedLocalRendererUrl(
        'file:///Applications/Nuncio.app/Contents/Resources/web/dist/other.html',
        [appFile],
      ),
    ).toBe(false);
    expect(isTrustedLocalRendererUrl('file:///tmp/index.html', [appFile])).toBe(false);
    expect(isTrustedLocalRendererUrl('file:///Applications/Nuncio.app/%zz', [appFile])).toBe(false);
  });

  test('requires an explicit non-empty trust set', () => {
    expect(isTrustedLocalRendererUrl('http://localhost:5173/', [])).toBe(false);
    expect(isTrustedLocalRendererUrl('http://localhost:5173/')).toBe(false);
    expect(isTrustedLocalRendererUrl('http://localhost:5173/', [null, '', 'not a url'])).toBe(
      false,
    );
  });

  test('prefers the invoking frame URL and fails closed when it is remote or absent', () => {
    const trusted = ['http://localhost:5173/'];
    const remoteFrame = {
      senderFrame: { url: 'https://attacker.example/' },
      sender: { getURL: () => 'http://localhost:5173/' },
    };
    expect(rendererUrl(remoteFrame)).toBe('https://attacker.example/');
    expect(() => assertTrustedLocalRenderer(remoteFrame, 'terminal:create', trusted)).toThrow(
      /trusted local renderer/i,
    );
    expect(() => assertTrustedLocalRenderer({}, 'terminal:create', trusted)).toThrow(
      /trusted local renderer/i,
    );
  });
});
