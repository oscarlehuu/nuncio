import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildNuncioEngineExtension,
  NUNCIO_ENGINE_EXTENSION_NAME,
} from '../../../src/agents/pi-engine/engine-extension';

type Handler = (event: unknown) => unknown;

/** Minimal ExtensionAPI double: records `on` registrations for direct driving. */
function fakeExtensionApi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    handlers,
  };
}

async function runFactory(extension: unknown, api: unknown): Promise<void> {
  const inline = extension as { name: string; factory: (api: unknown) => void | Promise<void> };
  await inline.factory(api);
}

describe('buildNuncioEngineExtension', () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-engine-ext-')));

  it('is a named inline extension so the loader lists it recognizably', () => {
    const extension = buildNuncioEngineExtension({ cwd: workspace, gateGuard: true }) as {
      name?: string;
    };
    expect(extension.name).toBe(NUNCIO_ENGINE_EXTENSION_NAME);
  });

  it('registers a tool_call hook when the gate guard is enabled', async () => {
    const { api, handlers } = fakeExtensionApi();
    await runFactory(buildNuncioEngineExtension({ cwd: workspace, gateGuard: true }), api);
    expect(handlers.get('tool_call')?.length).toBe(1);
  });

  it('registers no hooks when the gate guard is disabled', async () => {
    const { api, handlers } = fakeExtensionApi();
    await runFactory(buildNuncioEngineExtension({ cwd: workspace, gateGuard: false }), api);
    expect(handlers.size).toBe(0);
  });

  it('blocks a write into the gate directory and passes everything else through', async () => {
    const { api, handlers } = fakeExtensionApi();
    await runFactory(buildNuncioEngineExtension({ cwd: workspace, gateGuard: true }), api);
    const [hook] = handlers.get('tool_call')!;

    const blocked = hook!({
      type: 'tool_call',
      toolCallId: 'c1',
      toolName: 'write',
      input: { path: '.nuncio/verify', content: 'exit 0' },
    }) as { block?: boolean; reason?: string } | undefined;
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain('.nuncio');

    const allowed = hook!({
      type: 'tool_call',
      toolCallId: 'c2',
      toolName: 'write',
      input: { path: 'src/app.ts', content: 'export {}' },
    });
    expect(allowed).toBeUndefined();
  });
});
