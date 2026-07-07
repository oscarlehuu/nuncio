import { describe, expect, it } from 'bun:test';
import { authorizeUpgrade } from '../../../src/auth/upgrade-auth';
import type { TokenValidator } from '../../../src/auth/auth-request';
import type { DeviceValidator } from '../../../src/auth/device-token';

const tokens: TokenValidator = { isValidToken: (c) => c === 'secret' };
const devices: DeviceValidator = {
  verifyDevice: (id, secret) => id === 'dev1' && secret === 'good',
};

describe('authorizeUpgrade', () => {
  it('authorizes loopback with no device principal', async () => {
    const res = await authorizeUpgrade({ socket: { remoteAddress: '127.0.0.1' } });
    expect(res).toEqual({ authorized: true });
  });

  it('authorizes a global-token remote with no device principal', async () => {
    const res = await authorizeUpgrade(
      { socket: { remoteAddress: '192.168.1.9' }, headers: { authorization: 'Bearer secret' } },
      tokens,
    );
    expect(res).toEqual({ authorized: true });
  });

  it('surfaces the deviceId when an nd1 bearer authorizes the upgrade', async () => {
    const res = await authorizeUpgrade(
      { socket: { remoteAddress: '192.168.1.9' }, headers: { authorization: 'Bearer nd1.dev1.good' } },
      tokens,
      undefined,
      devices,
    );
    expect(res).toEqual({ authorized: true, deviceId: 'dev1' });
  });

  it('rejects an nd1 bearer whose secret does not verify', async () => {
    const res = await authorizeUpgrade(
      { socket: { remoteAddress: '192.168.1.9' }, headers: { authorization: 'Bearer nd1.dev1.stale' } },
      tokens,
      undefined,
      devices,
    );
    expect(res).toEqual({ authorized: false });
  });

  it('a presented device credential decides: bad nd1 bearer is rejected even with a valid cookie', async () => {
    const res = await authorizeUpgrade(
      {
        socket: { remoteAddress: '192.168.1.9' },
        headers: { authorization: 'Bearer nd1.dev1.stale', cookie: 'nuncio_token=secret' },
      },
      tokens,
      undefined,
      devices,
    );
    expect(res).toEqual({ authorized: false });
  });

  it('a valid nd1 bearer authorizes with its deviceId even when a valid cookie is also present', async () => {
    const res = await authorizeUpgrade(
      {
        socket: { remoteAddress: '192.168.1.9' },
        headers: { authorization: 'Bearer nd1.dev1.good', cookie: 'nuncio_token=secret' },
      },
      tokens,
      undefined,
      devices,
    );
    expect(res).toEqual({ authorized: true, deviceId: 'dev1' });
  });

  it('falls through to the cookie when there is no parseable device bearer', async () => {
    const res = await authorizeUpgrade(
      {
        socket: { remoteAddress: '192.168.1.9' },
        headers: { authorization: 'Bearer secret', cookie: 'nuncio_token=secret' },
      },
      tokens,
      undefined,
      devices,
    );
    expect(res).toEqual({ authorized: true });
  });
});
