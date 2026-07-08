import { Injectable } from '@nestjs/common';
import type {
  ObservabilityMetrics,
  ObservabilityRollupDto,
  SessionObservabilityDto,
  TimelineEntryDto,
} from './observability.types';

@Injectable()
export class ObservabilityService {
  summary(): ObservabilityMetrics {
    throw new Error('TODO: implement observability summary read model');
  }

  session(_id: string): SessionObservabilityDto {
    throw new Error('TODO: implement session observability read model');
  }

  rollups(): ObservabilityRollupDto[] {
    throw new Error('TODO: implement observability rollups read model');
  }

  timeline(): TimelineEntryDto[] {
    throw new Error('TODO: implement observability timeline read model');
  }
}
