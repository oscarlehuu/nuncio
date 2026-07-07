// Hidden layer for delegate-subtask. The graded skill is the DELEGATOR's brief
// quality and integration. Checks (querying the daemon HTTP API via baseUrl):
//   (a) >= 1 task row whose parent_session_id is the eval session AND whose
//       context_json (contextBrief) is non-null — a real subtask was authored;
//   (b) that brief's goal mentions "tokenize", doneCriteria is non-empty, and
//       files includes src/tokenize.ts (brief quality, behaviorally graded);
//   (c) a task_completed event exists on the eval session's log;
//   (d) the parent's edits are confined to src/highlight.ts + tests (it built the
//       highlighter on top of the delegated tokenizer rather than doing both).
// NOTE: today's mock child writes nothing, so on the mock provider this fails
// HONESTLY — a full pass requires a real engine. The solvability spec proves the
// check ACCEPTS a correct simulated end-state.
import { git } from './lib/check-helpers.mjs';

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

export default async function check({ fixtureDir, taskDto, sessionEvents, baseUrl }) {
  const notes = [];
  const evalSessionId = taskDto?.sessionId;
  if (!evalSessionId) return { pass: false, notes: ['eval session id unavailable'] };

  const children = baseUrl ? await childTasks(baseUrl, evalSessionId) : [];
  const withBrief = children.filter((t) => t.parentSessionId === evalSessionId && t.contextBrief);
  const hasChild = withBrief.length >= 1;
  if (!hasChild) notes.push('no subagent task with a contextBrief was enqueued under the eval session');

  const goodBrief = withBrief.some((t) => briefNamesTokenizer(t.contextBrief));
  if (hasChild && !goodBrief) notes.push('the delegated brief does not name tokenize / src/tokenize.ts / doneCriteria');

  const completed = (Array.isArray(sessionEvents) ? sessionEvents : []).some((e) => e?.type === 'task_completed');
  if (!completed) notes.push('no task_completed event on the eval session (the subtask result was not integrated)');

  // Parent edits confined to src/highlight.ts + tests.
  const changed = git(fixtureDir, ['diff', '--name-only', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const stray = changed.filter((f) => f !== 'src/highlight.ts' && !f.startsWith('test/'));
  const confined = stray.length === 0;
  if (!confined) notes.push(`parent edited files it should have delegated: ${stray.join(', ')}`);

  const pass = hasChild && goodBrief && completed && confined;
  if (pass) notes.push('authored a real tokenizer brief, integrated the result, edits confined to the highlighter');
  return { pass, notes };
}
