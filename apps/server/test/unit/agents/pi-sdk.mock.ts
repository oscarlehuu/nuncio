import { mock } from 'bun:test';

/**
 * Shared mock registration for '@earendil-works/pi-coding-agent'.
 *
 * bun's `mock.module` keeps ONE module namespace per specifier for the whole
 * test process, and ES module namespaces are not extensible: the first
 * registration fixes the export set, and later registrations can only patch
 * keys that already exist. Spec files that mocked this SDK with different
 * shapes therefore poisoned each other in whole-directory runs (e.g. a run
 * reaching `createReadTool` failed with "not a function" because the
 * first-loaded factory never exported that key).
 *
 * This module registers the full union of exports exactly once, then lets
 * each spec file patch every key via `configurePiSdkMock()` at module top
 * level (bun loads and runs test files sequentially, so the last-loaded file
 * owns the implementation while its tests run). Keys a spec leaves out become
 * `undefined` — the same "SDK export absent" semantics the provider already
 * degrades on (e.g. `defineTool ?? identity`).
 *
 * If the provider starts using a new SDK export, add it to `namespaceFor`.
 */

type AnyFn = (...args: never[]) => unknown;

export interface PiSdkMockImpl {
  AuthStorage?: { create: AnyFn };
  SettingsManager?: { create: AnyFn };
  DefaultResourceLoader?: new (options: Record<string, unknown>) => {
    reload: () => Promise<void> | void;
  };
  defineTool?: AnyFn;
  createReadTool?: AnyFn;
  createBashTool?: AnyFn;
  createEditTool?: AnyFn;
  createWriteTool?: AnyFn;
  createGrepTool?: AnyFn;
  createFindTool?: AnyFn;
  createLsTool?: AnyFn;
  ModelRegistry?: { create?: AnyFn; inMemory?: AnyFn };
  SessionManager?: { open?: AnyFn; inMemory?: AnyFn };
  createAgentSession?: AnyFn;
  getAgentDir?: AnyFn;
}

const SPECIFIER = '@earendil-works/pi-coding-agent';

/** Always enumerate every key explicitly so each registration patches all of them. */
function namespaceFor(impl: PiSdkMockImpl): Record<string, unknown> {
  return {
    AuthStorage: impl.AuthStorage,
    SettingsManager: impl.SettingsManager,
    DefaultResourceLoader: impl.DefaultResourceLoader,
    defineTool: impl.defineTool,
    createReadTool: impl.createReadTool,
    createBashTool: impl.createBashTool,
    createEditTool: impl.createEditTool,
    createWriteTool: impl.createWriteTool,
    createGrepTool: impl.createGrepTool,
    createFindTool: impl.createFindTool,
    createLsTool: impl.createLsTool,
    ModelRegistry: impl.ModelRegistry,
    SessionManager: impl.SessionManager,
    createAgentSession: impl.createAgentSession,
    getAgentDir: impl.getAgentDir,
  };
}

// Establish the full export set before any spec registers a narrower shape.
mock.module(SPECIFIER, () => namespaceFor({}));

/** Install this spec file's Pi SDK implementation. Call at module top level. */
export function configurePiSdkMock(impl: PiSdkMockImpl): void {
  mock.module(SPECIFIER, () => namespaceFor(impl));
}
