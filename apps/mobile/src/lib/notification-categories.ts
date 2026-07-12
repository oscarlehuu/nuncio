import * as Notifications from 'expo-notifications';

/**
 * Lock-screen / notification-shade action buttons. The server stamps each push
 * with a `categoryId` (QUESTION or APPROVAL); the OS renders the matching
 * category's action buttons on the delivered notification.
 *
 * Categories are STATIC — registered once at launch and shared by every push —
 * so a QUESTION notification can't carry its real option labels ("1 · Rebase")
 * on the buttons. It instead reuses generic "Option 1"–"Option 4" buttons keyed
 * `opt_1`..`opt_4`; the payload's `options:[{n,label}]` is what a later lane will
 * read to answer inline. For now a tap on ANY button (or the body) just
 * deep-links into the session, so every action sets `opensAppToForeground` —
 * without it a tap on a killed app would be swallowed instead of routing.
 */

// The identifiers the server stamps onto each push. Category identifiers must
// avoid ':' and '-' (expo-notifications drops actions for ids containing them).
export const QUESTION_CATEGORY = 'QUESTION';
export const APPROVAL_CATEGORY = 'APPROVAL';

/** The QUESTION payload carries at most four options — one static button each. */
export const MAX_QUESTION_OPTIONS = 4;

/** Stable action id for the Nth (1-based) QUESTION option button. */
export function questionOptionActionId(n: number): string {
  return `opt_${n}`;
}

const FOREGROUND = { opensAppToForeground: true } as const;

/** Generic option buttons (opt_1..opt_4) plus a catch-all Open. */
export function questionCategoryActions(): Notifications.NotificationAction[] {
  const options = Array.from({ length: MAX_QUESTION_OPTIONS }, (_, index) => {
    const n = index + 1;
    return {
      identifier: questionOptionActionId(n),
      buttonTitle: `Option ${n}`,
      options: FOREGROUND,
    };
  });
  return [...options, { identifier: 'open', buttonTitle: 'Open', options: FOREGROUND }];
}

/** Approve / Deny (destructive) / Open. */
export function approvalCategoryActions(): Notifications.NotificationAction[] {
  return [
    { identifier: 'approve', buttonTitle: 'Approve', options: FOREGROUND },
    { identifier: 'deny', buttonTitle: 'Deny', options: { ...FOREGROUND, isDestructive: true } },
    { identifier: 'open', buttonTitle: 'Open', options: FOREGROUND },
  ];
}

/**
 * Register both categories so their buttons appear on delivered pushes. Safe on
 * every launch — `setNotificationCategoryAsync` upserts by identifier. Best
 * effort: a device without notification support (or Expo Go) still runs the app
 * fully, so a failure resolves to `false` rather than throwing.
 */
export async function registerNotificationCategories(): Promise<boolean> {
  try {
    await Promise.all([
      Notifications.setNotificationCategoryAsync(QUESTION_CATEGORY, questionCategoryActions()),
      Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, approvalCategoryActions()),
    ]);
    return true;
  } catch {
    return false;
  }
}
