import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { WebhooksController } from '../../../src/forges/webhooks/webhooks.controller';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';

describe('WebhooksController', () => {
  const event: ForgeWebhookEvent = {
    provider: 'github',
    deliveryId: 'd-1',
    kind: 'issue',
    action: 'opened',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 1,
    title: 'Task',
    body: 'body',
    labels: [],
  };

  function controllerFor(opts: {
    verify?: boolean;
    parse?: ForgeWebhookEvent | null;
    handle?: Record<string, unknown>;
  }) {
    const provider = {
      verifyWebhookSignature: () => opts.verify ?? true,
      parseWebhookEvent: () => ('parse' in opts ? opts.parse : event),
    };
    const registry = { get: (_id: string) => provider };
    const handleCalls: Array<[string, ForgeWebhookEvent]> = [];
    const webhooks = {
      handleEvent: async (providerId: string, parsed: ForgeWebhookEvent) => {
        handleCalls.push([providerId, parsed]);
        return opts.handle ?? { created: 1 };
      },
    };
    const controller = new WebhooksController(registry as never, webhooks as never);
    return { controller, handleCalls };
  }

  it('rejects requests with an invalid signature', async () => {
    const { controller } = controllerFor({ verify: false });
    await expect(
      controller.receive('github', {}, {}, { rawBody: Buffer.from('{}') }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ignores events the provider cannot parse', async () => {
    const { controller, handleCalls } = controllerFor({ parse: null });
    await expect(
      controller.receive('github', { 'x-github-event': 'ping' }, {}, { rawBody: Buffer.from('{}') }),
    ).resolves.toEqual({ ok: true, ignored: true });
    expect(handleCalls).toHaveLength(0);
  });

  it('forwards verified events to WebhooksService and returns 202 payload', async () => {
    const { controller, handleCalls } = controllerFor({ handle: { sessionId: 's-1' } });
    const raw = Buffer.from('{"action":"opened"}');
    await expect(
      controller.receive('github', { 'x-github-event': 'issues' }, { action: 'opened' }, { rawBody: raw }),
    ).resolves.toEqual({ ok: true, sessionId: 's-1' });
    expect(handleCalls).toEqual([['github', event]]);
  });

  it('treats a missing raw body as an empty string for signature verification', async () => {
    let verifiedRaw = '';
    const provider = {
      verifyWebhookSignature: (_headers: Record<string, string | undefined>, raw: string) => {
        verifiedRaw = raw;
        return true;
      },
      parseWebhookEvent: () => null,
    };
    const controller = new WebhooksController(
      { get: () => provider } as never,
      { handleEvent: async () => ({}) } as never,
    );
    await controller.receive('github', {}, {}, {});
    expect(verifiedRaw).toBe('');
  });
});
