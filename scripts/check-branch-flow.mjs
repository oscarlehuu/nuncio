#!/usr/bin/env node
/**
 * CI gate: enforce the two-branch merge graph on pull requests.
 *
 *   <type>/<slug> (from dev)  →  dev  →  main   (promotion)
 *   changeset-release/*       →  main           (release bot)
 *   main                      →  dev            (sync-back after a release)
 *
 * Usage:
 *   BASE_REF=main HEAD_REF=dev bun run check-branch-flow
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
console.error('  <type>/<slug> (from dev)  →  dev  →  main   (promotion)');
console.error('  changeset-release/*       →  main           (release bot)');
console.error('  main                      →  dev            (sync-back after a release)');
console.error('');
console.error('See AGENTS.md → Branch model: dev → main.');
process.exit(1);
