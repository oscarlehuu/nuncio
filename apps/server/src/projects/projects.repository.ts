import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type { ProjectDto, UpsertProjectDto } from './projects.types';

/**
 * Durable per-project config, keyed by normalized path. SKELETON — the sub-phase
 * A red suite drives the contract; methods throw until implemented so tests fail
 * for the right reason (missing feature) rather than an unresolved import.
 */
@Injectable()
export class ProjectsRepository {
  constructor(private readonly database: DatabaseService) {
    void this.database;
  }

  /** Create-or-patch by path. Patch semantics: omitted fields unchanged. */
  upsert(_input: UpsertProjectDto): ProjectDto {
    throw new Error('ProjectsRepository.upsert not implemented');
  }

  findByPath(_path: string): ProjectDto | null {
    throw new Error('ProjectsRepository.findByPath not implemented');
  }

  list(): ProjectDto[] {
    throw new Error('ProjectsRepository.list not implemented');
  }

  delete(_path: string): void {
    throw new Error('ProjectsRepository.delete not implemented');
  }
}
