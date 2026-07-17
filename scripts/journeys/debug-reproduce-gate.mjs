// Journey: a Mock-engine debug session pauses on the reproduction gate. The
// agent requests reproduction mid-turn; the "Reproduction Steps" gate renders in
// the session view with numbered steps, a live log counter, and both actions;
// pressing Proceed resumes the run through the steer path. The differentiator of
// Debug mode (D2), driven end-to-end against the offline engine.
import { createMockSession, MOCK_TASK_REPLY } from '../lib/mock-session.mjs';
import { transcriptText } from '../lib/transcript.mjs';

export async function runDebugReproduceGate(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  // The prompt carries the marker the Mock engine watches for, so it emits one
  // deterministic reproduction gate after its reply, then ends its turn.
  const requestStep = record('reproduce: mock debug agent requests reproduction mid-turn');
  const session = await createMockSession(
    baseUrl,
    'Smoke: debug this flake and reproduce-gate the failure',
    { mode: 'debug' },
  );
  if (session.mode !== 'debug') {
    throw new Error(`expected a debug-mode session, got mode=${session.mode}`);
  }
  const gates = await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/reproduce?sessionId=${session.id}`);
      if (!res.ok) return false;
      const list = await res.json();
      return list.length === 1 ? list : false;
    },
    { label: 'one open reproduction gate on the debug session' },
  );
  const gate = gates[0];
  if (gate.status !== 'requested' || gate.sessionId !== session.id || gate.steps.length < 1) {
    throw new Error(`unexpected gate shape: ${JSON.stringify(gate)}`);
  }
  requestStep.ok = true;
  requestStep.detail = `gate=${gate.id} ref=${gate.ref} steps=${gate.steps.length}`;

  const renderStep = record('reproduce: gate renders steps + live log counter + both actions');
  await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
  // Anchor on the streamed reply so we know the detail transcript actually rendered.
  await waitFor(async () => (await transcriptText(page, MOCK_TASK_REPLY, { exact: false }).count()) > 0, {
    label: 'debug session transcript hydrated',
  });
  await waitFor(async () => (await page.getByTestId('reproduce-gate').count()) === 1, {
    label: 'the Reproduction Steps gate in the session view',
  });
  const renderedSteps = await page.getByTestId('reproduce-gate-step').count();
  if (renderedSteps !== gate.steps.length) {
    throw new Error(`gate rendered ${renderedSteps} steps, expected ${gate.steps.length}`);
  }
  // Both terminal actions are present (the observed Cursor anatomy).
  if ((await page.getByTestId('reproduce-gate-proceed').count()) !== 1) {
    throw new Error('gate is missing the Proceed action');
  }
  if ((await page.getByTestId('reproduce-gate-mark-fixed').count()) !== 1) {
    throw new Error('gate is missing the Mark Fixed action');
  }
  renderStep.ok = true;

  const captureStep = record('reproduce: pasted logs bump the live "Logs, N entries" counter');
  await page.getByTestId('reproduce-gate-logs-input').fill('CHROME PID 4242 still alive\nserver PID 4300 gone');
  await page.getByTestId('reproduce-gate-capture').click();
  await waitFor(
    async () => /Logs, [1-9]\d* entr/i.test((await page.getByTestId('reproduce-gate-log-count').innerText()).trim()),
    { label: 'log counter reflects the captured lines' },
  );
  captureStep.ok = true;

  const proceedStep = record('reproduce: Proceed resumes the run and clears the gate');
  await page.getByTestId('reproduce-gate-proceed').click();
  // Proceed resumes the paused run: the Mock engine emits its steer reply, and
  // the gate is terminal, so it leaves both the UI and the open-gate list.
  await waitFor(async () => (await transcriptText(page, 'Steer received', { exact: false }).count()) > 0, {
    label: 'the resumed run streams its steer reply',
  });
  await waitFor(async () => (await page.getByTestId('reproduce-gate').count()) === 0, {
    label: 'the gate leaves the session view once resolved',
  });
  const afterRes = await fetch(`${baseUrl}/api/reproduce?sessionId=${session.id}`);
  const remaining = await afterRes.json();
  if (remaining.length !== 0) {
    throw new Error(`proceeded gate should leave the open list, still saw ${remaining.length}`);
  }
  proceedStep.ok = true;
  proceedStep.detail = `session=${session.id} resumed after gate=${gate.id}`;
}
