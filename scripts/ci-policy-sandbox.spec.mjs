import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

describe('Nuncio Engine policy sandbox in CI', () => {
  it('enables Ubuntu user namespaces and proves bubblewrap launches in the unit-test job', () => {
    expect(workflow).toContain('name: Install Nuncio Engine policy sandbox');
    expect(workflow).toContain('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
    expect(workflow).toContain(
      '/usr/bin/bwrap --die-with-parent --unshare-all --new-session --ro-bind / / /usr/bin/true',
    );
  });
});
