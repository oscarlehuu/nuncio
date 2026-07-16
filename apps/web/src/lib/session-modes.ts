import { Bug, Split, type LucideIcon } from 'lucide-react';
import type { SessionMode } from './api';

/** Default composer prompt copy when no mode is active (normal agent). */
export const DEFAULT_COMPOSER_PLACEHOLDER =
  'Ask Nuncio to build features, fix bugs, or work on your code…';

export interface ModeMeta {
  label: string;
  description: string;
  placeholder: string;
  icon: LucideIcon;
}

/**
 * Per-mode UI metadata. Mono styling per the B&W direction: modes differ by
 * icon + label, never colour.
 */
export const SESSION_MODE_META: Record<SessionMode, ModeMeta> = {
  debug: {
    label: 'Debug',
    description: 'Diagnose hypothesis-first, then fix',
    placeholder: 'Debug and troubleshoot issues…',
    icon: Bug,
  },
  multitask: {
    label: 'Multitask',
    description: 'Split the goal into parallel subtasks',
    placeholder: 'Coordinate parallel tasks…',
    icon: Split,
  },
};

/** The composer placeholder for the active mode (or the default for none). */
export function modePlaceholder(mode: SessionMode | null | undefined): string {
  return mode ? SESSION_MODE_META[mode].placeholder : DEFAULT_COMPOSER_PLACEHOLDER;
}
