import { describe, expect, it } from 'bun:test';
import { validateBranchFlow } from './branch-flow-utils.mjs';

describe('validateBranchFlow', () => {
  describe('cursor-sdk', () => {
    it('accepts cursor feature branches', () => {
      expect(validateBranchFlow('cursor-sdk', 'cursor/feat-handoff')).toEqual({ ok: true });
    });

    it('accepts main sync-back', () => {
      expect(validateBranchFlow('cursor-sdk', 'main')).toEqual({ ok: true });
    });

    it('rejects pi branches and other targets', () => {
      expect(validateBranchFlow('cursor-sdk', 'pi/cwd-fix').ok).toBe(false);
      expect(validateBranchFlow('cursor-sdk', 'feat/foo').ok).toBe(false);
    });
  });

  describe('pi-sdk', () => {
    it('accepts pi feature branches', () => {
      expect(validateBranchFlow('pi-sdk', 'pi/session-revive')).toEqual({ ok: true });
    });

    it('accepts main sync-back', () => {
      expect(validateBranchFlow('pi-sdk', 'main')).toEqual({ ok: true });
    });

    it('rejects cursor branches', () => {
      expect(validateBranchFlow('pi-sdk', 'cursor/feat-handoff').ok).toBe(false);
    });
  });

  describe('main', () => {
    it('accepts SDK integration branches', () => {
      expect(validateBranchFlow('main', 'cursor-sdk')).toEqual({ ok: true });
      expect(validateBranchFlow('main', 'pi-sdk')).toEqual({ ok: true });
    });

    it('accepts changesets release branch', () => {
      expect(validateBranchFlow('main', 'changeset-release/main')).toEqual({ ok: true });
    });

    it('rejects direct feature branches', () => {
      expect(validateBranchFlow('main', 'cursor/feat-handoff').ok).toBe(false);
      expect(validateBranchFlow('main', 'pi/cwd-fix').ok).toBe(false);
      expect(validateBranchFlow('main', 'feat/foo').ok).toBe(false);
    });
  });

  describe('other bases', () => {
    it('allows any head for unconfigured bases', () => {
      expect(validateBranchFlow('feat/experiment', 'cursor/foo')).toEqual({ ok: true });
    });
  });
});
