import {
  looksLikeSecretKey,
  resolveTransport,
  transportIdentity,
} from '../../../src/mcp/domain/mcp-transport';
import type { McpTransport } from '../../../src/mcp/domain/mcp.types';

describe('transportIdentity', () => {
  it('identifies stdio transports by command + args, ignoring env/cwd', () => {
    const a: McpTransport = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'ios-simulator-mcp'],
      env: { FOO: 'bar' },
      cwd: '/somewhere',
    };
    const b: McpTransport = { type: 'stdio', command: 'npx', args: ['-y', 'ios-simulator-mcp'] };
    expect(transportIdentity(a)).toBe(transportIdentity(b));
  });

  it('differs when args differ', () => {
    const a: McpTransport = { type: 'stdio', command: 'npx', args: ['-y', 'a-mcp'] };
    const b: McpTransport = { type: 'stdio', command: 'npx', args: ['-y', 'b-mcp'] };
    expect(transportIdentity(a)).not.toBe(transportIdentity(b));
  });

  it('identifies remote transports by normalized url, ignoring headers and http/sse flavor', () => {
    const a: McpTransport = { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { A: '1' } };
    const b: McpTransport = { type: 'sse', url: 'https://mcp.figma.com/mcp/' };
    expect(transportIdentity(a)).toBe(transportIdentity(b));
  });

  it('never collides stdio with remote', () => {
    const a: McpTransport = { type: 'stdio', command: 'https://mcp.figma.com/mcp', args: [] };
    const b: McpTransport = { type: 'http', url: 'https://mcp.figma.com/mcp' };
    expect(transportIdentity(a)).not.toBe(transportIdentity(b));
  });
});

describe('resolveTransport', () => {
  it('substitutes ${workspace} in command, args, cwd and env values', () => {
    const resolved = resolveTransport(
      {
        type: 'stdio',
        command: '${workspace}/bin/tool',
        args: ['--root', '${workspace}/src'],
        env: { PROJECT_DIR: '${workspace}' },
        cwd: '${workspace}',
      },
      '/tmp/wt',
    );
    expect(resolved).toEqual({
      type: 'stdio',
      command: '/tmp/wt/bin/tool',
      args: ['--root', '/tmp/wt/src'],
      env: { PROJECT_DIR: '/tmp/wt' },
      cwd: '/tmp/wt',
    });
  });

  it('substitutes ${workspace} in url and header values', () => {
    const resolved = resolveTransport(
      { type: 'http', url: 'http://localhost:9/${workspace}', headers: { 'X-Dir': '${workspace}' } },
      '/tmp/wt',
    );
    expect(resolved).toEqual({
      type: 'http',
      url: 'http://localhost:9//tmp/wt',
      headers: { 'X-Dir': '/tmp/wt' },
    });
  });

  it('leaves the placeholder untouched when workspace is null', () => {
    const transport: McpTransport = { type: 'stdio', command: 'run', args: ['${workspace}'] };
    expect(resolveTransport(transport, null)).toEqual(transport);
  });

  it('returns an unmodified clone when there is nothing to substitute', () => {
    const transport: McpTransport = { type: 'stdio', command: 'npx', args: ['-y', 'x'] };
    const resolved = resolveTransport(transport, '/tmp/wt');
    expect(resolved).toEqual(transport);
    expect(resolved).not.toBe(transport);
  });
});

describe('looksLikeSecretKey', () => {
  it.each(['API_TOKEN', 'my_secret', 'AUTH_KEY', 'PASSWORD', 'Authorization', 'x-api-key'])(
    'flags %s',
    (key) => {
      expect(looksLikeSecretKey(key)).toBe(true);
    },
  );

  it.each(['PROJECT_DIR', 'PATH', 'NODE_ENV', 'Content-Type'])('does not flag %s', (key) => {
    expect(looksLikeSecretKey(key)).toBe(false);
  });
});
