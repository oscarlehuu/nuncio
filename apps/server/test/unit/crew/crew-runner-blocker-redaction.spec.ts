import { CrewRunnerBlockerService } from '../../../src/crew/crew-runner-blocker.service';
import type { CrewRunDto } from '../../../src/crew/domain/crew.types';

const token = `sk-proj-${'x'.repeat(32)}`;
const run = {
  id: 'run-1', taskId: 'task-1', phase: 'BUILD', status: 'RUNNING', revision: 3,
  projectPath: '/repo', blockedReason: null,
} as CrewRunDto;

describe('CrewRunnerBlockerService reason redaction', () => {
  it.each(['provider', 'recovery'] as const)(
    'redacts %s failure reasons before event and Attention persistence',
    (method) => {
      const applied: unknown[] = [];
      const runs = {
        applyEvent: (_id: string, input: unknown) => {
          applied.push(input);
          return { ...run, status: method === 'provider' ? 'BLOCKED_PROVIDER' : 'BLOCKED_USER' };
        },
      };
      const raise = jest.fn();
      const service = new CrewRunnerBlockerService(
        runs as never,
        { raise, clear: jest.fn() } as never,
      );

      service[method](run, `provider echoed ${token}`);

      expect(JSON.stringify(applied)).not.toContain(token);
      expect(JSON.stringify(applied)).toContain('[REDACTED]');
      expect(JSON.stringify(raise.mock.calls)).not.toContain(token);
      expect(JSON.stringify(raise.mock.calls)).toContain('[REDACTED]');
    },
  );
});
