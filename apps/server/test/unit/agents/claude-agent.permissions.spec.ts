import { describe, it, expect } from 'bun:test';
import {
  buildApprovalRequest,
  decisionToPermissionResult,
  denyResult,
  interactionToDecision,
  type ClaudePermissionOptions,
} from '../../../src/agents/providers/claude-agent.permissions';

function options(overrides: Partial<ClaudePermissionOptions> = {}): ClaudePermissionOptions {
  return { requestId: 'req-1', ...overrides };
}

describe('claude permission bridge', () => {
  describe('buildApprovalRequest prompt text', () => {
    it('prefers the bridge title when present', () => {
      const request = buildApprovalRequest('claude', 'Read', { path: 'a.txt' }, options({ title: 'Claude wants to read a.txt' }));
      expect((request.params as Record<string, unknown>).prompt).toBe('Claude wants to read a.txt');
      expect(request.method).toBe('tool/approve');
      expect(request.provider).toBe('claude');
    });

    it('composes displayName + description when title is absent (the Write case)', () => {
      const request = buildApprovalRequest(
        'claude',
        'Write',
        { path: '/tmp/x' },
        options({ displayName: 'Write', description: '/tmp/x', decisionReason: 'outside cwd', blockedPath: '/tmp/x' }),
      );
      const params = request.params as Record<string, unknown>;
      expect(params.prompt).toBe('Write: /tmp/x');
      expect(params.toolName).toBe('Write');
      expect(params.decisionReason).toBe('outside cwd');
      expect(params.blockedPath).toBe('/tmp/x');
    });

    it('falls back to the tool name when title, displayName, and description are all absent', () => {
      const request = buildApprovalRequest('claude', 'Bash', { command: 'curl x' }, options());
      expect((request.params as Record<string, unknown>).prompt).toBe('Bash');
    });
  });

  describe('decisionToPermissionResult', () => {
    it('maps approve → allow echoing the input', () => {
      const result = decisionToPermissionResult('approve', { command: 'curl x' }, options());
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'curl x' } });
    });

    it('maps deny → deny with a human message', () => {
      const result = decisionToPermissionResult('deny', { command: 'curl x' }, options());
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') expect(result.message.length).toBeGreaterThan(0);
    });

    it('returns suggestions as updatedPermissions on always-allow', () => {
      const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
      const result = decisionToPermissionResult('approve', { path: 'a' }, options({ suggestions }), true);
      expect(result).toEqual({ behavior: 'allow', updatedInput: { path: 'a' }, updatedPermissions: suggestions });
    });

    it('always-allow with no suggestions degrades to a plain allow', () => {
      const result = decisionToPermissionResult('approve', { path: 'a' }, options({ suggestions: [] }), true);
      expect(result).toEqual({ behavior: 'allow', updatedInput: { path: 'a' } });
    });
  });

  describe('interactionToDecision', () => {
    it('treats skip as deny (fail-closed)', () => {
      expect(interactionToDecision({ answers: [], resolvedBy: 'skip' })).toEqual({ decision: 'deny', alwaysAllow: false });
    });

    it('reads an always option as approve + alwaysAllow', () => {
      const decision = interactionToDecision({
        answers: [{ questionId: 'q', selectedOptionIds: ['always'] }],
        resolvedBy: 'user',
      });
      expect(decision).toEqual({ decision: 'approve', alwaysAllow: true });
    });

    it('reads a deny option as deny', () => {
      const decision = interactionToDecision({
        answers: [{ questionId: 'q', selectedOptionIds: ['deny'] }],
        resolvedBy: 'user',
      });
      expect(decision).toEqual({ decision: 'deny', alwaysAllow: false });
    });

    it('a plain user answer is a one-time approve', () => {
      const decision = interactionToDecision({
        answers: [{ questionId: 'q', selectedOptionIds: ['allow'] }],
        resolvedBy: 'user',
      });
      expect(decision).toEqual({ decision: 'approve', alwaysAllow: false });
    });
  });

  it('denyResult is a fail-closed deny', () => {
    expect(denyResult().behavior).toBe('deny');
  });
});
