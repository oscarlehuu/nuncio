import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerChipPicker } from './mcp-server-chip-picker';
import type { McpServerDto } from '../lib/mcp-servers-api';

vi.mock('../lib/mcp-servers-api', () => ({
  fetchMcpServers: vi.fn(),
}));

import { fetchMcpServers } from '../lib/mcp-servers-api';

function server(overrides: Partial<McpServerDto> = {}): McpServerDto {
  return {
    id: 'global',
    name: 'Global tools',
    description: null,
    transport: { type: 'stdio', command: 'node', args: [] },
    enabled: true,
    advertise: 'lazy',
    projectPath: null,
    engines: null,
    auth: 'none',
    oauthStatus: 'none',
    sources: [],
    secretKeys: [],
    scope: 'global',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('McpServerChipPicker', () => {
  beforeEach(() => {
    vi.mocked(fetchMcpServers).mockReset();
  });

  it('shows enabled global and matching project servers only', async () => {
    vi.mocked(fetchMcpServers).mockResolvedValue([
      server(),
      server({ id: 'project', name: 'Project tools', projectPath: '/repo/' }),
      server({ id: 'other', name: 'Other project', projectPath: '/else' }),
      server({ id: 'disabled', name: 'Disabled', enabled: false }),
    ]);

    render(
      <McpServerChipPicker
        projectPath="/repo"
        selectedIds={[]}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: /add mcp server global tools/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add mcp server project tools/i })).toBeInTheDocument();
    expect(screen.queryByText('Other project')).not.toBeInTheDocument();
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
  });

  it('adds and removes selected server ids', async () => {
    vi.mocked(fetchMcpServers).mockResolvedValue([server()]);
    const onChange = vi.fn();
    render(<McpServerChipPicker selectedIds={['global']} onChange={onChange} />);

    const chip = await screen.findByRole('button', { name: /remove mcp server global tools/i });
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith([]);

    await waitFor(() => expect(fetchMcpServers).toHaveBeenCalledTimes(1));
  });
});
