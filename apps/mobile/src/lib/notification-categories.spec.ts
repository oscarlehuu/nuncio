import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({ setNotificationCategoryAsync: vi.fn(async () => ({})) }));

import {
  APPROVAL_CATEGORY,
  MAX_QUESTION_OPTIONS,
  QUESTION_CATEGORY,
  approvalCategoryActions,
  questionCategoryActions,
  questionOptionActionId,
  registerNotificationCategories,
} from './notification-categories';

describe('questionCategoryActions', () => {
  it('exposes four generic option buttons plus Open, in order', () => {
    const actions = questionCategoryActions();
    expect(actions.map((a) => a.identifier)).toEqual(['opt_1', 'opt_2', 'opt_3', 'opt_4', 'open']);
    expect(actions.map((a) => a.buttonTitle)).toEqual([
      'Option 1',
      'Option 2',
      'Option 3',
      'Option 4',
      'Open',
    ]);
  });

  it('never exceeds the four options the QUESTION payload can carry', () => {
    const options = questionCategoryActions().filter((a) => a.identifier.startsWith('opt_'));
    expect(options).toHaveLength(MAX_QUESTION_OPTIONS);
  });

  it('opens the app for every action so a killed app still routes the tap', () => {
    for (const action of questionCategoryActions()) {
      expect(action.options?.opensAppToForeground).toBe(true);
    }
  });
});

describe('approvalCategoryActions', () => {
  it('offers Approve, a destructive Deny, and Open', () => {
    const actions = approvalCategoryActions();
    expect(actions.map((a) => a.identifier)).toEqual(['approve', 'deny', 'open']);
    expect(actions.find((a) => a.identifier === 'deny')?.options?.isDestructive).toBe(true);
    for (const action of actions) {
      expect(action.options?.opensAppToForeground).toBe(true);
    }
  });
});

describe('category identifiers', () => {
  it('match the frozen server contract and avoid the reserved ":"/"-" characters', () => {
    expect(QUESTION_CATEGORY).toBe('QUESTION');
    expect(APPROVAL_CATEGORY).toBe('APPROVAL');
    expect(QUESTION_CATEGORY).not.toMatch(/[:-]/);
    expect(APPROVAL_CATEGORY).not.toMatch(/[:-]/);
  });

  it('keys option buttons 1-based', () => {
    expect(questionOptionActionId(1)).toBe('opt_1');
    expect(questionOptionActionId(4)).toBe('opt_4');
  });
});

describe('registerNotificationCategories', () => {
  it('registers both categories and resolves true', async () => {
    const Notifications = (await import('expo-notifications')) as unknown as {
      setNotificationCategoryAsync: ReturnType<typeof vi.fn>;
    };
    Notifications.setNotificationCategoryAsync.mockClear();
    await expect(registerNotificationCategories()).resolves.toBe(true);
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      'QUESTION',
      questionCategoryActions(),
    );
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      'APPROVAL',
      approvalCategoryActions(),
    );
  });

  it('swallows a native failure and resolves false', async () => {
    const Notifications = (await import('expo-notifications')) as unknown as {
      setNotificationCategoryAsync: ReturnType<typeof vi.fn>;
    };
    Notifications.setNotificationCategoryAsync.mockRejectedValueOnce(new Error('no native module'));
    await expect(registerNotificationCategories()).resolves.toBe(false);
  });
});
