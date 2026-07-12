import type { CrewContextEnvelope } from './crew-context.types';

export function fitContextBudget(input: CrewContextEnvelope, budget: number): CrewContextEnvelope {
  if (!Number.isInteger(budget) || budget < 384) throw new Error('Crew context budget is too small');
  const output = structuredClone(input);
  const bytes = () => Buffer.byteLength(JSON.stringify(output), 'utf8');
  while (bytes() > budget && output.priorFailure?.summary.length) {
    output.priorFailure.summary = halve(output.priorFailure.summary);
  }
  while (bytes() > budget && (output.objective.length > 16 || output.goal.length > 16)) {
    if (output.objective.length >= output.goal.length) output.objective = halve(output.objective);
    else output.goal = halve(output.goal);
  }
  while (bytes() > budget) {
    const optionalIndex = output.artifactRefs.findLastIndex((ref) => !ref.required);
    if (optionalIndex < 0) break;
    output.artifactRefs.splice(optionalIndex, 1);
  }
  const lists = [output.decisions, output.constraints, output.doneCriteria, output.clarifications];
  while (bytes() > budget && lists.some((list) => list.length > 0)) {
    lists.reduce((best, list) => list.length > best.length ? list : best, lists[0]!).pop();
  }
  return bytes() > budget ? fitGenericBudget(output, budget) : output;
}

export function fitGenericBudget<T extends object>(input: T, budget: number): T {
  const output = structuredClone(input) as T;
  const bytes = () => Buffer.byteLength(JSON.stringify(output), 'utf8');
  const protectedKeys = new Set([
    'runId', 'role', 'memberKey', 'idempotencyKey', 'contextRevision', 'fromContextRevision',
    'id', 'artifactId', 'sha256', 'fullHead', 'workspaceHead', 'commitHead', 'basedOnWorkspaceHead',
  ]);
  while (bytes() > budget) {
    const candidates = mutableStrings(output, protectedKeys).sort((a, b) =>
      b.value.length - a.value.length || a.path.localeCompare(b.path));
    const longest = candidates.find((candidate) => candidate.value.length > 24);
    if (longest) { longest.parent[longest.key] = halve(longest.value); continue; }
    const optionalRef = artifactRefArrays(output)
      .flatMap((array) => array.map((ref, index) => ({ array, ref, index })))
      .findLast(({ ref }) => !isRequiredRef(ref));
    if (optionalRef) { optionalRef.array.splice(optionalRef.index, 1); continue; }
    const arrays = mutableArrays(output).filter((array) => array.length > 0)
      .sort((a, b) => b.length - a.length);
    if (arrays[0]) { arrays[0].pop(); continue; }
    throw new Error('Crew context authority fields exceed byte budget');
  }
  return output;
}

function halve(value: string): string {
  if (value.length <= 16) return '';
  return `${value.slice(0, Math.max(12, Math.floor(value.length / 2)))}…`;
}
function mutableStrings(value: unknown, protectedKeys: Set<string>, path = ''): Array<{
  parent: Record<string, unknown>; key: string; value: string; path: string;
}> {
  if (!value || typeof value !== 'object') return [];
  const output: ReturnType<typeof mutableStrings> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (typeof child === 'string' && !protectedKeys.has(key)) {
      output.push({ parent: value as Record<string, unknown>, key, value: child, path: childPath });
    } else output.push(...mutableStrings(child, protectedKeys, childPath));
  }
  return output;
}
function mutableArrays(value: unknown): unknown[][] {
  if (!value || typeof value !== 'object') return [];
  const output: unknown[][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'artifactRefs') continue;
    if (Array.isArray(child)) output.push(child, ...child.flatMap(mutableArrays));
    else output.push(...mutableArrays(child));
  }
  return output;
}
function artifactRefArrays(value: unknown): unknown[][] {
  if (!value || typeof value !== 'object') return [];
  const output: unknown[][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'artifactRefs' && Array.isArray(child)) output.push(child);
    else output.push(...artifactRefArrays(child));
  }
  return output;
}
function isRequiredRef(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).required === true);
}
