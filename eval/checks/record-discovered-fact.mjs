// Hidden layer for record-discovered-fact. The engine must capture the build
// discovery as a project fact via its tool. Checks (querying the daemon HTTP API
// via baseUrl over the fixture's projectPath): (a) a context_facts row exists
// with provenance 'agent' and source_session_id = the eval session; (b) its value
// mentions both 'codegen' and 'build' (the actionable core); (c) the key is a
// valid slug; (d) value <= 1024 bytes. NOTE: today's mock records nothing, so on
// the mock provider this fails HONESTLY; the solvability spec proves the check
// accepts a correct simulated agent-provenance row.
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_VALUE_BYTES = 1024;

async function listFacts(baseUrl, projectPath) {
  try {
    const res = await fetch(`${baseUrl}/api/context-facts?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export default async function check({ fixtureDir, taskDto, baseUrl }) {
  const notes = [];
  const evalSessionId = taskDto?.sessionId;
  if (!evalSessionId) return { pass: false, notes: ['eval session id unavailable'] };
  if (!baseUrl) return { pass: false, notes: ['baseUrl unavailable to query the fact store'] };

  const facts = await listFacts(baseUrl, fixtureDir);
  const agentFacts = facts.filter((f) => f.provenance === 'agent' && f.sourceSessionId === evalSessionId);
  if (agentFacts.length === 0) {
    notes.push('no agent-provenance fact recorded for this project by the eval session');
    return { pass: false, notes };
  }

  const mentions = agentFacts.find((f) => /codegen/i.test(f.value ?? '') && /build/i.test(f.value ?? ''));
  if (!mentions) notes.push("no recorded fact's value mentions both 'codegen' and 'build'");

  const fact = mentions ?? agentFacts[0];
  const slugOk = typeof fact.key === 'string' && SLUG_RE.test(fact.key);
  if (!slugOk) notes.push(`fact key is not a valid slug: "${fact.key}"`);

  const withinBytes = typeof fact.value === 'string' && Buffer.byteLength(fact.value, 'utf8') <= MAX_VALUE_BYTES;
  if (!withinBytes) notes.push(`fact value exceeds ${MAX_VALUE_BYTES} bytes`);

  const pass = Boolean(mentions) && slugOk && withinBytes;
  if (pass) notes.push('agent-provenance build fact recorded (codegen+build), valid slug, within byte budget');
  return { pass, notes };
}
