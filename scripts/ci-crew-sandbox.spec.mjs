import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

describe('Crew verifier CI sandbox', () => {
  it('enables Ubuntu user namespaces and proves bubblewrap launches in both jobs', () => {
    expect(
      workflow.match(/sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/g),
    ).toHaveLength(2);
    expect(
      workflow.match(/\/usr\/bin\/bwrap --die-with-parent --unshare-all --new-session/g),
    ).toHaveLength(2);
  });
});
