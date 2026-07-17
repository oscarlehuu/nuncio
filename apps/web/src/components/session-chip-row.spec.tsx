import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChipDto } from '../lib/api';
import { SessionChipRow } from './session-chip-row';

const { fetchSessionChips, actChip, dismissChip } = vi.hoisted(() => ({
  fetchSessionChips: vi.fn(),
  actChip: vi.fn(),
  dismissChip: vi.fn(),
}));

vi.mock('../lib/api', () => ({ fetchSessionChips, actChip, dismissChip }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function makeChip(partial: Partial<ChipDto> = {}): ChipDto {
  return {
    id: partial.id ?? 'chip-1',
    ref: partial.ref ?? 'abc12345',
    sourceSessionId: partial.sourceSessionId ?? 'src',
    title: partial.title ?? 'Remove the dead retry path in relay.ts',
    tldr: partial.tldr ?? 'The legacy retry branch is unreachable.',
    prompt: partial.prompt ?? 'Delete the unreachable branch and update the test.',
    cwd: null,
    projectPath: null,
    status: 'proposed',
    dismissedBy: null,
    dismissReason: null,
    childSessionId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('SessionChipRow', () => {
  beforeEach(() => {
    fetchSessionChips.mockReset();
    actChip.mockReset();
    dismissChip.mockReset();
  });

  it('renders nothing when there are no proposed chips', async () => {
    fetchSessionChips.mockResolvedValue([]);
    render(<SessionChipRow sessionId="src" onCreated={vi.fn()} />);
    await waitFor(() => expect(fetchSessionChips).toHaveBeenCalled());
    expect(screen.queryByTestId('session-chip-row')).not.toBeInTheDocument();
  });

  it('spins a chip into a child session and reports the child id', async () => {
    const chip = makeChip();
    fetchSessionChips.mockResolvedValue([chip]);
    actChip.mockResolvedValue({ chip: { ...chip, status: 'acted' }, session: { id: 'child-9' } });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<SessionChipRow sessionId="src" onCreated={onCreated} />);

    const create = await screen.findByTestId('session-chip-create');
    expect(create).toHaveTextContent(chip.title);
    await user.click(create);
    await waitFor(() => expect(actChip).toHaveBeenCalledWith('chip-1'));
    expect(onCreated).toHaveBeenCalledWith('child-9');
  });

  it('dismisses a chip via the × control', async () => {
    const chip = makeChip();
    fetchSessionChips.mockResolvedValue([chip]);
    dismissChip.mockResolvedValue({ ...chip, status: 'dismissed' });
    const user = userEvent.setup();
    render(<SessionChipRow sessionId="src" onCreated={vi.fn()} />);

    const dismiss = await screen.findByTestId('session-chip-dismiss');
    await user.click(dismiss);
    await waitFor(() => expect(dismissChip).toHaveBeenCalledWith('chip-1'));
  });

  it('refetches when a spawn-task event bumps the refresh key', async () => {
    fetchSessionChips.mockResolvedValue([]);
    const { rerender } = render(<SessionChipRow sessionId="src" refreshKey={0} onCreated={vi.fn()} />);
    await waitFor(() => expect(fetchSessionChips).toHaveBeenCalledTimes(1));
    rerender(<SessionChipRow sessionId="src" refreshKey={1} onCreated={vi.fn()} />);
    await waitFor(() => expect(fetchSessionChips).toHaveBeenCalledTimes(2));
  });
});
