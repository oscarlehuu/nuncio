import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';
import type { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { configurePiSdkMock } from '../agents/pi-sdk.mock';

type FallbackManagerClass = {
  open: (path: string) => {
    getEntries(): unknown[];
    getSessionId(): string;
    getSessionName(): string;
    getCwd(): string;
  };
};

const managerClass: FallbackManagerClass = {
  open: () => {
    throw new Error('SessionManager.open was not configured for this test');
  },
};
configurePiSdkMock({ SessionManager: managerClass });

const fallbackPath = '/Users/me/.pi/agent/sessions/demo/fallback.jsonl';

function makeService(): PiLocalSessionsService {
  const repository = {
    findByProviderThreadId: () => null,
  } as unknown as SessionsRepository;
  const service = new PiLocalSessionsService(repository);
  service.loadSdk = async () => ({ SessionManager: { list: async () => [] } }) as never;
  return service;
}

describe('PiLocalSessionsService fallback workspace identity', () => {
  const unconfiguredOpen = managerClass.open;

  beforeEach(() => {
    managerClass.open = unconfiguredOpen;
  });

  afterEach(() => {
    managerClass.open = unconfiguredOpen;
  });

  it('rejects an unlisted session from a sibling workspace with a shared prefix', async () => {
    const workspace = '/tmp/demo-repo';
    managerClass.open = () => ({
      getEntries: () => [],
      getSessionId: () => 'foreign-session',
      getSessionName: () => 'Foreign task',
      getCwd: () => `${workspace}-sibling`,
    });

    expect(await makeService().find(fallbackPath, workspace)).toBeNull();
  });

  it('rejects an unlisted session without an authoritative workspace identity', async () => {
    managerClass.open = () => ({
      getEntries: () => [],
      getSessionId: () => 'missing-workspace-session',
      getSessionName: () => 'Missing workspace task',
      getCwd: () => '',
    });

    expect(await makeService().find(fallbackPath, '/tmp/demo-repo')).toBeNull();
  });

  it('accepts an unlisted session whose cwd is a canonical alias of the workspace', async () => {
    const identityRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-workspace-identity-'));
    const workspace = join(identityRoot, 'répo');
    const workspaceAlias = join(identityRoot, 'répo-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, workspaceAlias, 'dir');
    managerClass.open = () => ({
      getEntries: () => [],
      getSessionId: () => 'same-workspace-session',
      getSessionName: () => 'Same workspace task',
      getCwd: () => workspaceAlias,
    });

    try {
      expect(await makeService().find(fallbackPath, workspace)).toMatchObject({
        sessionId: 'same-workspace-session',
        workspace: workspaceAlias,
      });
    } finally {
      rmSync(identityRoot, { recursive: true, force: true });
    }
  });
});
