import { EventEmitter } from 'node:events';
import { DevinAcpClient } from '../../../src/agents/providers/devin-acp.client';

class FakeTransport extends EventEmitter {
  readonly sent: unknown[] = [];
  closeCount = 0;
  sendError?: Error;

  send(message: unknown): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }

  close(): void {
    this.closeCount += 1;
  }

  line(message: unknown): void {
    this.emit('line', JSON.stringify(message));
  }
}

describe('DevinAcpClient', () => {
  it('keeps an explicitly unbounded prompt request alive past a control-style deadline', async () => {
    const transport = new FakeTransport();
    const client = new DevinAcpClient(transport);
    const prompt = client.request('session/prompt', { sessionId: 's1' }, null);

    const early = await Promise.race([
      prompt.then(() => 'settled', () => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(early).toBe('pending');

    transport.line({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    client.close();
  });

  it('still times out finite control requests and ignores their late response', async () => {
    const transport = new FakeTransport();
    const client = new DevinAcpClient(transport);
    const control = client.request('session/new', {}, 5);

    await expect(control).rejects.toThrow('Timed out waiting for session/new.');
    transport.line({ jsonrpc: '2.0', id: 1, result: { sessionId: 'late' } });
    expect(transport.sent).toHaveLength(1);
    client.close();
  });

  it('treats zero and negative deadlines as finite instead of disabling timeout', async () => {
    for (const timeoutMs of [0, -1]) {
      const transport = new FakeTransport();
      const client = new DevinAcpClient(transport);
      await expect(client.request('session/new', {}, timeoutMs)).rejects.toThrow(
        'Timed out waiting for session/new.',
      );
      client.close();
    }
  });

  it('removes a request whose transport send throws and closes transport once', async () => {
    const transport = new FakeTransport();
    const client = new DevinAcpClient(transport);
    transport.sendError = new Error('stdin closed');

    await expect(client.request('session/new', {}, 5)).rejects.toThrow('stdin closed');
    client.close();
    client.close();
    expect(transport.closeCount).toBe(1);
  });

  it('serializes a JSON-RPC error response for a server callback', () => {
    const transport = new FakeTransport();
    const client = new DevinAcpClient(transport);

    client.respondError(7, { code: -32002, message: 'File not found' });

    expect(transport.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32002, message: 'File not found' },
      },
    ]);
    client.close();
  });
});
