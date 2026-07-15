import { describe, expect, test } from 'bun:test';
import { diffIssueKeys, issueKeysFromReport } from './dead-code-utils.mjs';

const report = {
  issues: [
    {
      file: 'apps/web/src/lib/orphan.ts',
      files: [{ name: 'apps/web/src/lib/orphan.ts' }],
      dependencies: [],
      devDependencies: [],
      exports: [],
      types: [],
    },
    {
      file: 'apps/web/package.json',
      files: [],
      dependencies: [{ name: 'next-themes', line: 25, col: 6 }],
      devDependencies: [{ name: 'ts-node' }],
      exports: [],
      types: [],
    },
    {
      file: 'packages/core/src/events.ts',
      files: [],
      dependencies: [],
      devDependencies: [],
      exports: [
        { name: 'mergeLegacy', line: 10, col: 1 },
        { name: 'unusedHelper', line: 20, col: 1 },
      ],
      types: [{ name: 'LegacyShape' }],
      enumMembers: { Status: [{ name: 'RETIRED' }] },
      duplicates: [[{ name: 'foo' }, { name: 'foo!' }]],
    },
  ],
};

describe('issueKeysFromReport', () => {
  test('flattens every issue category into stable sorted keys', () => {
    expect(issueKeysFromReport(report)).toEqual([
      'dependencies:apps/web/package.json:next-themes',
      'devDependencies:apps/web/package.json:ts-node',
      'duplicates:packages/core/src/events.ts:foo|foo!',
      'enumMembers:packages/core/src/events.ts:Status.RETIRED',
      'exports:packages/core/src/events.ts:mergeLegacy',
      'exports:packages/core/src/events.ts:unusedHelper',
      'types:packages/core/src/events.ts:LegacyShape',
      'unused-file:apps/web/src/lib/orphan.ts',
    ]);
  });

  test('keys ignore line/col so moving code inside a file does not churn the baseline', () => {
    const moved = structuredClone(report);
    moved.issues[1].dependencies[0].line = 99;
    expect(issueKeysFromReport(moved)).toEqual(issueKeysFromReport(report));
  });

  test('dedupes repeated keys and tolerates missing categories', () => {
    const sparse = {
      issues: [
        { file: 'a.ts', files: [{ name: 'a.ts' }] },
        { file: 'a.ts', files: [{ name: 'a.ts' }] },
      ],
    };
    expect(issueKeysFromReport(sparse)).toEqual(['unused-file:a.ts']);
  });

  test('empty report yields no keys', () => {
    expect(issueKeysFromReport({ issues: [] })).toEqual([]);
  });
});

describe('diffIssueKeys', () => {
  test('splits current vs baseline into new and fixed', () => {
    const baseline = ['exports:a.ts:old', 'unused-file:gone.ts'];
    const current = ['exports:a.ts:old', 'exports:b.ts:fresh'];
    expect(diffIssueKeys(current, baseline)).toEqual({
      added: ['exports:b.ts:fresh'],
      fixed: ['unused-file:gone.ts'],
    });
  });

  test('identical sets produce empty diff', () => {
    expect(diffIssueKeys(['x'], ['x'])).toEqual({ added: [], fixed: [] });
  });
});
