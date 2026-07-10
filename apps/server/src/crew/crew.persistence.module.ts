import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { CrewArtifactsRepository } from './persistence/crew-artifacts.repository';
import { CrewEventsRepository } from './persistence/crew-events.repository';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewProfilesRepository } from './persistence/crew-profiles.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewTasksRepository } from './persistence/crew-tasks.repository';
import { CrewWriterLeasesRepository } from './persistence/crew-writer-leases.repository';

const REPOSITORIES = [
  CrewArtifactsRepository, CrewEventsRepository, CrewMembersRepository, CrewProfilesRepository,
  CrewResultsRepository, CrewRunsRepository, CrewTasksRepository, CrewWriterLeasesRepository,
];

@Module({ imports: [DatabaseModule], providers: REPOSITORIES, exports: REPOSITORIES })
export class CrewPersistenceModule {}
