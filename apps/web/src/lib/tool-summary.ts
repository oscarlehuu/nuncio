/**
 * Maps a (tool, input) pair to a compact Cursor-style summary line:
 *   Read /foo.ts L100-150
 *   Ran `ls -la`
 *   Grepped "TODO" in src
 * Used by tool rows and group headers in the transcript.
 */

export interface ToolSummary {
  verb: string;
  /** Primary subject rendered as a mono pill (path, command, query, …). May be empty. */
  subject: string;
  /** Optional trailing context (e.g. " in src") rendered as muted text after the subject. */
  context?: string;
}

const READ_ALIASES = new Set(['read', 'Read', 'read_file', 'ReadFile']);
const BASH_ALIASES = new Set(['bash', 'Bash', 'run', 'Run', 'shell', 'Shell', 'exec', 'Exec']);
const GREP_ALIASES = new Set(['grep', 'Grep', 'rg', 'ripgrep']);
const GLOB_ALIASES = new Set(['glob', 'Glob', 'search_files', 'SearchFiles']);
const FIND_ALIASES = new Set(['find', 'Find']);
const LS_ALIASES = new Set(['ls', 'Ls', 'list', 'List']);
const EDIT_ALIASES = new Set([
  'edit',
  'Edit',
  'multi_edit',
  'MultiEdit',
  'str_replace',
  'StrReplace',
  'replace',
  'Replace',
]);
const WRITE_ALIASES = new Set(['write', 'Write', 'create_file', 'CreateFile']);
const WEBFETCH_ALIASES = new Set(['webfetch', 'WebFetch', 'fetch', 'Fetch', 'curl', 'Curl']);
const WEBSEARCH_ALIASES = new Set([
  'websearch',
  'WebSearch',
  'web_search',
  'WebSearch',
]);

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function shortPath(p: string): string {
  if (p.startsWith('/Users/')) {
    const parts = p.split('/');
    return parts.slice(3).join('/') || p;
  }
  if (p.startsWith('/home/')) {
    const parts = p.split('/');
    return parts.slice(3).join('/') || p;
  }
  return p;
}

function readLineRange(input: Record<string, unknown>): string | undefined {
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  const startLine = typeof input.startLine === 'number' ? input.startLine : undefined;
  const endLine = typeof input.endLine === 'number' ? input.endLine : undefined;
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
  }
  if (typeof offset === 'number' && typeof limit === 'number') {
    const start = offset + 1;
    const end = offset + limit;
    return `L${start}-${end}`;
  }
  return undefined;
}

export function summarizeToolCall(tool: string, input: unknown): ToolSummary {
  const data = (input ?? {}) as Record<string, unknown>;
  const rawPath = asString(data.path) ?? asString(data.file_path) ?? asString(data.file);
  const path = rawPath ? shortPath(rawPath) : undefined;

  if (READ_ALIASES.has(tool)) {
    const range = readLineRange(data);
    return {
      verb: 'Read',
      subject: path ?? '',
      context: range ? ` ${range}` : undefined,
    };
  }
  if (BASH_ALIASES.has(tool)) {
    const cmd = asString(data.cmd) ?? asString(data.command) ?? asString(data.shell);
    return { verb: 'Ran', subject: cmd ?? '' };
  }
  if (GREP_ALIASES.has(tool)) {
    const pattern = asString(data.pattern) ?? asString(data.query) ?? asString(data.search);
    const inPath = asString(data.path) ?? asString(data.cwd);
    return {
      verb: 'Grepped',
      subject: pattern ?? '',
      context: inPath ? ` in ${shortPath(inPath)}` : undefined,
    };
  }
  if (GLOB_ALIASES.has(tool)) {
    const pattern = asString(data.pattern) ?? asString(data.glob) ?? asString(data.query);
    const inPath = asString(data.path);
    return {
      verb: 'Searched files',
      subject: pattern ?? '',
      context: inPath ? ` in ${shortPath(inPath)}` : undefined,
    };
  }
  if (FIND_ALIASES.has(tool)) {
    return { verb: 'Found', subject: path ?? '' };
  }
  if (LS_ALIASES.has(tool)) {
    return { verb: 'Listed', subject: path ?? '' };
  }
  if (EDIT_ALIASES.has(tool)) {
    return { verb: 'Edited', subject: path ?? '' };
  }
  if (WRITE_ALIASES.has(tool)) {
    return { verb: 'Wrote', subject: path ?? '' };
  }
  if (WEBFETCH_ALIASES.has(tool)) {
    const url = asString(data.url) ?? asString(data.uri);
    return { verb: 'Fetched', subject: url ?? '' };
  }
  if (WEBSEARCH_ALIASES.has(tool)) {
    const query = asString(data.query) ?? asString(data.search);
    return { verb: 'Searched the web', subject: query ?? '' };
  }
  return { verb: 'Used', subject: tool };
}

/**
 * Builds a one-line Cursor-style summary header for a group of tool calls.
 * Past-tense verb + count + noun, first verb capitalized, rest lowercase:
 *   "Read 2 files"
 *   "Ran 3 commands"
 *   "Edited 3 files, ran 8 commands"
 *   "Searched 4 times, fetched 1 URL"
 */
export function summarizeToolGroup(tools: Array<{ tool: string; input?: unknown }>): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const t of tools) {
    const { verb } = summarizeToolCall(t.tool, t.input);
    const key = groupVerbFor(verb, t.tool);
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, 1);
      order.push(key);
    } else {
      counts.set(key, existing + 1);
    }
  }
  if (order.length === 0) return 'Ran tools';
  const parts = order.map((key, i) => {
    const n = counts.get(key) ?? 0;
    const noun = GROUP_VERB_NOUNS[key] ?? 'tool';
    const verbLabel = i === 0 ? capitalize(key) : key;
    return `${verbLabel} ${n} ${pluralizeNoun(noun, n)}`;
  });
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + `, ${parts[parts.length - 1]}`;
}

const GROUP_VERB_NOUNS: Record<string, string> = {
  read: 'file',
  ran: 'command',
  searched: 'time',
  edited: 'file',
  wrote: 'file',
  listed: 'path',
  found: 'path',
  fetched: 'URL',
  used: 'tool',
};

/** Maps a per-call verb (from `summarizeToolCall`) to a group verb key. */
function groupVerbFor(verb: string, tool: string): string {
  const lower = tool.toLowerCase();
  if (verb === 'Read') return 'read';
  if (verb === 'Ran') return 'ran';
  if (verb === 'Grepped' || verb === 'Searched files' || verb === 'Searched the web') return 'searched';
  if (verb === 'Edited') return 'edited';
  if (verb === 'Wrote') return 'wrote';
  if (verb === 'Listed') return 'listed';
  if (verb === 'Found') return 'found';
  if (verb === 'Fetched') return 'fetched';
  if (lower.includes('grep') || lower.includes('search')) return 'searched';
  return 'used';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function pluralizeNoun(noun: string, count: number): string {
  if (count === 1) return noun;
  if (noun.endsWith('s') || noun.endsWith('x') || noun.endsWith('ch') || noun.endsWith('sh')) {
    return noun + 'es';
  }
  if (noun.endsWith('y') && !/[aeiou]y$/.test(noun)) return noun.slice(0, -1) + 'ies';
  return noun + 's';
}
