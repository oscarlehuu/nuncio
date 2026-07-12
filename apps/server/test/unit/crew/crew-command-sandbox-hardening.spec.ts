import {
  buildCrewSandboxLaunch,
  isCrewVerifierSandboxAvailable,
} from '../../../src/crew/crew-command-sandbox';
import { existsSync } from 'node:fs';

describe('Crew verifier sandbox hardening', () => {
  it('default-denies macOS file data outside explicit workspace and system roots', () => {
    const launch = buildCrewSandboxLaunch(
      'true', process.cwd(), 'darwin', '/usr/bin/true',
    );
    const profile = launch.argv[2]!;

    expect(profile).toContain('(deny file-read-data (require-all (subpath "/")');
    expect(profile).toContain(
      `(require-not (subpath ${JSON.stringify(process.cwd())}))`,
    );
    expect(profile).not.toContain('(require-not (subpath "/private/etc"))');
  });

  it('allows the Homebrew runtime roots advertised to macOS verification commands', () => {
    const launch = buildCrewSandboxLaunch(
      'true', process.cwd(), 'darwin', '/usr/bin/true',
    );
    const profile = launch.argv[2]!;
    const advertised = launch.env.PATH.split(':');

    for (const root of ['/opt/homebrew/Cellar', '/opt/homebrew/lib']) {
      if (!existsSync(root)) continue;
      expect(advertised).toContain('/opt/homebrew/bin');
      expect(profile).toContain(`(require-not (subpath ${JSON.stringify(root)}))`);
    }
    expect(profile).not.toContain('(require-not (subpath "/opt/homebrew/etc"))');
  });

  it('does not advertise a present sandbox executable that cannot launch', () => {
    expect(isCrewVerifierSandboxAvailable('darwin', '/usr/bin/false')).toBe(false);
    expect(isCrewVerifierSandboxAvailable('linux', '/usr/bin/false')).toBe(false);
  });
});
