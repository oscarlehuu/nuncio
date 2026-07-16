// Journey (regression guard): archiving the LAST remaining active session must
// not blank-screen — the app has to leave the session route and land on a
// rendered Home. Also proves archiving a non-final session behaves, and that
// archive is driven from the session route while the detail view is open.
import { createMockSession, listActiveSessions, waitSessionIdle } from '../lib/mock-session.mjs';

async function archiveViaRest(baseUrl, id) {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/archive`, { method: 'POST' });
  if (!res.ok) throw new Error(`archive ${id} failed: ${res.status} ${await res.text()}`);
}

async function archiveFromDetail(ctx, id) {
  const { page, baseUrl, waitFor } = ctx;
  await page.goto(`${baseUrl}/session/${id}`, { waitUntil: 'domcontentloaded' });
  // Detail view is live before we archive (composer present = "session view open").
  await waitFor(() => page.getByPlaceholder(/Steer the agent/i).count(), {
    label: 'session detail open before archive',
  });
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive session' }).click();
  await waitFor(
    async () => !(await listActiveSessions(baseUrl)).some((s) => s.id === id),
    { label: 'archived session leaves the active list' },
  );
  await waitFor(async () => !page.url().includes(`/session/${id}`), {
    label: 'UI leaves the archived session route',
  });
}

export async function runArchiveLastSession(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  // Deterministic "last remaining": clear any sessions other journeys left, then
  // own exactly the set we archive here.
  const setup = record('archive-last: reduce the active list to a known pair');
  for (const existing of await listActiveSessions(baseUrl)) {
    await archiveViaRest(baseUrl, existing.id);
  }
  const first = await createMockSession(baseUrl, 'Archive smoke: first of two');
  const last = await createMockSession(baseUrl, 'Archive smoke: last remaining');
  await waitSessionIdle(baseUrl, first.id, waitFor, 'first archive-smoke session IDLE');
  await waitSessionIdle(baseUrl, last.id, waitFor, 'last archive-smoke session IDLE');
  setup.ok = true;
  setup.detail = `first=${first.id}, last=${last.id}`;

  // Non-final archive: one session remains, so navigation away is uneventful.
  const nonFinal = record('archive-last: archive a non-final session, one remains active');
  await archiveFromDetail(ctx, first.id);
  const remaining = await listActiveSessions(baseUrl);
  if (remaining.length !== 1 || remaining[0].id !== last.id) {
    throw new Error(`expected only the last session active, got ${JSON.stringify(remaining.map((s) => s.id))}`);
  }
  nonFinal.ok = true;

  // The regression: archive the FINAL session (active list 1 -> 0).
  const final = record('archive-last: archive the final session without blanking the app');
  await archiveFromDetail(ctx, last.id);
  if ((await listActiveSessions(baseUrl)).length !== 0) {
    throw new Error('active list should be empty after archiving the final session');
  }
  // Land on a sane, rendered route — App sends the user Home when the last
  // active session disappears.
  await waitFor(async () => new URL(page.url()).pathname === '/', {
    label: 'app lands on Home after the last archive',
  });
  await waitFor(async () => (await page.getByPlaceholder(/Ask Nuncio to build/i).count()) > 0, {
    label: 'Home composer rendered (not a blank screen)',
  });
  const health = await page.evaluate(() => ({
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
    bodyText: (document.body.innerText ?? '').trim().length,
    chunkError: document.body.innerText.includes('This part failed to load'),
  }));
  if (health.rootChildren === 0) throw new Error('#root is empty after archiving the last session');
  if (health.bodyText === 0) throw new Error('body has no visible text — blank screen after last archive');
  if (health.chunkError) throw new Error('chunk-error boundary rendered after last archive');
  final.ok = true;
  final.detail = 'active list emptied → Home rendered, no blank screen';
}
