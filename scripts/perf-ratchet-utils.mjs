// Pure helpers for the UI smoothness perf ratchet (see check-perf-ratchet.mjs).
// Every gated metric is a duration in ms where LOWER IS BETTER (the opposite of
// the coverage ratchet). A metric regresses when its median climbs above the
// committed baseline by more than the tolerance band; a report-only metric is
// measured and printed but never fails the gate. The band is deliberately
// generous (default 30%) and every metric is a MEDIAN of >= 3 samples, because
// browser timings on a shared CI runner are noisy — a tight gate would flap.

/** Absolute floor (ms) below which the ratio test is meaningless and we compare
 *  with an additive band instead. Guards baselines that measured ~0 (e.g. a
 *  quiet main thread with zero long-task blocking) from a divide-by-zero blowup. */
export const NEAR_ZERO_MS = 1;

/**
 * Median of a numeric sample set. Throws on empty input — a metric with zero
 * samples is a harness bug and must be loud, never a silent 0 that "passes".
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires at least one sample');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Reduce a metric's raw samples to the recorded summary: median plus the spread
 * (min/max and coefficient of variation) so a reviewer can judge stability and
 * decide gated vs report-only. cv = stddev/mean, 0 when the mean is ~0.
 * @param {number[]} samples
 */
export function summarize(samples) {
  const med = median(samples);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const cv = mean > NEAR_ZERO_MS ? Math.sqrt(variance) / mean : 0;
  return { median: round2(med), min: round2(min), max: round2(max), cv: round2(cv), samples };
}

/**
 * Fail CLOSED on a malformed baseline. A baseline that parses as JSON but is
 * schema-broken (missing `tolerancePct`, non-numeric `median`) would make the
 * ceiling NaN, and `measured > NaN` is always false — so every regression would
 * silently PASS. Reject it as corrupt instead, matching the "present-but-corrupt
 * baseline is a hard error" contract. Every gating input must be a finite number.
 * @param {unknown} baseline
 */
export function assertValidBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('perf baseline must be an object');
  }
  if (!Number.isFinite(baseline.tolerancePct) || baseline.tolerancePct <= 0) {
    throw new Error(`perf baseline tolerancePct must be a positive finite number, got ${baseline.tolerancePct}`);
  }
  const { metrics } = baseline;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('perf baseline.metrics must be an object');
  }
  const names = Object.keys(metrics);
  if (names.length === 0) {
    throw new Error('perf baseline.metrics is empty — nothing to gate');
  }
  for (const name of names) {
    const base = metrics[name];
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      throw new Error(`perf baseline metric ${name} must be an object`);
    }
    if (!Number.isFinite(base.median)) {
      throw new Error(`perf baseline metric ${name}.median must be a finite number, got ${base.median}`);
    }
    if ('gated' in base && typeof base.gated !== 'boolean') {
      throw new Error(`perf baseline metric ${name}.gated must be a boolean, got ${base.gated}`);
    }
  }
}

/**
 * Compare measured medians against the committed baseline. Only metrics marked
 * `gated: true` in the baseline can fail; report-only ones are returned for
 * printing. Lower is better, so the ceiling is baseline*(1+tolerance) — at the
 * ceiling PASSES, strictly above fails. Near-zero baselines fall back to an
 * additive band (baseline + max(NEAR_ZERO_MS, baseline*tolerance)). Throws on a
 * malformed baseline (see assertValidBaseline) rather than failing open.
 *
 * @param {Record<string, { median: number }>} current  metric → measured summary
 * @param {{ tolerancePct: number, metrics: Record<string, { median: number, gated?: boolean }> }} baseline
 * @returns {{ failures: Array<{metric,current,baseline,ceiling}>, reportOnly: string[], improved: string[], extras: string[] }}
 */
export function compareMetricsToBaseline(current, baseline) {
  assertValidBaseline(baseline);
  const failures = [];
  const reportOnly = [];
  const improved = [];
  const tol = baseline.tolerancePct;
  for (const [metric, base] of Object.entries(baseline.metrics)) {
    const ceiling = ceilingFor(base.median, tol);
    const measured = current[metric]?.median;
    if (!base.gated) {
      reportOnly.push(metric);
      continue;
    }
    if (typeof measured !== 'number' || Number.isNaN(measured)) {
      failures.push({ metric, current: null, baseline: base.median, ceiling });
      continue;
    }
    if (measured > ceiling) {
      failures.push({ metric, current: round2(measured), baseline: base.median, ceiling });
    } else if (measured < floorFor(base.median, tol)) {
      improved.push(metric);
    }
  }
  const extras = Object.keys(current).filter((m) => !(m in baseline.metrics));
  return { failures, reportOnly, improved, extras };
}

/** Regression ceiling (ms): additive near zero, multiplicative otherwise. */
export function ceilingFor(baselineMs, tol) {
  const band = Math.max(NEAR_ZERO_MS, baselineMs * tol);
  return round2(baselineMs <= NEAR_ZERO_MS ? baselineMs + band : baselineMs * (1 + tol));
}

/** Improvement floor (ms): below this the metric got meaningfully faster. */
export function floorFor(baselineMs, tol) {
  return round2(baselineMs <= NEAR_ZERO_MS ? 0 : baselineMs * (1 - tol));
}
