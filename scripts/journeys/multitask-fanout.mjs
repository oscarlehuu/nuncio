// Journey: a multitask-mode parent (Mock engine) decomposes its goal into two
// independent subtasks and fans one child session out per subtask through the
// existing task machinery. The parent transcript shows the coordinator split,
// two child digest cards, and the lineage children chip; children inherit the
// parent's model (no silent swap).
import { transcriptText } from '../lib/transcript.mjs';

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function runMultitaskFanout(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const fanoutStep = record('multitask: mode=multitask parent decomposes into two child tasks');
  const parent = await postJson(`${baseUrl}/api/sessions`, {
    prompt: 'Build the whole feature end to end',
    provider: 'mock',
    model: 'mock:default',
    mode: 'multitask',
  });
  if (parent.mode !== 'multitask' || !parent.id) {
    throw new Error(`unexpected create response: ${JSON.stringify(parent)}`);
  }

  // The engine's structured decompose fans two children out via the task machinery.
  const children = await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/tasks?parentSessionId=${parent.id}`);
      if (!res.ok) return false;
      const list = await res.json();
      return list.length === 2 ? list : false;
    },
    { label: 'two decomposed child tasks' },
  );
  // Child model INHERITS the parent's — the decompose must not silently swap it.
  for (const child of children) {
    if (child.model !== 'mock:default') {
      throw new Error(`child model swapped from parent: ${child.model}`);
    }
  }
  // Launch both immediately, skipping the launch grace window, so they run+settle.
  for (const child of children) {
    await postJson(`${baseUrl}/api/tasks/${child.id}/start-now`);
  }
  fanoutStep.ok = true;
  fanoutStep.detail = `parent=${parent.id}, children=${children.map((c) => c.id).join(',')}`;

  const boardStep = record('multitask: parent transcript shows the split, two child digests + lineage chip');
  await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${parent.id}/events?since=0`);
      if (!res.ok) return false;
      const events = await res.json();
      return events.filter((event) => event.type === 'task_completed').length === 2;
    },
    { label: 'two task_completed digests on the parent log' },
  );

  await page.goto(`${baseUrl}/session/${parent.id}`, { waitUntil: 'domcontentloaded' });
  // Coordinator announcement — scoped to the transcript, never the whole page.
  await waitFor(
    async () => (await transcriptText(page, /Split into 2 independent subtasks/).count()) > 0,
    { label: 'coordinator split announcement in the transcript' },
  );
  // Two child references: one digest card per settled child.
  await waitFor(async () => (await page.getByTestId('task-digest-card').count()) === 2, {
    label: 'two child digest cards in the parent transcript',
  });
  // Lineage children chip (parent -> child sessions) is present.
  await waitFor(async () => (await page.getByTestId('lineage-children-chip').count()) > 0, {
    label: 'parent lineage children chip',
  });
  boardStep.ok = true;
}
