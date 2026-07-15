// Pure helpers for the coverage ratchet (see check-coverage-ratchet.mjs).
// The baseline is a floor that only moves up: PRs may not drop line coverage
// below `baseline - tolerancePct`; improvements should re-run --update.

/**
 * Total line coverage (%) from an lcov report: sum of LH over sum of LF,
 * falling back to counting DA entries for records without LF/LH.
 * @param {string} lcovText
 * @returns {number}
 */
export function lineCoverageFromLcov(lcovText) {
  let found = 0;
  let hit = 0;
  let daFound = 0;
  let daHit = 0;
  let sawLf = false;
  for (const raw of lcovText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('LF:')) {
      sawLf = true;
      found += Number(line.slice(3));
    } else if (line.startsWith('LH:')) {
      hit += Number(line.slice(3));
    } else if (line.startsWith('DA:')) {
      daFound += 1;
      if (Number(line.slice(3).split(',')[1]) > 0) daHit += 1;
    }
  }
  if (!sawLf) {
    found = daFound;
    hit = daHit;
  }
  if (found === 0) {
    throw new Error('lcov report contains no line coverage data');
  }
  return (hit / found) * 100;
}

/**
 * Total line coverage (%) from a vitest `json-summary` report.
 * @param {{ total?: { lines?: { pct?: unknown } } }} summary
 * @returns {number}
 */
export function lineCoverageFromVitestSummary(summary) {
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== 'number' || Number.isNaN(pct)) {
    throw new Error('coverage summary missing total.lines.pct');
  }
  return pct;
}

/**
 * @param {Record<string, number>} current  target → measured line coverage %
 * @param {{ tolerancePct: number, targets: Record<string, number> }} baseline
 * @returns {{ failures: Array<{target: string, current: number|null, baseline: number, floor: number}>, improved: string[] }}
 */
export function compareCoverageToBaseline(current, baseline) {
  const failures = [];
  const improved = [];
  for (const [target, base] of Object.entries(baseline.targets)) {
    const floor = round2(base - baseline.tolerancePct);
    const measured = current[target];
    if (typeof measured !== 'number') {
      failures.push({ target, current: null, baseline: base, floor });
      continue;
    }
    if (measured < floor) {
      failures.push({ target, current: measured, baseline: base, floor });
    } else if (measured > base + baseline.tolerancePct) {
      improved.push(target);
    }
  }
  return { failures, improved };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
