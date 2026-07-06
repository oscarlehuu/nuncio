import { describe, expect, it } from 'bun:test';
import {
  deviceAuthDecision,
  isAuthorizedDevice,
  parseDeviceBearer,
  type DeviceValidator,
} from '../../../src/auth/device-token';

describe('parseDeviceBearer', () => {
  it('parses a well-formed nd1 bearer into id and secret', () => {
    expect(parseDeviceBearer('Bearer nd1.abc_ID.sEcReT-99')).toEqual({
      deviceId: 'abc_ID',
      secret: 'sEcReT-99',
    });
  });

  it('returns null for the global token (no dots) so the two schemes never collide', () => {
    expect(parseDeviceBearer('Bearer plaintokennodots')).toBeNull();
  });

  it('rejects a wrong prefix, missing parts, or an extra separator', () => {
    expect(parseDeviceBearer('Bearer nd2.id.secret')).toBeNull();
    expect(parseDeviceBearer('Bearer nd1.id')).toBeNull();
    expect(parseDeviceBearer('Bearer nd1.id.a.b')).toBeNull();
    expect(parseDeviceBearer('Bearer nd1..secret')).toBeNull();
    expect(parseDeviceBearer('Bearer nd1.id.')).toBeNull();
  });

  it('rejects non-base64url characters in id or secret', () => {
    expect(parseDeviceBearer('Bearer nd1.id!.secret')).toBeNull();
    expect(parseDeviceBearer('Bearer nd1.id.sec ret')).toBeNull();
  });

  it('returns null for missing, array, or non-bearer headers', () => {
    expect(parseDeviceBearer(undefined)).toBeNull();
    expect(parseDeviceBearer('Basic abc')).toBeNull();
    expect(parseDeviceBearer(['Bearer nd1.id.secret'])).toEqual({
      deviceId: 'id',
      secret: 'secret',
    });
  });
});

describe('isAuthorizedDevice', () => {
  const validator: DeviceValidator = {
    verifyDevice: (id, secret) => id === 'dev1' && secret === 'good',
  };

  it('returns false when no validator is wired (falls through to other branches)', () => {
    expect(isAuthorizedDevice({ headers: { authorization: 'Bearer nd1.dev1.good' } })).toBe(false);
  });

  it('returns false for a non-device header even with a validator', () => {
    expect(isAuthorizedDevice({ headers: { authorization: 'Bearer globaltoken' } }, validator)).toBe(
      false,
    );
    expect(isAuthorizedDevice({ headers: {} }, validator)).toBe(false);
  });

  it('delegates a well-formed device bearer to the validator', () => {
    expect(isAuthorizedDevice({ headers: { authorization: 'Bearer nd1.dev1.good' } }, validator)).toBe(
      true,
    );
    expect(isAuthorizedDevice({ headers: { authorization: 'Bearer nd1.dev1.bad' } }, validator)).toBe(
      false,
    );
  });
});

describe('deviceAuthDecision', () => {
  const validator: DeviceValidator = {
    verifyDevice: (id, secret) => id === 'dev1' && secret === 'good',
  };

  it('accepts a valid device bearer and reports the deviceId', () => {
    expect(
      deviceAuthDecision({ headers: { authorization: 'Bearer nd1.dev1.good' } }, validator),
    ).toEqual({ kind: 'accept', deviceId: 'dev1' });
  });

  it('rejects a well-formed device bearer whose secret does not verify', () => {
    expect(
      deviceAuthDecision({ headers: { authorization: 'Bearer nd1.dev1.bad' } }, validator),
    ).toEqual({ kind: 'reject' });
  });

  it('rejects a Bearer that claims the nd1 scheme but is malformed (no fall-through)', () => {
    for (const bad of [
      'Bearer nd1.onlyonepart',
      'Bearer nd1.a.b.c',
      'Bearer nd1.dev!1.good', // bad charset in id
      'Bearer nd1.dev1.sec ret', // bad charset in secret
      'Bearer nd1..good', // empty id
      'Bearer nd1.dev1.', // empty secret
      'Bearer nd1.', // prefix only
    ]) {
      expect(deviceAuthDecision({ headers: { authorization: bad } }, validator)).toEqual({
        kind: 'reject',
      });
    }
  });

  it('returns none for callers with no device credential (non-nd1 Bearer, cookie-only, absent)', () => {
    expect(
      deviceAuthDecision({ headers: { authorization: 'Bearer globaltokennodots' } }, validator),
    ).toEqual({ kind: 'none' });
    expect(deviceAuthDecision({ headers: { cookie: 'nuncio_token=secret' } }, validator)).toEqual({
      kind: 'none',
    });
    expect(deviceAuthDecision({ headers: {} }, validator)).toEqual({ kind: 'none' });
    // A token that merely contains 'nd1' but is not prefixed with 'nd1.' is not a claim.
    expect(
      deviceAuthDecision({ headers: { authorization: 'Bearer xnd1.dev1.good' } }, validator),
    ).toEqual({ kind: 'none' });
  });

  it('returns none when no validator is wired, regardless of the header', () => {
    expect(deviceAuthDecision({ headers: { authorization: 'Bearer nd1.onlyonepart' } })).toEqual({
      kind: 'none',
    });
  });
});
