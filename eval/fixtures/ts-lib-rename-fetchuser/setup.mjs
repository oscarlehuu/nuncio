// Fixture: getUser defined in src/api/user.ts and consumed across six files,
// including a log string that names it ('getUser failed') which the prompt says
// must ALSO be renamed, and an unrelated getUserAgent in src/http.ts that must
// NOT change. Tests import getUser and pass at HEAD. Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-rename-fetchuser', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  // 1. definition
  'src/api/user.ts': `export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  return { id, name: \`user-\${id}\` };
}
`,
  // 2. consumer with a log string that names the function
  'src/service/profile.ts': `import { getUser } from '../api/user';

export function loadProfile(id: string): string {
  try {
    return getUser(id).name;
  } catch {
    console.error('getUser failed');
    return 'unknown';
  }
}
`,
  // 3. consumer
  'src/service/greeter.ts': `import { getUser } from '../api/user';

export function greet(id: string): string {
  return \`Hello, \${getUser(id).name}\`;
}
`,
  // 4. consumer
  'src/service/roster.ts': `import { getUser } from '../api/user';

export function roster(ids: string[]): string[] {
  return ids.map((id) => getUser(id).name);
}
`,
  // 5. consumer
  'src/service/audit.ts': `import { getUser } from '../api/user';

export function auditName(id: string): number {
  return getUser(id).name.length;
}
`,
  // 6. unrelated symbol that must survive untouched
  'src/http.ts': `export function getUserAgent(): string {
  return 'ts-lib-rename/1.0';
}
`,
  'src/index.ts': `export { getUser } from './api/user';
export { loadProfile } from './service/profile';
export { greet } from './service/greeter';
export { roster } from './service/roster';
export { auditName } from './service/audit';
export { getUserAgent } from './http';
`,
  'test/user.spec.ts': `import { expect, test } from 'bun:test';
import { getUser } from '../src/api/user';
import { greet } from '../src/service/greeter';

test('getUser builds a user', () => {
  expect(getUser('7').name).toBe('user-7');
});

test('greeter uses getUser', () => {
  expect(greet('7')).toBe('Hello, user-7');
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
