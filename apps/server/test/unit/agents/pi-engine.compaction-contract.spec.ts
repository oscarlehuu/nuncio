import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompactionResult } from '@earendil-works/pi-coding-agent';

/**
 * Contract spec pinning the exact Pi SDK surface the Nuncio compaction layer
 * rides (plans/260719-engine-shell-and-compaction, phase 04). A Pi version
 * bump that moves any of this turns the gate red loudly here instead of
 * breaking the compaction extension silently. Maintenance answer, not a
 * behavior test — same pattern as pi-agent.cwd.spec.ts pinning customTools
 * precedence and design-tokens.spec.ts pinning the oklch source.
 *
 * Deliberately file-based (dist text + type-only imports): pi-sdk.mock.ts
 * registers a process-wide `mock.module` for the SDK specifier in
 * whole-directory runs, so runtime imports here would see the mock, not the
 * artifact this spec exists to pin.
 */

const SDK_ROOT = join(
  __dirname, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent',
);

function sdkFile(relPath: string): string {
  return readFileSync(join(SDK_ROOT, relPath), 'utf8');
}

describe('Pi SDK compaction contract (0.80.x)', () => {
  it('exports the compaction machinery the extension replaces or reuses', () => {
    const index = sdkFile('dist/index.d.ts');
    // 0.80.6 does not export prepareCompaction — the hook event carries the
    // prepared data instead, so the layer never needs to call it.
    for (const name of ['compact', 'generateSummary', 'shouldCompact', 'DEFAULT_COMPACTION_SETTINGS', 'CompactionResult']) {
      expect(index).toContain(name);
    }
  });

  it('keeps the trigger semantics the layer piggybacks on (window - reserve)', () => {
    const compaction = sdkFile('dist/core/compaction/compaction.js');
    expect(compaction).toContain('reserveTokens: 16384');
    expect(compaction).toContain('keepRecentTokens: 20000');
    expect(compaction).toContain('contextTokens > contextWindow - settings.reserveTokens');
  });

  it('CompactionResult carries the replacement fields the hook must produce', () => {
    // Type-level pin: this assignment fails tsc (the lint gate) if the SDK
    // renames or retypes the fields the extension returns from the hook.
    const result: CompactionResult = {
      summary: 'survivors + narrative',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 123,
    };
    expect(result.summary).toBeString();
    expect(result.firstKeptEntryId).toBeString();
    expect(result.tokensBefore).toBeNumber();
  });

  it('the extension surface still declares the session_before_compact hook', () => {
    const types = sdkFile('dist/core/extensions/types.d.ts');
    // Event fields the handler consumes.
    expect(types).toContain('interface SessionBeforeCompactEvent');
    expect(types).toContain('preparation: CompactionPreparation');
    expect(types).toContain('branchEntries: SessionEntry[]');
    expect(types).toContain('reason: "manual" | "threshold" | "overflow"');
    expect(types).toContain('willRetry');
    // Result fields the handler produces (full replacement is officially supported).
    expect(types).toContain('interface SessionBeforeCompactResult');
    expect(types).toContain('compaction?: CompactionResult');
    // Registration seam used by the nuncio-engine inline extension.
    expect(types).toContain(
      'on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void',
    );
  });

  it('generateSummary keeps the argument order the summarizer wrapper passes', () => {
    const compaction = sdkFile('dist/core/compaction/compaction.d.ts');
    expect(compaction).toContain(
      'generateSummary(currentMessages: AgentMessage[], model: Model<any>, reserveTokens: number, '
      + 'apiKey: string | undefined, headers?: Record<string, string>, signal?: AbortSignal, '
      + 'customInstructions?: string, previousSummary?: string, thinkingLevel?: ThinkingLevel, '
      + 'streamFn?: StreamFn, env?: Record<string, string>)',
    );
  });

  it('the preparation still exposes discarded messages, prior summary, and file ops', () => {
    const types = sdkFile('dist/core/compaction/compaction.d.ts');
    expect(types).toContain('messagesToSummarize: AgentMessage[]');
    expect(types).toContain('turnPrefixMessages: AgentMessage[]');
    expect(types).toContain('isSplitTurn: boolean');
    expect(types).toContain('previousSummary?: string');
    expect(types).toContain('fileOps: FileOperations');
    expect(types).toContain('firstKeptEntryId: string');
  });

  it('a handler failure stays fail-open: the runner catches and Pi compaction proceeds', () => {
    // Pinned against dist because this is the safety property the whole layer
    // leans on: a throwing session_before_compact handler must surface as an
    // extension error, not replace or cancel compaction.
    const runner = sdkFile('dist/core/extensions/runner.js');
    const emitBody = runner.slice(runner.indexOf('async emit(event)'));
    expect(emitBody).toContain('catch (err)');
    expect(emitBody).toContain('this.emitError');
    const agentSession = sdkFile('dist/core/agent-session.js');
    expect(agentSession).toContain('if (extensionCompaction)');
    expect(agentSession).toContain('this.sessionManager.appendCompaction(summary, firstKeptEntryId');
  });
});
