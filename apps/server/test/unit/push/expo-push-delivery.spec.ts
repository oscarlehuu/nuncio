import { describe, expect, it } from 'bun:test';
import {
  ExpoPushDelivery,
  type ExpoSdkClient,
  type PushMessage,
} from '../../../src/push/expo-push-delivery';

const message: PushMessage = {
  to: 'ExponentPushToken[phone]',
  title: 'Question',
  body: 'Choose',
  data: {},
  sound: 'default',
};

describe('ExpoPushDelivery', () => {
  it('uses SDK message/receipt chunking and treats receipt failures as best-effort', async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const sdk: ExpoSdkClient = {
      isExpoPushToken: () => true,
      chunkPushNotifications: (messages) => {
        calls.push('chunk-messages');
        return messages.map((item) => [item]);
      },
      sendPushNotificationsAsync: async () => {
        calls.push('send');
        return [{ status: 'ok', id: 'receipt-1' }];
      },
      chunkPushNotificationReceiptIds: (ids) => {
        calls.push(`chunk-receipts:${ids.join(',')}`);
        return [ids];
      },
      getPushNotificationReceiptsAsync: async () => {
        calls.push('receipts');
        throw new Error('receipts unavailable');
      },
    };
    const delivery = new ExpoPushDelivery((context) => failures.push(context));
    delivery.setSdk(sdk);

    await expect(delivery.send([message, message])).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      'chunk-messages',
      'send',
      'send',
      'chunk-receipts:receipt-1,receipt-1',
      'receipts',
    ]);
    expect(failures).toEqual(['read Expo push receipts']);
  });
});
