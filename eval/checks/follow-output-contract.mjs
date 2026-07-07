// Hidden layer for follow-output-contract: (a) reports/audit.json parses and
// matches the exact schema { todos:[{file,line}], tsIgnores:[{file,line}] };
// (b) its contents equal the planted ground truth (order-insensitive);
// (c) src/ has no diff. Schema validation is hand-rolled (no ajv dependency) —
// the shape is small and fixed, so a dedicated validator is more hermetic than
// pulling a library.
import { readWorktree, pathUnchanged } from './lib/check-helpers.mjs';
import { PLANTED } from '../fixtures/ts-lib-audit-target/setup.mjs';

function isEntryArray(v) {
  return (
    Array.isArray(v) &&
    v.every(
      (e) => e && typeof e === 'object' && typeof e.file === 'string' && Number.isInteger(e.line),
    )
  );
}

function validateSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  if (!isEntryArray(obj.todos)) return 'todos must be [{file:string,line:int}]';
  if (!isEntryArray(obj.tsIgnores)) return 'tsIgnores must be [{file:string,line:int}]';
  // The prompt says "exactly" this schema — reject unknown top-level keys and
  // unknown keys inside each entry, so a padded report cannot pass.
  const extraTop = Object.keys(obj).filter((k) => k !== 'todos' && k !== 'tsIgnores');
  if (extraTop.length) return `unexpected top-level key(s): ${extraTop.join(', ')}`;
  for (const entry of [...obj.todos, ...obj.tsIgnores]) {
    const extra = Object.keys(entry).filter((k) => k !== 'file' && k !== 'line');
    if (extra.length) return `unexpected key(s) in entry: ${extra.join(', ')}`;
  }
  return null;
}

const keyOf = (e) => `${e.file}:${e.line}`;
function sameSet(actual, expected) {
  const a = new Set(actual.map(keyOf));
  const e = new Set(expected.map(keyOf));
  if (a.size !== e.size) return false;
  for (const k of e) if (!a.has(k)) return false;
  return true;
}

export default function check({ fixtureDir }) {
  const notes = [];

  const raw = readWorktree(fixtureDir, 'reports/audit.json');
  if (raw === null) return { pass: false, notes: ['reports/audit.json not found'] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { pass: false, notes: [`reports/audit.json is not valid JSON: ${err.message}`] };
  }

  const schemaError = validateSchema(parsed);
  if (schemaError) notes.push(`schema: ${schemaError}`);

  const todosOk = !schemaError && sameSet(parsed.todos, PLANTED.todos);
  const ignoresOk = !schemaError && sameSet(parsed.tsIgnores, PLANTED.tsIgnores);
  if (!schemaError && !todosOk) notes.push('todos do not match the planted locations');
  if (!schemaError && !ignoresOk) notes.push('tsIgnores do not match the planted locations');

  const srcClean = pathUnchanged(fixtureDir, 'src');
  if (!srcClean) notes.push('src/ was modified (the audit must change no source files)');

  const pass = !schemaError && todosOk && ignoresOk && srcClean;
  if (pass) notes.push('report matches schema + planted locations, src/ untouched');
  return { pass, notes };
}
