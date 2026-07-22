import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsService } from '../../../src/settings/settings.service';

/**
 * Nuncio Engine is the only engine shown. The vendor engines (Claude, Codex,
 * Cursor, Devin) are legacy: hidden from every picker by default, resolvable
 * forever so their existing sessions keep opening. A single setting flips the
 * legacy engines back into view without a restart.
 */
describe('AgentRegistry legacy-engine visibility', () => {
  let module: TestingModule;
  let dataDir: string;

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
    delete process.env.NUNCIO_ENGINES_SHOW_LEGACY;
  });

  async function bootRegistry(): Promise<{ registry: AgentRegistry; settings: SettingsService }> {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-legacy-vis-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
    }).compile();
    return { registry: module.get(AgentRegistry), settings: module.get(SettingsService) };
  }

  it('lists only Nuncio Engine when the legacy flag is off (default)', async () => {
    const { registry } = await bootRegistry();

    expect(registry.all().map((provider) => provider.id)).toEqual(['pi']);
  });

  it('keeps resolving every legacy engine by id so their sessions still open', async () => {
    const { registry } = await bootRegistry();

    for (const id of ['pi', 'cursor', 'codex', 'claude', 'devin', 'cursor-cli']) {
      expect(registry.get(id).id).toBe(id);
    }
  });

  it('excludes an otherwise-available legacy engine from available() while hidden', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    const { registry } = await bootRegistry();

    expect((await registry.available()).map((provider) => provider.id)).not.toContain('cursor');
  });

  it('shows the legacy engines in all() when the flag is on', async () => {
    process.env.NUNCIO_ENGINES_SHOW_LEGACY = '1';
    const { registry } = await bootRegistry();

    expect(registry.all().map((provider) => provider.id).sort()).toEqual([
      'claude',
      'codex',
      'cursor',
      'devin',
      'pi',
    ]);
  });

  it('reveals a now-available legacy engine in available() when the flag is on', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    process.env.NUNCIO_ENGINES_SHOW_LEGACY = '1';
    const { registry } = await bootRegistry();

    expect((await registry.available()).map((provider) => provider.id)).toContain('cursor');
  });

  it('re-reads the flag at runtime - flipping it on reveals legacy without a restart', async () => {
    const { registry, settings } = await bootRegistry();
    expect(registry.all().map((provider) => provider.id)).toEqual(['pi']);

    settings.set('engines.showLegacy', '1');

    expect(registry.all().map((provider) => provider.id).sort()).toEqual([
      'claude',
      'codex',
      'cursor',
      'devin',
      'pi',
    ]);
  });
});
