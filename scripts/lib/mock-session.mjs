// Helpers for driving Mock-provider sessions in the level-5 journey suite. The
// session is CREATED over loopback REST (always trusted by the AuthGuard, no
// token) so the browser can then drive/observe everything else through the UI.

/** The Mock provider's deterministic completed reply to an initial task. */
export const MOCK_TASK_REPLY =
  'I received your task. In mock mode (agent auth not configured), I simulate agent output. ' +
  'Configure a real provider to use an agent SDK harness.';

/** POST a Mock session and assert the create response shape. */
export async function createMockSession(baseUrl, prompt) {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, provider: 'mock' }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const session = await res.json();
  if (session.provider !== 'mock' || !session.id) {
    throw new Error(`unexpected create response: ${JSON.stringify(session)}`);
  }
  return session;
}

/** Resolve once the server reports the session IDLE. */
export async function waitSessionIdle(baseUrl, id, waitFor, label = 'mock session to settle IDLE') {
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${id}`);
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === 'IDLE';
    },
    { label },
  );
}

/** The active (non-archived) session list. */
export async function listActiveSessions(baseUrl) {
  const res = await fetch(`${baseUrl}/api/sessions`);
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  return res.json();
}
