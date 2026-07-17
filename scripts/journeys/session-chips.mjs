// Journey: a Mock-engine agent flags an out-of-scope follow-up as a spawn-task
// chip mid-turn; the chip renders live in the session view, and one tap spins it
// into its own child session linked back to the source by a lineage chip. The
// deferred-spawn sibling of multitask fan-out.
import { createMockSession } from '../lib/mock-session.mjs';
import { transcriptText } from '../lib/transcript.mjs';

export async function runSessionChips(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  // The prompt carries the marker the Mock engine watches for, so it emits one
  // deterministic chip after its reply.
  const proposeStep = record('chips: mock agent proposes a spawn-task chip mid-turn');
  const parent = await createMockSession(baseUrl, 'Smoke: run the mock flow and spawn-chip a follow-up');
  const chips = await waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/chips?sessionId=${parent.id}`);
      if (!res.ok) return false;
      const list = await res.json();
      return list.length === 1 ? list : false;
    },
    { label: 'one proposed chip on the source session' },
  );
  const chip = chips[0];
  if (chip.status !== 'proposed' || chip.sourceSessionId !== parent.id) {
    throw new Error(`unexpected chip shape: ${JSON.stringify(chip)}`);
  }
  proposeStep.ok = true;
  proposeStep.detail = `chip=${chip.id} ref=${chip.ref} title="${chip.title}"`;

  const renderStep = record('chips: chip renders as a hairline pill in the source session view');
  await page.goto(`${baseUrl}/session/${parent.id}`, { waitUntil: 'domcontentloaded' });
  // Anchor on the streamed reply so we know the detail transcript actually rendered.
  await waitFor(async () => (await transcriptText(page, 'I received your task', { exact: false }).count()) > 0, {
    label: 'source session transcript hydrated',
  });
  await waitFor(async () => (await page.getByTestId('session-chip').count()) === 1, {
    label: 'the spawn-task chip pill in the session view',
  });
  const createButton = page.getByTestId('session-chip-create');
  if ((await createButton.innerText()).trim() !== chip.title) {
    throw new Error('chip pill title does not match the proposed chip');
  }
  renderStep.ok = true;

  const spawnStep = record('chips: tapping the chip spins a child session linked by lineage');
  await createButton.click();
  const childId = await waitFor(
    async () => {
      const match = new URL(page.url()).pathname.match(/^\/session\/([^/]+)$/);
      const id = match?.[1];
      return id && id !== parent.id ? id : false;
    },
    { label: 'navigation to the newly spawned child session' },
  );
  // The child is a real lineage child of the source session (parent chip present,
  // and the server records the parentSessionId).
  await waitFor(async () => (await page.getByTestId('lineage-parent-chip').count()) > 0, {
    label: 'child session shows its lineage parent chip',
  });
  const childRes = await fetch(`${baseUrl}/api/sessions/${childId}`);
  const child = await childRes.json();
  if (child.parentSessionId !== parent.id) {
    throw new Error(`child parentSessionId=${child.parentSessionId} expected ${parent.id}`);
  }
  // The acted chip is terminal — it no longer shows in the source session's row.
  const afterRes = await fetch(`${baseUrl}/api/chips?sessionId=${parent.id}`);
  const remaining = await afterRes.json();
  if (remaining.length !== 0) {
    throw new Error(`acted chip should leave the row, still saw ${remaining.length}`);
  }
  spawnStep.ok = true;
  spawnStep.detail = `child=${childId} parent=${parent.id}`;
}
