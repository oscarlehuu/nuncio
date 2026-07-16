// Journey (regression guard): if the server process dies and restarts mid-session,
// the browser transcript survives (durable replay) and the client resubscribes
// from its last seq — the next turn streams in live, gap-free and duplicate-free.
import { createMockSession, MOCK_TASK_REPLY, waitSessionIdle } from '../lib/mock-session.mjs';
import { transcriptText } from '../lib/transcript.mjs';

// The completed reply renders across nested transcript elements, so the exact
// text matches more than one node. Duplication is proven by the count STAYING
// stable across the reconnect (replay must not re-append), not by an absolute 1.
// Scoped to the transcript container so the sidebar's recent-session preview
// (which echoes the same reply text) can never stand in for a broken replay.
function replyMatchCount(page, text) {
  return transcriptText(page, text, { exact: true }).count();
}

export async function runWebsocketReconnect(ctx) {
  const { page, baseUrl, waitFor, record, restartServer } = ctx;

  // Mock settles instantly (no long stream to interrupt), so we kill AFTER IDLE
  // for a stable cursor, then prove a NEW turn resumes live post-restart.
  const settle = record('reconnect: mock session settles before the server restart');
  const session = await createMockSession(baseUrl, 'Reconnect smoke: reply before restart');
  await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await replyMatchCount(page, MOCK_TASK_REPLY)) >= 1, {
    label: 'initial reply present before restart',
  });
  await waitSessionIdle(baseUrl, session.id, waitFor);
  const baselineCount = await replyMatchCount(page, MOCK_TASK_REPLY);
  settle.ok = true;
  settle.detail = `reply node count=${baselineCount}`;

  const restart = record('reconnect: restart keeps the durable transcript gap-free (no dup replay)');
  await restartServer();
  // The tab was never reloaded — the durable events persist and the client's
  // resubscribe must NOT re-append the reply it already has. Give any spurious
  // duplicate a chance to land, then assert the node count is unchanged.
  await waitSessionIdle(baseUrl, session.id, waitFor, 'session readable after restart');
  if ((await replyMatchCount(page, MOCK_TASK_REPLY)) !== baselineCount) {
    throw new Error('transcript changed after restart — reply lost or duplicated');
  }
  restart.ok = true;

  const resume = record('reconnect: client resubscribes from lastSeq and streams the next turn');
  const steerText = `reconnect-steer-${Date.now()}`;
  const steerRes = await fetch(`${baseUrl}/api/sessions/${session.id}/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: steerText }),
  });
  if (!steerRes.ok) {
    throw new Error(`post-restart steer failed: ${steerRes.status} ${await steerRes.text()}`);
  }
  const steerReply = `Steer received: "${steerText}". Continuing in mock mode.`;
  await waitFor(async () => (await transcriptText(page, steerReply, { exact: true }).count()) > 0, {
    label: 'post-restart steer reply streams into the live transcript',
  });
  // Still gap-free + duplicate-free: the original reply was not re-delivered.
  if ((await replyMatchCount(page, MOCK_TASK_REPLY)) !== baselineCount) {
    throw new Error('original reply duplicated after reconnect replay');
  }
  resume.ok = true;
  resume.detail = 'resubscribed from lastSeq; new turn live, no duplicates';
}
