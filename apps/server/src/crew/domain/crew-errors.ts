import type { CrewProfileDto, CrewProfileIssue, CrewRunDto } from './crew.types';

export class CrewNotFoundError extends Error {
  constructor(readonly aggregate: string, readonly id: string) {
    super(`${aggregate} ${id} not found`);
  }
}

export class CrewRevisionConflictError extends Error {
  readonly currentRevision: number;
  constructor(
    readonly runId: string,
    readonly expectedRevision: number,
    readonly current: CrewRunDto,
  ) {
    super(`CrewRun ${runId} revision conflict`);
    this.currentRevision = current.revision;
  }
}

export class CrewProfileRevisionConflictError extends Error {
  constructor(
    readonly profileId: string,
    readonly expectedRevision: number,
    readonly current: CrewProfileDto,
  ) {
    super(`Crew profile ${profileId} revision conflict`);
  }
}

export class CrewProfileNeedsSetupError extends Error {
  constructor(readonly issues: CrewProfileIssue[]) {
    super('Crew profile needs setup');
  }
}

export class CrewValidationError extends Error {}
