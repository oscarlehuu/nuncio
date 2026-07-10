import { Injectable } from '@nestjs/common';
import { AttentionService } from '../attention/attention.service';
import type { CrewAttentionPort } from './crew-execution.ports';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewAttentionAdapter implements CrewAttentionPort {
  constructor(
    private readonly attention: AttentionService,
    private readonly runs: CrewRunsRepository,
  ) {
    this.attention.registerProbe('crew-blocked', (item) => {
      const run = this.runs.findById(item.subjectId);
      return run?.status === 'BLOCKED_USER' || run?.status === 'BLOCKED_PROVIDER';
    });
  }
  raise(input: Parameters<CrewAttentionPort['raise']>[0]): void {
    this.attention.raise(input);
  }
  clear(kind: 'crew-blocked', subjectId: string): void {
    this.attention.onConditionCleared(kind, subjectId);
  }
}
