import type { DigestRunDto } from './api';

export function digestNarrative(dto: DigestRunDto): string {
  const { loops, attention, sessions } = dto.digest;
  const runs = loops.runsOk + loops.runsFailed;
  const needsYou = attention.openTopCount + sessions.needsYou;
  const quiet = runs === 0 && loops.prsOpened === 0 && sessions.completed === 0 && needsYou === 0;

  if (quiet) return 'Quiet night — nothing ran, nothing needs you.';

  const window = dto.variant === 'evening' ? 'Today' : 'Overnight';
  return `${window}: ${runs} ${runs === 1 ? 'run' : 'runs'}, ${loops.runsOk} green, ${loops.prsOpened} ${loops.prsOpened === 1 ? 'PR' : 'PRs'} opened — ${needsYou} ${needsYou === 1 ? 'thing needs' : 'things need'} you.`;
}
