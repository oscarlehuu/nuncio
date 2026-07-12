import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('core Crew exports', () => {
  it('exposes the Crew API and projection through the package root', () => {
    const exports = core as Record<string, unknown>;
    expect(typeof exports.fetchCrewProfiles).toBe('function');
    expect(typeof exports.projectCrewRun).toBe('function');
  });
});
