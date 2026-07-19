import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COMPACTION_SETTINGS,
  compact,
  generateSummary,
  shouldCompact,
  type CompactionResult,
} from '@earendil-works/pi-coding-agent';

/**
 * Contract spec pinning the exact Pi SDK surface the Nuncio compaction layer
 * rides (plans/260719-engine-shell-and-compaction, phase 04). A Pi version
 * bump that moves any of this turns the gate red loudly here instead of
 * breaking the compaction extension silently. Maintenance answer, not a
 * behavior test — same pattern as pi-agent.cwd.spec.ts pinning customTools
 * precedence and design-tokens.spec.ts pinning the oklch source.
 */

const SDK_ROOT = join(
  import.meta.dir, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent',
);

function sdkTypes(relPath: string): string {
  return readFileSync(join(SDK_ROOT, relPath), 'utf8');
}

describe('Pi SDK compaction contract (0.80.x)', () => {
  it('exports the compaction machinery the extension replaces or reuses', () => {
    // 0.80.6 does not export prepareCompaction — the hook event carries the
    // prepared data instead, so the layer never needs to call it.
    expect(typeof compact).toBe('function');
    expect(typeof generateSummary).toBe('function');
    expect(typeof shouldCompact).toBe('function');
  });

  it('keeps the default trigger settings shape (enabled/reserve/keep-recent)', () => {
    // typeof asserts on purpose: bun's toMatchObject with expect.any() MUTATES
    // the received object, which would corrupt this shared SDK module constant.
    expect(typeof DEFAULT_COMPACTION_SETTINGS.enabled).toBe('boolean');
    expect(typeof DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBe('number');
    expect(typeof DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe('number');
    // The trigger the layer piggybacks on: over (window - reserve) → compact.
    expect(shouldCompact(1000, 1000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(shouldCompact(0, 1_000_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  });

  it('CompactionResult carries the replacement fields the hook must produce', () => {
    // Type-level pin: assignments fail tsc (the lint gate) if the SDK renames
    // or retypes the fields the extension returns from session_before_compact.
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
    const types = sdkTypes('dist/core/extensions/types.d.ts');
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

  it('the preparation still exposes discarded messages, prior summary, and file ops', () => {
    const types = sdkTypes('dist/core/compaction/compaction.d.ts');
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
    const runner = readFileSync(join(SDK_ROOT, 'dist', 'core', 'extensions', 'runner.js'), 'utf8');
    const emitBody = runner.slice(runner.indexOf('async emit(event)'));
    expect(emitBody).toContain('catch (err)');
    expect(emitBody).toContain('this.emitError');
    const agentSession = readFileSync(join(SDK_ROOT, 'dist', 'core', 'agent-session.js'), 'utf8');
    expect(agentSession).toContain('if (extensionCompaction)');
    expect(agentSession).toContain('this.sessionManager.appendCompaction(summary, firstKeptEntryId');
  });
});
