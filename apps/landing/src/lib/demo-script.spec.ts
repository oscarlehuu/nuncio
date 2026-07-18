import { describe, it, expect } from 'vitest';
import {
  SCENARIOS,
  scenarioDuration,
  revealedCount,
  statusForRevealed,
  steerBlocks,
} from './demo-script';

describe('demo scenarios', () => {
  it('every scenario is well-formed', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of SCENARIOS) {
      expect(scenario.prompt.length).toBeGreaterThan(0);
      expect(scenario.model).toContain(':');
      expect(scenario.blocks.length).toBeGreaterThan(0);
      expect(scenario.blocks.some((b) => b.kind === 'assistant')).toBe(true);
      expect(scenario.blocks.some((b) => b.kind === 'result')).toBe(true);
      for (const block of scenario.blocks) {
        expect(block.delayMs).toBeGreaterThan(0);
      }
    }
  });

  it('scenario ids are unique', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('revealedCount', () => {
  const scenario = SCENARIOS[0];

  it('reveals nothing at time zero', () => {
    expect(revealedCount(scenario, 0)).toBe(0);
  });

  it('reveals the first block only after its delay elapses', () => {
    const firstDelay = scenario.blocks[0].delayMs;
    expect(revealedCount(scenario, firstDelay - 1)).toBe(0);
    expect(revealedCount(scenario, firstDelay)).toBe(1);
  });

  it('reveals all blocks once the full duration elapses', () => {
    expect(revealedCount(scenario, scenarioDuration(scenario))).toBe(scenario.blocks.length);
    expect(revealedCount(scenario, scenarioDuration(scenario) + 5000)).toBe(scenario.blocks.length);
  });
});

describe('statusForRevealed', () => {
  const scenario = SCENARIOS[0];

  it('is CREATED before anything streams', () => {
    expect(statusForRevealed(scenario, 0)).toBe('CREATED');
  });

  it('is RUNNING mid-stream', () => {
    expect(statusForRevealed(scenario, 1)).toBe('RUNNING');
  });

  it('is IDLE once every block is revealed', () => {
    expect(statusForRevealed(scenario, scenario.blocks.length)).toBe('IDLE');
  });
});

describe('steerBlocks', () => {
  it('starts with the trimmed user message and ends with a result', () => {
    const blocks = steerBlocks('  Open a PR  ');
    expect(blocks[0].kind).toBe('user');
    expect(blocks[0].text).toBe('Open a PR');
    expect(blocks[blocks.length - 1].kind).toBe('result');
  });
});
