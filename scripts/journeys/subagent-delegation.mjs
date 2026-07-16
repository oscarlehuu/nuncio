// Journey: a Mock parent spawns a subagent task; the parent transcript renders
// the completion digest and lineage chips that navigate parent <-> child.
import { createMockSession, waitSessionIdle } from '../lib/mock-session.mjs';

export async function runSubagentDelegation(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const digestSetupStep = record('delegation: mock subagent completes and appends parent digest');
  const parent = await createMockSession(baseUrl, 'Smoke parent delegates follow-up work');
  await waitSessionIdle(baseUrl, parent.id, waitFor, 'mock parent to finish initial run');

  const multitaskRes = await fetch(`${baseUrl}/api/tasks/multitask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parentSessionId: parent.id,
      prompts: ['Smoke child task returns a digest'],
    }),
  });
  if (!multitaskRes.ok) {
    throw new Error(`multitask failed: ${multitaskRes.status} ${await multitaskRes.text()}`);
  }
  const digest = await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${parent.id}/events?since=0`);
      if (!res.ok) return false;
      const events = await res.json();
      const event = events.find((item) => item.type === 'task_completed');
      return event?.payload?.childSessionId ? event.payload : false;
    },
    { label: 'task_completed digest on parent log' },
  );
  const childSessionId = digest.childSessionId;
  digestSetupStep.ok = true;
  digestSetupStep.detail = `parent=${parent.id}, child=${childSessionId}`;

  const digestUiStep = record('delegation: digest card is visible in the parent transcript');
  await page.goto(`${baseUrl}/session/${parent.id}`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await page.getByTestId('task-digest-card').count()) > 0, {
    label: 'digest card in parent transcript',
  });
  await waitFor(async () => (await page.getByText('Open session', { exact: true }).count()) > 0, {
    label: 'digest open-session link',
  });
  await waitFor(async () => (await page.getByTestId('lineage-children-chip').count()) > 0, {
    label: 'parent subagents lineage chip',
  });
  digestUiStep.ok = true;

  const digestLinkStep = record('delegation: digest link opens the child session');
  await page.getByTestId('task-digest-open').click();
  await waitFor(async () => page.url().includes(`/session/${childSessionId}`), {
    label: 'digest link navigated to child session',
  });
  await waitFor(async () => (await page.getByTestId('lineage-parent-chip').count()) > 0, {
    label: 'child parent lineage chip',
  });
  digestLinkStep.ok = true;

  const lineageStep = record('delegation: child lineage chip navigates back to parent');
  await page.getByTestId('lineage-parent-chip').click();
  await waitFor(async () => page.url().includes(`/session/${parent.id}`), {
    label: 'parent lineage chip navigated back to parent',
  });
  lineageStep.ok = true;
}
