// Hidden, runner-side assertion for the mock proof task. Lives OUTSIDE the
// fixture so the engine under test cannot see or optimize against it. The one
// thing the mock provider reliably produces is a terminal assistant reply, so
// the hidden layer proves the full loop actually ran the agent: it asserts the
// session event log contains at least one `assistant_message`.
//
// Contract: ({ fixtureDir, taskDto, sessionEvents }) => { pass, notes[] }
export default function check({ sessionEvents }) {
  const notes = [];
  const events = Array.isArray(sessionEvents) ? sessionEvents : [];
  const assistantMessages = events.filter((e) => e?.type === 'assistant_message');

  if (assistantMessages.length === 0) {
    notes.push(
      `expected >=1 assistant_message event, found 0 (of ${events.length} total events)`,
    );
    return { pass: false, notes };
  }

  notes.push(`found ${assistantMessages.length} assistant_message event(s)`);
  return { pass: true, notes };
}
