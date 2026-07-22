import {
  isAcpToolTerminal,
  mapAcpToolCall,
  mapPermissionDecision,
} from '../../../src/agents/providers/devin-acp.mappers';

describe('devin-acp.mappers', () => {
  describe('mapAcpToolCall', () => {
    it('maps execute tool calls onto shared callId/tool/input shape', () => {
      expect(
        mapAcpToolCall({
          toolCallId: 'functions.exec:0',
          title: 'git branch',
          kind: 'execute',
          rawInput: { command: 'git branch' },
        }),
      ).toEqual({
        callId: 'functions.exec:0',
        tool: 'exec',
        input: { command: 'git branch' },
      });
    });

    it('falls back to title as command when rawInput is missing', () => {
      expect(
        mapAcpToolCall({
          toolCallId: 'call-1',
          title: 'git status',
          kind: 'execute',
        }),
      ).toEqual({
        callId: 'call-1',
        tool: 'exec',
        input: { command: 'git status' },
      });
    });

    it('returns null without a toolCallId', () => {
      expect(mapAcpToolCall({ title: 'x', kind: 'execute' })).toBeNull();
    });
  });

  describe('isAcpToolTerminal', () => {
    it('seals only completed/failed updates', () => {
      expect(isAcpToolTerminal('completed')).toBe(true);
      expect(isAcpToolTerminal('failed')).toBe(true);
      expect(isAcpToolTerminal('in_progress')).toBe(false);
      expect(isAcpToolTerminal('pending')).toBe(false);
    });
  });

  describe('mapPermissionDecision', () => {
    const params = {
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow session', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    };

    it('selects allow_once on approve', () => {
      expect(mapPermissionDecision('approve', params)).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });
    });

    it('selects reject_once on deny', () => {
      expect(mapPermissionDecision('deny', params)).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject_once' },
      });
    });

    it('cancels when no matching options exist', () => {
      expect(mapPermissionDecision('deny', { options: [] })).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('cancels approve when only reject options exist', () => {
      expect(
        mapPermissionDecision('approve', {
          options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
        }),
      ).toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('falls back to allow_always when allow_once is absent', () => {
      expect(
        mapPermissionDecision('approve', {
          options: [
            { optionId: 'allow_session', name: 'Allow session', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        }),
      ).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow_session' },
      });
    });

    it('falls back to reject_always when reject_once is absent', () => {
      expect(
        mapPermissionDecision('deny', {
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject_session', name: 'Reject session', kind: 'reject_always' },
          ],
        }),
      ).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject_session' },
      });
    });

    it('cancels on malformed permission params', () => {
      expect(mapPermissionDecision('approve', null)).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(mapPermissionDecision('approve', [])).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(mapPermissionDecision('approve', { options: 'nope' })).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(
        mapPermissionDecision('approve', {
          options: [{ optionId: 1, name: 'Allow', kind: 'allow_once' }],
        }),
      ).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  describe('mapAcpToolCall empty rawInput', () => {
    it('falls back to title when rawInput is an empty object', () => {
      expect(
        mapAcpToolCall({
          toolCallId: 'call-1',
          title: 'git status',
          kind: 'execute',
          rawInput: {},
        }),
      ).toEqual({
        callId: 'call-1',
        tool: 'exec',
        input: { command: 'git status' },
      });
    });
  });

  describe('mapAcpToolCall kind / status / raw tool', () => {
    it('maps read and search kinds onto shared tool names', () => {
      expect(
        mapAcpToolCall({
          toolCallId: 'r1',
          kind: 'read',
          title: 'README.md',
        }),
      ).toEqual({
        callId: 'r1',
        tool: 'read',
        input: { title: 'README.md' },
      });
      expect(
        mapAcpToolCall({
          toolCallId: 's1',
          kind: 'search',
          title: 'TODO',
        }),
      ).toEqual({
        callId: 's1',
        tool: 'grep',
        input: { title: 'TODO' },
      });
    });

    it('prefers rawInput.tool over kind and seals failed updates with output', () => {
      expect(
        mapAcpToolCall({
          toolCallId: 't1',
          kind: 'execute',
          status: 'failed',
          rawInput: { tool: 'bash', command: 'false' },
          content: 'exit 1',
        }),
      ).toEqual({
        callId: 't1',
        tool: 'bash',
        input: { tool: 'bash', command: 'false' },
        output: 'exit 1',
        isError: true,
      });
    });
  });
});
