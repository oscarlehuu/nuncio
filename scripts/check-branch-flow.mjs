#!/usr/bin/env node
/**
 * CI gate: enforce SDK lane merge graph on pull requests.
 *
 *   cursor/*  → cursor-sdk → main
 *   pi/*      → pi-sdk     → main
 *   main      → cursor-sdk | pi-sdk  (sync-back)
 *
 * Usage:
 *   BASE_REF=main HEAD_REF=cursor/feat bun run check-branch-flow
 */
import { validateBranchFlow } from './branch-flow-utils.mjs';

const base = process.env.BASE_REF || process.env.GITHUB_BASE_REF || '';
const head = process.env.HEAD_REF || process.env.GITHUB_HEAD_REF || '';

if (!base || !head) {
  console.error('BASE_REF and HEAD_REF are required (set by CI or pass manually).');
  process.exit(1);
}

const result = validateBranchFlow(base, head);

if (result.ok) {
  console.log(`branch flow OK: ${head} → ${base}`);
  process.exit(0);
}

console.error('Branch flow check failed.');
console.error(result.reason);
console.error('');
console.error('Expected merge graph:');
console.error('  cursor/<feature>  →  cursor-sdk  →  main');
console.error('  pi/<feature>      →  pi-sdk      →  main');
console.error('  main              →  cursor-sdk | pi-sdk  (sync-back only)');
console.error('');
console.error('See AGENTS.md → SDK lane branches.');
process.exit(1);
