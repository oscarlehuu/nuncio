// Hidden layer for self-correct-on-verify-fail. This branch has no rung-1
// auto-retry loop, but the verify command is runnable BY the engine during its
// turn, so within-turn self-correction is still measurable from the verify_result
// events. (a) the final verify_result passed; (b) at most 3 verify_result events;
// (c) advisory: if no FAILED verify precedes the pass, note 'one-shot; loop
// unexercised' — not gating.
function verifyResults(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e?.type === 'verify_result');
}

export default function check({ sessionEvents }) {
  const notes = [];
  const results = verifyResults(sessionEvents);

  if (results.length === 0) {
    notes.push('no verify_result event — the verify gate never ran');
    return { pass: false, notes };
  }

  const finalPassed = results[results.length - 1]?.payload?.ok === true;
  if (!finalPassed) notes.push('final verify_result did not pass');

  const withinRounds = results.length <= 3;
  if (!withinRounds) notes.push(`too many verify rounds: ${results.length} (max 3)`);

  // Advisory (c): did a failure precede the pass? If not, it was a one-shot and
  // the correction loop was not exercised (expected on this branch — no rung-1).
  const failedBeforePass = results.slice(0, -1).some((r) => r?.payload?.ok !== true);
  notes.push(
    failedBeforePass
      ? 'advisory: a failed verify preceded the pass (self-correction exercised)'
      : 'advisory: one-shot; loop unexercised (no failed verify preceded the pass)',
  );

  const pass = finalPassed && withinRounds;
  if (pass) notes.push(`verify passed in ${results.length} round(s)`);
  return { pass, notes };
}
