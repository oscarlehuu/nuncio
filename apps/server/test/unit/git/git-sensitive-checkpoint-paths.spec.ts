import { describe, expect, it } from 'bun:test';
import {
  containsHighConfidenceSecret,
  redactHighConfidenceSecrets,
} from '../../../src/git/git-sensitive-checkpoint-paths';

describe('high-confidence checkpoint secret handling', () => {
  it('redacts every detected token family without exposing surrounding values', () => {
    const secrets = [
      `sk-proj-${'a'.repeat(32)}`,
      `sk-ant-${'b'.repeat(32)}`,
      `sk-${'c'.repeat(32)}`,
      `ghp_${'d'.repeat(36)}`,
      `github_pat_${'e'.repeat(40)}`,
      `glpat-${'f'.repeat(20)}`,
      `AKIA${'G'.repeat(16)}`,
      `AIza${'h'.repeat(35)}`,
      `xoxb-${'i'.repeat(20)}`,
    ];
    const content = secrets.map((secret, index) => `value_${index}=${secret}`).join('\n');

    expect(containsHighConfidenceSecret(content)).toBe(true);
    const redacted = redactHighConfidenceSecrets(content);

    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(secrets.length);
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });

  it('uses the same placeholder exception for detection and redaction', () => {
    const placeholder = `sk-proj-${'placeholder'.repeat(4)}`;
    const embeddedMarker = `sk-proj-${'a'.repeat(16)}example${'b'.repeat(16)}`;
    const content = `documented=${placeholder}\npossible_real=${embeddedMarker}`;

    expect(containsHighConfidenceSecret(content)).toBe(true);
    expect(redactHighConfidenceSecrets(content)).toBe(
      `documented=${placeholder}\npossible_real=[REDACTED]`,
    );
  });

  it('redacts a complete private-key block as one value', () => {
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'a'.repeat(96),
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const content = `before\n${privateKey}\nafter`;

    expect(containsHighConfidenceSecret(content)).toBe(true);
    expect(redactHighConfidenceSecrets(content)).toBe('before\n[REDACTED]\nafter');
  });
});
