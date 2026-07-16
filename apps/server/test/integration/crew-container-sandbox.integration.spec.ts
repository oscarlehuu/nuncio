import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewCommandRunner } from '../../src/crew/crew-command.runner';
import { CrewSandboxBackendRegistry, hostCrewSandboxBackend } from '../../src/crew/crew-sandbox-backend';
import {
  containerCrewSandboxBackend, isCrewContainerRuntimeAvailable, resolveContainerRuntime,
} from '../../src/crew/crew-container-sandbox';

// Gate on a genuinely reachable Docker/Podman daemon, mirroring how the bubblewrap/Seatbelt suites
// skip on hosts without a real sandbox. On CI or a machine with the daemon down this skips entirely
// and never touches a container runtime.
const runtime = resolveContainerRuntime();
const daemonAvailable = isCrewContainerRuntimeAvailable();
const suite = runtime && daemonAvailable ? describe : describe.skip;
const IMAGE = 'busybox:stable';

suite('Crew container sandbox backend (integration, real daemon)', () => {
  let runner: CrewCommandRunner;
  let workspace: string;
  let imageReady = false;

  beforeAll(() => {
    // Pre-pull once so the network-disabled container never needs to fetch. A registry-access failure
    // is not a product bug, so the body self-skips rather than failing CI.
    const pull = spawnSync(runtime!.bin, ['pull', IMAGE], { stdio: 'ignore', timeout: 120_000 });
    imageReady = pull.status === 0;
    const registry = new CrewSandboxBackendRegistry([hostCrewSandboxBackend, containerCrewSandboxBackend]);
    runner = new CrewCommandRunner(registry);
  });

  beforeEach(() => { workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-container-it-'))); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function run(command: string, timeoutMs = 30_000) {
    return runner.run(command, workspace, timeoutMs, undefined, undefined, {
      backend: 'container', container: { image: IMAGE },
    });
  }

  it('runs the verify command inside the container and captures its output', async () => {
    if (!imageReady) return;
    const result = await run('printf ok; exit 0');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.spawnError).toBeNull();
  });

  it('surfaces a non-zero exit code from the container', async () => {
    if (!imageReady) return;
    const result = await run('exit 7');
    expect(result.exitCode).toBe(7);
  });

  it('writes into the bind-mounted workspace as the host user', async () => {
    if (!imageReady) return;
    const result = await run('echo persisted > /workspace/out.txt');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('persisted\n');
    // --user maps writes back to the host uid so the disposable snapshot stays host-cleanable.
    expect(statSync(join(workspace, 'out.txt')).uid).toBe(process.getuid!());
  });

  it('disables container networking', async () => {
    if (!imageReady) return;
    // With --network none the only interface is loopback, so an outbound fetch cannot succeed. The
    // literal IP avoids DNS (also unavailable) so the failure is the missing route, not name lookup.
    const result = await run('wget -T 3 -q -O /dev/null http://1.1.1.1/ ; echo exit=$?', 20_000);
    expect(result.stdout.trim().endsWith('exit=0')).toBe(false);
  });
});
