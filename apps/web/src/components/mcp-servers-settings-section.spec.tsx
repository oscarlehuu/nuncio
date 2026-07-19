import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpServersSettingsSection } from './mcp-servers-settings-section';
import type { McpServerDto } from '../lib/mcp-servers-api';

vi.mock('../lib/mcp-servers-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/mcp-servers-api')>(
    '../lib/mcp-servers-api',
  );
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    updateMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    previewMcpImport: vi.fn(),
    applyMcpImport: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import {
  applyMcpImport,
  deleteMcpServer,
  fetchMcpServers,
  previewMcpImport,
  updateMcpServer,
} from '../lib/mcp-servers-api';

function makeServer(over: Partial<McpServerDto> = {}): McpServerDto {
  return {
    id: 'bridgememory',
    name: 'bridgememory',
    description: 'persistent memory graph',
    transport: { type: 'stdio', command: 'node', args: ['/x/server.cjs'] },
    enabled: true,
    advertise: 'lazy',
    projectPath: null,
    engines: null,
    auth: 'none',
    oauthStatus: 'none',
    sources: ['import:cursor', 'import:claude'],
    secretKeys: [],
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('McpServersSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchMcpServers).mockResolvedValue([
      makeServer(),
      makeServer({
        id: 'figma',
        name: 'figma',
        description: null,
        transport: { type: 'http', url: 'https://mcp.figma.com/mcp' },
        enabled: false,
        scope: 'project',
        projectPath: '/Users/me/proj',
        sources: ['import:codex'],
      }),
    ]);
  });

  it('lists servers with scope and provenance', async () => {
    render(<McpServersSettingsSection />);
    expect(await screen.findByText('bridgememory')).toBeInTheDocument();
    expect(screen.getByText('figma')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText(/cursor, claude/)).toBeInTheDocument();
  });

  it('toggles a server on/off through the switch', async () => {
    vi.mocked(updateMcpServer).mockResolvedValue(makeServer({ enabled: false }));
    render(<McpServersSettingsSection />);
    await screen.findByText('bridgememory');
    await userEvent.click(screen.getByRole('switch', { name: /enable bridgememory/i }));
    expect(updateMcpServer).toHaveBeenCalledWith('bridgememory', { enabled: false });
  });

  it('runs the import flow: preview dialog then apply', async () => {
    vi.mocked(previewMcpImport).mockResolvedValue({
      source: 'codex',
      entries: [
        {
          status: 'new',
          candidate: {
            name: 'playwright',
            transport: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
            source: 'import:codex',
            projectPath: null,
            enabled: true,
            auth: 'none',
            secretKeys: [],
          },
        },
        {
          status: 'existing',
          existingId: 'bridgememory',
          candidate: {
            name: 'bridgememory',
            transport: { type: 'stdio', command: 'node', args: ['/x/server.cjs'] },
            source: 'import:codex',
            projectPath: null,
            enabled: true,
            auth: 'none',
            secretKeys: [],
          },
        },
      ],
    });
    vi.mocked(applyMcpImport).mockResolvedValue({
      source: 'codex',
      createdIds: ['playwright'],
      mergedIds: ['bridgememory'],
    });

    render(<McpServersSettingsSection />);
    await screen.findByText('bridgememory');
    await userEvent.click(screen.getByRole('button', { name: /import from codex/i }));

    expect(previewMcpImport).toHaveBeenCalledWith('codex');
    expect(await screen.findByText('playwright')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Already added')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(applyMcpImport).toHaveBeenCalledWith('codex'));
    // list refreshes after apply
    expect(fetchMcpServers).toHaveBeenCalledTimes(2);
  });

  it('switches advertise mode from the expanded editor', async () => {
    vi.mocked(updateMcpServer).mockResolvedValue(makeServer({ advertise: 'full' }));
    render(<McpServersSettingsSection />);
    await screen.findByText('bridgememory');
    await userEvent.click(screen.getByRole('button', { name: /manage bridgememory/i }));
    await userEvent.click(
      screen.getByRole('switch', { name: /advertise tools directly/i }),
    );
    expect(updateMcpServer).toHaveBeenCalledWith('bridgememory', { advertise: 'full' });
  });

  it('deletes a server after dialog confirmation', async () => {
    vi.mocked(deleteMcpServer).mockResolvedValue();
    render(<McpServersSettingsSection />);
    await screen.findByText('bridgememory');
    await userEvent.click(screen.getByRole('button', { name: /manage bridgememory/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove bridgememory/i }));
    // dialog confirm
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(deleteMcpServer).toHaveBeenCalledWith('bridgememory'));
  });

  it('renders the empty state with import hints when the store is empty', async () => {
    vi.mocked(fetchMcpServers).mockResolvedValue([]);
    render(<McpServersSettingsSection />);
    expect(await screen.findByText(/no mcp servers yet/i)).toBeInTheDocument();
  });
});
