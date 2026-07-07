import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { ContextFactProposalsRepository } from '../../../src/context/context-fact-proposals.repository';
import { ContextFactsRepository } from '../../../src/context/context-facts.repository';
import { ContextFactsService } from '../../../src/context/context-facts.service';

describe('ContextFactsService', () => {
  let module: TestingModule;
  let service: ContextFactsService;
  let facts: ContextFactsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-facts-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [ContextFactsService, ContextFactsRepository, ContextFactProposalsRepository],
    }).compile();
    service = module.get(ContextFactsService);
    facts = module.get(ContextFactsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('validation', () => {
    it.each([
      ['UPPER', 'Bad-Key'],
      ['leading dash', '-bad'],
      ['space', 'bad key'],
      ['empty', ''],
      ['single char', 'a'],
      ['too long', 'a'.repeat(65)],
      ['unicode', 'kéy'],
    ])('rejects a bad slug (%s)', (_label, key) => {
      expect(() => service.upsert({ projectPath: '/p', key, value: 'v', provenance: 'founder' })).toThrow(
        BadRequestException,
      );
    });

    it('accepts a valid slug', () => {
      expect(service.upsert({ projectPath: '/p', key: 'build-command-2', value: 'v', provenance: 'founder' }).written).toBe(true);
    });

    it('rejects a value over 1024 serialized bytes (multibyte counted)', () => {
      const bigEmoji = '😀'.repeat(300); // 1200 bytes
      expect(() => service.upsert({ projectPath: '/p', key: 'k2', value: bigEmoji, provenance: 'founder' })).toThrow(
        BadRequestException,
      );
    });

    it('requires a projectPath', () => {
      expect(() => service.upsert({ projectPath: '', key: 'k3', value: 'v', provenance: 'founder' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('provenance matrix (B3)', () => {
    const P = '/matrix';

    it('rule 1: founder upsert always wins (over founder and over agent)', () => {
      service.upsert({ projectPath: P, key: 'r1', value: 'founder-1', provenance: 'founder' });
      const r = service.upsert({ projectPath: P, key: 'r1', value: 'founder-2', provenance: 'founder' });
      expect(r.written).toBe(true);
      expect(facts.getByKey(P, 'r1')?.value).toBe('founder-2');

      // now overwrite an agent fact with founder
      service.upsert({ projectPath: P, key: 'r1b', value: 'agent', provenance: 'agent', sourceSessionId: 's' });
      const r2 = service.upsert({ projectPath: P, key: 'r1b', value: 'founder', provenance: 'founder' });
      expect(r2.written).toBe(true);
      expect(facts.getByKey(P, 'r1b')?.provenance).toBe('founder');
    });

    it('rule 2: agent on a NEW key writes directly with source session', () => {
      const r = service.upsert({ projectPath: P, key: 'r2', value: 'v', provenance: 'agent', sourceSessionId: 'sess-2' });
      expect(r.written).toBe(true);
      const fact = facts.getByKey(P, 'r2');
      expect(fact?.provenance).toBe('agent');
      expect(fact?.sourceSessionId).toBe('sess-2');
    });

    it('rule 3: agent overwrites an existing AGENT fact (latest wins)', () => {
      service.upsert({ projectPath: P, key: 'r3', value: 'v1', provenance: 'agent', sourceSessionId: 's1' });
      const r = service.upsert({ projectPath: P, key: 'r3', value: 'v2', provenance: 'agent', sourceSessionId: 's2' });
      expect(r.written).toBe(true);
      expect(facts.getByKey(P, 'r3')?.value).toBe('v2');
    });

    it('rule 4: agent on an existing FOUNDER fact is rejected → pending proposal, fact unchanged', () => {
      service.upsert({ projectPath: P, key: 'r4', value: 'founder-val', provenance: 'founder' });
      const r = service.upsert({ projectPath: P, key: 'r4', value: 'agent-val', provenance: 'agent', sourceSessionId: 'sess-4' });
      expect(r.written).toBe(false);
      expect(r.proposed).toBe(true);
      // fact unchanged
      expect(facts.getByKey(P, 'r4')?.value).toBe('founder-val');
      // proposal pending
      expect(service.listProposals(P).some((p) => p.key === 'r4' && p.status === 'pending')).toBe(true);
    });

    it('rule 4 dedupe: an identical agent proposal does not create a second pending row', () => {
      service.upsert({ projectPath: P, key: 'r4d', value: 'F', provenance: 'founder' });
      service.upsert({ projectPath: P, key: 'r4d', value: 'A', provenance: 'agent', sourceSessionId: 's' });
      service.upsert({ projectPath: P, key: 'r4d', value: 'A', provenance: 'agent', sourceSessionId: 's' });
      expect(service.listProposals(P).filter((p) => p.key === 'r4d')).toHaveLength(1);
    });
  });

  describe('proposal accept / dismiss', () => {
    const P = '/accept';

    it('accept upserts founder provenance and marks the proposal accepted', () => {
      service.upsert({ projectPath: P, key: 'a1', value: 'F', provenance: 'founder' });
      const rej = service.upsert({ projectPath: P, key: 'a1', value: 'A', provenance: 'agent', sourceSessionId: 's' });
      const proposal = service.listProposals(P).find((p) => p.id === rej.proposalId)!;

      const accepted = service.acceptProposal(proposal.id);
      expect(accepted?.status).toBe('accepted');
      const fact = facts.getByKey(P, 'a1');
      expect(fact?.value).toBe('A');
      expect(fact?.provenance).toBe('founder');
      // No longer pending.
      expect(service.listProposals(P).some((p) => p.id === proposal.id)).toBe(false);
    });

    it('dismiss marks the proposal dismissed without touching the fact', () => {
      service.upsert({ projectPath: P, key: 'a2', value: 'F', provenance: 'founder' });
      const rej = service.upsert({ projectPath: P, key: 'a2', value: 'A', provenance: 'agent', sourceSessionId: 's' });
      expect(service.dismissProposal(rej.proposalId!)?.status).toBe('dismissed');
      expect(facts.getByKey(P, 'a2')?.value).toBe('F');
    });

    it('accepting a missing proposal returns null (no-op)', () => {
      expect(service.acceptProposal('nope')).toBeNull();
    });
  });
});
