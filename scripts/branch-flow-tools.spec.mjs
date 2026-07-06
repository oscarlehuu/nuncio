import { describe, expect, it } from 'bun:test';
import { validateBranchFlow } from './branch-flow-utils.mjs';

describe('validateBranchFlow', () => {
  describe('main', () => {
    it('accepts promotion from dev', () => {
      expect(validateBranchFlow('main', 'dev')).toEqual({ ok: true });
    });

    it('accepts changesets release branches', () => {
      expect(validateBranchFlow('main', 'changeset-release/main')).toEqual({ ok: true });
      expect(validateBranchFlow('main', 'changeset-release/next')).toEqual({ ok: true });
    });

    it('rejects feature branches that skip dev', () => {
      expect(validateBranchFlow('main', 'feat/steer-queue-ui').ok).toBe(false);
      expect(validateBranchFlow('main', 'fix/idle-composer-lock').ok).toBe(false);
      expect(validateBranchFlow('main', 'docs/readme-refresh').ok).toBe(false);
    });

    it('rejects retired SDK lane branches', () => {
      expect(validateBranchFlow('main', 'cursor-sdk').ok).toBe(false);
      expect(validateBranchFlow('main', 'pi-sdk').ok).toBe(false);
      expect(validateBranchFlow('main', 'codex-sdk').ok).toBe(false);
    });
  });

  describe('dev', () => {
    it('accepts any feature branch', () => {
      expect(validateBranchFlow('dev', 'feat/steer-queue-ui')).toEqual({ ok: true });
      expect(validateBranchFlow('dev', 'fix/idle-composer-lock')).toEqual({ ok: true });
      expect(validateBranchFlow('dev', 'chore/ci-cache')).toEqual({ ok: true });
    });

    it('accepts main sync-back after a release', () => {
      expect(validateBranchFlow('dev', 'main')).toEqual({ ok: true });
    });
  });

  describe('other bases', () => {
    it('allows any head for unconfigured bases', () => {
      expect(validateBranchFlow('feat/experiment', 'feat/spike')).toEqual({ ok: true });
    });
  });
});
