import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewArtifactStore } from '../../../src/crew/crew-artifact.store';
import { DatabaseService } from '../../../src/db/database.service';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';

describe('CrewArtifactStore', () => {
  let dataDir: string;
  let database: DatabaseService;
  let artifacts: CrewArtifactsRepository;
  let store: CrewArtifactStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-crew-artifact-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    artifacts = new CrewArtifactsRepository(database);
    store = new CrewArtifactStore(database, artifacts);
  });
  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('redacts secrets before durable write and hashes the complete redacted log', () => {
    const raw = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnop',
      'Authorization: Bearer abc.def.secret',
      'github=ghp_abcdefghijklmnopqrstuvwxyz123456',
      'x'.repeat(5000),
    ].join('\n');
    const stored = store.writeLog({ runId: 'run-1', kind: 'verify-log', content: raw, previewBytes: 128 });
    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(stored.preview)).toBeLessThanOrEqual(128);

    const full = store.readRange('run-1', stored.artifact.id, 0, 65_536);
    expect(full.text).not.toContain('sk-proj-abcdefghijklmnop');
    expect(full.text).not.toContain('abc.def.secret');
    expect(full.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(stored.artifact.byteCount).toBe(Buffer.byteLength(full.text));
    expect(stored.artifact.sha256).toBe(createHash('sha256').update(full.text).digest('hex'));
  });

  it('redacts every high-confidence checkpoint token family and private keys before persistence', () => {
    const secrets = [
      `AKIA${'A'.repeat(16)}`, `AIza${'A'.repeat(35)}`, `xoxb-${'A'.repeat(24)}`,
      `glpat-${'A'.repeat(24)}`, `github_pat_${'A'.repeat(44)}`,
      `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(100)}\n-----END PRIVATE KEY-----`,
    ];
    const stored = store.writeLog({ runId: 'run-1', kind: 'verify-log', content: secrets.join('\n') });
    const text = store.readRange('run-1', stored.artifact.id).text;
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED');
  });

  it('recursively redacts verifier metadata strings before SQLite persistence', () => {
    const token = `sk-proj-${'m'.repeat(32)}`;
    const workspaceHead = 'a'.repeat(40);
    const stored = store.writeLog({
      runId: 'run-1', kind: 'verify-log', content: 'failed',
      metadata: {
        workspaceHead, exitCode: 1, timedOut: false,
        command: `bun test --token=${token}`,
        spawnError: `provider echoed ${token}`,
        nested: { postReason: `boundary ${token}`, attempts: [`retry ${token}`] },
      },
    });

    const fromDatabase = artifacts.findById(stored.artifact.id)!;
    expect(JSON.stringify(fromDatabase.metadata)).not.toContain(token);
    expect(JSON.stringify(fromDatabase.metadata)).toContain('[REDACTED]');
    expect(fromDatabase.metadata).toMatchObject({
      workspaceHead, exitCode: 1, timedOut: false,
    });
  });

  it('supports bounded progressive reads and denies cross-run artifact access', () => {
    const stored = store.writeLog({ runId: 'run-1', kind: 'verify-log', content: '0123456789' });
    expect(store.readRange('run-1', stored.artifact.id, 2, 4)).toEqual({
      artifactId: stored.artifact.id, offset: 2, nextOffset: 6, eof: false, text: '2345',
    });
    expect(() => store.readRange('run-2', stored.artifact.id, 0, 4)).toThrow('not found');
    expect(() => store.readRange('run-1', stored.artifact.id, 0, 100_000)).toThrow('limit');
    expect(() => store.readRange('run-1', stored.artifact.id, 11, 1)).toThrow('offset');
  });

  it('keeps progressive UTF-8 ranges lossless and rejects a mid-codepoint offset', () => {
    const stored = store.writeLog({ runId: 'run-1', kind: 'verify-log', content: 'aa🙂bb' });
    expect(store.readRange('run-1', stored.artifact.id, 0, 3)).toMatchObject({
      offset: 0, nextOffset: 2, eof: false, text: 'aa',
    });
    expect(store.readRange('run-1', stored.artifact.id, 2, 4)).toMatchObject({
      offset: 2, nextOffset: 6, eof: false, text: '🙂',
    });
    expect(() => store.readRange('run-1', stored.artifact.id, 3, 4)).toThrow('UTF-8');
  });

  it('keeps bounded previews on a UTF-8 boundary', () => {
    const stored = store.writeLog({
      runId: 'run-1', kind: 'verify-log', content: 'a🙂b', previewBytes: 2,
    });
    expect(stored).toMatchObject({ preview: 'a', truncated: true });
    expect(stored.preview).not.toContain('�');
  });

  it('fails closed when stored artifact bytes no longer match durable size/hash metadata', () => {
    const stored = store.writeLog({ runId: 'run-1', kind: 'verify-log', content: 'trusted' });
    writeFileSync(join(dataDir, 'crew-artifacts', stored.artifact.relativeStoragePath), 'tampered');
    expect(() => store.readRange('run-1', stored.artifact.id)).toThrow('integrity');
  });

  it('refuses writes after database shutdown', () => {
    database.onModuleDestroy();
    expect(() => store.writeLog({ runId: 'run-1', kind: 'verify-log', content: 'late' })).toThrow('closed');
  });
});
