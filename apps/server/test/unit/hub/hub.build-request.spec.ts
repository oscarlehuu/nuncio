import { describe, expect, it } from 'bun:test';
import { buildProxyRequest } from '../../../src/hub/hub.proxy';

function req(overrides: Record<string, unknown>): any {
  return { method: 'GET', headers: {}, ...overrides };
}

describe('buildProxyRequest', () => {
  it('builds the target URL from origin + downstream path', () => {
    const out = buildProxyRequest(
      req({ headers: { host: 'hub:3000' } }),
      'http://mac.ts.net:3000',
      '/api/sessions?x=1',
    );
    expect(out.url).toBe('http://mac.ts.net:3000/api/sessions?x=1');
    expect(out.method).toBe('GET');
  });

  it('drops hop-by-hop headers but forwards cookie/authorization', () => {
    const out = buildProxyRequest(
      req({
        headers: {
          host: 'hub:3000',
          connection: 'keep-alive',
          'content-length': '5',
          'transfer-encoding': 'chunked',
          cookie: 'nuncio_token=abc',
          authorization: 'Bearer xyz',
          accept: 'text/event-stream',
        },
      }),
      'http://mac.ts.net:3000',
      '/api/x',
    );
    expect(out.headers.host).toBeUndefined();
    expect(out.headers.connection).toBeUndefined();
    expect(out.headers['content-length']).toBeUndefined();
    expect(out.headers['transfer-encoding']).toBeUndefined();
    expect(out.headers.cookie).toBe('nuncio_token=abc');
    expect(out.headers.authorization).toBe('Bearer xyz');
    expect(out.headers.accept).toBe('text/event-stream');
  });

  it('omits the body for GET/HEAD', () => {
    expect(buildProxyRequest(req({ method: 'GET' }), 'http://m', '/api/x').body).toBeUndefined();
    expect(buildProxyRequest(req({ method: 'HEAD' }), 'http://m', '/api/x').body).toBeUndefined();
  });

  it('forwards the raw body when present, else re-serializes the parsed body', () => {
    const raw = Buffer.from('{"a":1}');
    expect(
      buildProxyRequest(req({ method: 'POST', rawBody: raw }), 'http://m', '/api/x').body,
    ).toBe(raw);

    const out = buildProxyRequest(
      req({ method: 'POST', body: { a: 2 }, headers: { 'content-type': 'application/json' } }),
      'http://m',
      '/api/x',
    );
    expect(out.body).toBe('{"a":2}');
  });
});
