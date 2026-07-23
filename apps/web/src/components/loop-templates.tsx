import { BookText, Bug, FlaskConical, GitPullRequestArrow, Moon, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScheduleMode } from './loop-schedule-fields';
import type { StopCondition } from '../lib/api';
import { Button } from '@/components/ui/button';

/**
 * Curated starting points mapped to nuncio's loop families. Client-side only —
 * "Add" prefills the create form (the user still picks a project). Kept in one
 * file: a template is pure data (goal + schedule + budget/stop) plus display copy.
 */
export interface LoopTemplate {
  id: string;
  name: string;
  blurb: string;
  icon: LucideIcon;
  goal: string;
  schedule: {
    mode: ScheduleMode;
    time?: string;
    interval?: number;
    unit?: 'm' | 'h';
    weekday?: string;
    event?: string;
    label?: string;
  };
  maxRunsPerDay?: number;
  stop?: StopCondition;
}

export const LOOP_TEMPLATES: readonly LoopTemplate[] = [
  {
    id: 'nightly-maintenance',
    name: 'Nightly maintenance',
    blurb: 'Update dependencies and run the project gate each night, opening a PR when it stays green.',
    icon: Moon,
    goal: 'Update outdated dependencies, run the project checks, and open a pull request if everything passes.',
    schedule: { mode: 'daily', time: '02:00' },
    maxRunsPerDay: 1,
  },
  {
    id: 'docs-drift',
    name: 'Docs drift sweep',
    blurb: 'Once a week, reconcile the README and docs against the code and fix anything stale.',
    icon: BookText,
    goal: 'Review the README and docs/ against the current code, correct anything out of date, and open a PR.',
    schedule: { mode: 'weekday', weekday: 'sun', time: '09:00' },
    maxRunsPerDay: 1,
  },
  {
    id: 'test-coverage',
    name: 'Add test coverage',
    blurb: 'Chip away at untested code, stopping once three runs land green in a row.',
    icon: ShieldCheck,
    goal: 'Find an under-tested module, add meaningful tests for it, and make sure the suite passes.',
    schedule: { mode: 'interval', interval: 6, unit: 'h' },
    stop: { kind: 'verifyGreenN', n: 3 },
  },
  {
    id: 'flaky-hunter',
    name: 'Flaky-test hunter',
    blurb: 'Re-run the suite periodically to surface and fix intermittently failing tests.',
    icon: FlaskConical,
    goal: 'Run the test suite, identify any flaky or intermittently failing tests, and stabilize them.',
    schedule: { mode: 'interval', interval: 4, unit: 'h' },
    maxRunsPerDay: 6,
  },
  {
    id: 'bug-triage',
    name: 'Bug backlog triage',
    blurb: 'Work through open bug reports, reproduce, and draft a fix for the most actionable one.',
    icon: Bug,
    goal: 'Pick the most actionable open bug, reproduce it, and open a PR with a fix and a regression test.',
    schedule: { mode: 'daily', time: '10:00' },
    maxRunsPerDay: 2,
  },
  {
    id: 'issue-triage',
    name: 'Issue triage',
    blurb: 'React to a new issue labeled agent and open a triage task automatically.',
    icon: GitPullRequestArrow,
    goal: 'Triage a newly opened issue labeled agent: reproduce, label, and draft an initial fix.',
    schedule: { mode: 'event', event: 'issue.opened', label: 'agent' },
  },
];

interface LoopTemplatesProps {
  onPick: (template: LoopTemplate) => void;
}

export function LoopTemplates({ onPick }: LoopTemplatesProps) {
  return (
    <section aria-labelledby="templates-heading" className="mt-8">
      <h2 id="templates-heading" className="mb-1 text-ui-lg font-semibold text-foreground">
        Start from a template
      </h2>
      <p className="mb-4 text-ui text-muted-foreground">
        Common maintenance standing tasks, ready to point at a project.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {LOOP_TEMPLATES.map((template) => {
          const Icon = template.icon;
          return (
            <div
              key={template.id}
              className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground shadow-e0">
                  <Icon className="size-4" />
                </span>
                <h3 className="text-ui-lg font-medium text-foreground">{template.name}</h3>
              </div>
              <p className="flex-1 text-ui text-muted-foreground leading-relaxed">{template.blurb}</p>
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPick(template)}
                  aria-label={`Use the ${template.name} template`}
                >
                  Use template
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
