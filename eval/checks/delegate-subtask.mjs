// Hidden layer for delegate-subtask. The graded skill is the DELEGATOR's brief
// quality and integration — a lazy parent must not enqueue a useless child, do
// both halves itself, and pass. Checks:
//   (FORGE GUARD) the parent's OWN sessionEvents contain a tool_start invoking
//       nuncio_enqueue_task — the delegation happened as a RUNTIME TOOL CALL, not
//       a curl-the-HTTP-API forgery (a raw enqueue leaves no tool event);
//   (NO SELF-WRITE) no parent tool event names src/tokenize.ts as a WRITE target
//       (command-shape matching, like resume-from-outcome-digest) — the parent
//       must not implement the delegated half itself;
//   (a) >= 1 subagent task under the eval session with a non-null contextBrief;
//   (b) that brief mentions tokenize, has non-empty doneCriteria, files includes
//       src/tokenize.ts;
//   (c) a task_completed event on the eval session's log;
//   (d) the parent's own working-tree edits are confined to src/highlight.ts +
//       tests (the child's tokenizer arrives as a committed change, not a parent
//       edit).
// NOTE: today's mock child writes nothing, so on the mock provider this fails
// HONESTLY — a full pass requires a real engine. The solvability spec proves the
// check ACCEPTS a correct simulated end-state (with a synthetic enqueue tool
// event injected into the parent log) and REJECTS the forge negatives.
import { git } from './lib/check-helpers.mjs';

const ENQUEUE_TOOL = 'nuncio_enqueue_task';
const WRITE_TOOL = /(write|edit|create|patch|apply|replace)/i;
const TOKENIZE_PATH = /src\/tokenize\.ts/;

async function childTasks(baseUrl, parentSessionId) {
  try {
    const res = await fetch(`${baseUrl}/api/tasks?parentSessionId=${encodeURIComponent(parentSessionId)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function briefNamesTokenizer(brief) {
  if (!brief || typeof brief !== 'object') return false;
  const goalOk = typeof brief.goal === 'string' && /tokeni[sz]e/i.test(brief.goal);
  const doneOk = Array.isArray(brief.doneCriteria) && brief.doneCriteria.length > 0;
  const filesOk = Array.isArray(brief.files) && brief.files.some((f) => /(^|\/)src\/tokenize\.ts$/.test(f));
  return goalOk && doneOk && filesOk;
}

function toolEvents(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e?.type === 'tool_start');
}

export default async function check({ fixtureDir, taskDto, sessionEvents, baseUrl }) {
  const notes = [];
  const evalSessionId = taskDto?.sessionId;
  if (!evalSessionId) return { pass: false, notes: ['eval session id unavailable'] };

  const tools = toolEvents(sessionEvents);

  // FORGE GUARD: the parent invoked the enqueue tool at runtime.
  const usedEnqueueTool = tools.some((e) => String(e.payload?.tool ?? '') === ENQUEUE_TOOL);
  if (!usedEnqueueTool) notes.push(`no ${ENQUEUE_TOOL} tool call in the parent's events (delegation must be a real tool call, not a raw API enqueue)`);

  // NO SELF-WRITE: the parent did not write src/tokenize.ts via a tool.
  const wroteTokenizer = tools.some((e) => {
    const tool = String(e.payload?.tool ?? '');
    const input = JSON.stringify(e.payload?.input ?? '');
    return WRITE_TOOL.test(tool) && TOKENIZE_PATH.test(input);
  });
  if (wroteTokenizer) notes.push('a parent write/edit tool event targeted src/tokenize.ts (the parent implemented the delegated half itself)');

  const children = baseUrl ? await childTasks(baseUrl, evalSessionId) : [];
  const withBrief = children.filter((t) => t.parentSessionId === evalSessionId && t.contextBrief);
  const hasChild = withBrief.length >= 1;
  if (!hasChild) notes.push('no subagent task with a contextBrief was enqueued under the eval session');

  const goodBrief = withBrief.some((t) => briefNamesTokenizer(t.contextBrief));
  if (hasChild && !goodBrief) notes.push('the delegated brief does not name tokenize / src/tokenize.ts / doneCriteria');

  const completed = (Array.isArray(sessionEvents) ? sessionEvents : []).some((e) => e?.type === 'task_completed');
  if (!completed) notes.push('no task_completed event on the eval session (the subtask result was not integrated)');

  // Parent working-tree edits confined to src/highlight.ts + tests.
  const changed = git(fixtureDir, ['diff', '--name-only', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const stray = changed.filter((f) => f !== 'src/highlight.ts' && !f.startsWith('test/'));
  const confined = stray.length === 0;
  if (!confined) notes.push(`parent edited files it should have delegated: ${stray.join(', ')}`);

  const pass = usedEnqueueTool && !wroteTokenizer && hasChild && goodBrief && completed && confined;
  if (pass) notes.push('real enqueue tool call, no self-write of the tokenizer, integrated the result, edits confined to the highlighter');
  return { pass, notes };
}
