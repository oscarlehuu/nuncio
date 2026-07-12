import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CrewWriterLeasesRepository } from './persistence/crew-writer-leases.repository';

@Injectable()
export class CrewWriterLeaseService {
  constructor(private readonly leases: CrewWriterLeasesRepository) {}
  acquire(input: {
    runId: string; memberSessionId: string; memberKey: string; taskId?: string | null; startingHead: string;
  }) {
    if (input.memberKey !== 'builder:primary') throw new Error('Only the fixed Builder may hold a writer lease');
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(input.startingHead)) {
      throw new Error('Writer lease requires a full Git head');
    }
    if (this.leases.get(input.runId)) throw new Error(`CrewRun ${input.runId} already has a writer`);
    try {
      return this.leases.acquire({
        runId: input.runId, memberSessionId: input.memberSessionId,
        taskId: input.taskId ?? null, token: randomUUID(), startingHead: input.startingHead,
      });
    } catch {
      throw new Error(`CrewRun ${input.runId} already has a writer`);
    }
  }
  release(runId: string, token: string): boolean { return this.leases.release(runId, token); }
  get(runId: string) { return this.leases.get(runId); }
}
