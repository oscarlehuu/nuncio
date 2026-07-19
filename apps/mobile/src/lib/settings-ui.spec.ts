import { describe, expect, it } from 'vitest';
import { connectionStatusLabel, notificationStatusLabel } from './settings-ui';

describe('connectionStatusLabel', () => {
  it('describes the pairing state without exposing credentials', () => {
    expect(connectionStatusLabel(null)).toBe('Not paired');
    expect(connectionStatusLabel({ serverUrl: 'https://nuncio.example.test' })).toBe(
      'Connected to nuncio.example.test',
    );
  });
});

describe('notificationStatusLabel', () => {
  it.each([
    ['checking', 'Checking notification access…'],
    ['granted', 'Notifications enabled'],
    ['denied', 'Notifications are off'],
    ['unavailable', 'Notifications unavailable'],
  ] as const)('formats %s', (status, expected) => {
    expect(notificationStatusLabel(status)).toBe(expected);
  });
});
