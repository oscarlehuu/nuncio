import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { PushController } from '../../../src/push/push.controller';

type PushSpy = {
  register: (token: string, platform?: string, deviceName?: string) => void;
  unregister: (token: string) => void;
  registerCalls: Array<[string, string | undefined, string | undefined]>;
  unregisterCalls: string[];
};

describe('PushController', () => {
  function controllerFor(): { controller: PushController; push: PushSpy } {
    const push: PushSpy = {
      registerCalls: [],
      unregisterCalls: [],
      register(token, platform, deviceName) {
        push.registerCalls.push([token, platform, deviceName]);
      },
      unregister(token) {
        push.unregisterCalls.push(token);
      },
    };
    return { controller: new PushController(push as never), push };
  }

  it('registers a trimmed Expo token with optional metadata', () => {
    const { controller, push } = controllerFor();
    expect(
      controller.register({
        token: '  ExponentPushToken[abc]  ',
        platform: 'ios',
        deviceName: 'Phone',
      }),
    ).toEqual({ ok: true });
    expect(push.registerCalls).toEqual([['ExponentPushToken[abc]', 'ios', 'Phone']]);
  });

  it('rejects register without a token', () => {
    const { controller } = controllerFor();
    expect(() => controller.register({ token: '  ' })).toThrow(BadRequestException);
    expect(() => controller.register({ token: 123 })).toThrow(BadRequestException);
  });

  it('unregisters a trimmed Expo token', () => {
    const { controller, push } = controllerFor();
    expect(controller.unregister({ token: ' ExponentPushToken[abc] ' })).toEqual({ ok: true });
    expect(push.unregisterCalls).toEqual(['ExponentPushToken[abc]']);
  });

  it('rejects unregister without a token', () => {
    const { controller } = controllerFor();
    expect(() => controller.unregister({})).toThrow(BadRequestException);
  });
});
