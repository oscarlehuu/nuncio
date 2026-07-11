import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewMembersPanel } from './crew-members-panel';
import type { CrewMemberDto } from '@nuncio/core/crew-api';

const member = (over: Partial<CrewMemberDto>): CrewMemberDto => ({
  id: 'm1', role: 'builder', label: 'Sol', provider: 'codex', model: 'sol', sessionId: 's1', status: 'active', ...over,
});

describe('CrewMembersPanel', () => {
  it('renders member status as a discrete labeled indicator, not appended to the metadata run-on', () => {
    const { container } = render(<CrewMembersPanel members={[member({ status: 'active' })]} />);
    const status = container.querySelector('[data-status="active"]');
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent(/active/i);
    // provider/model metadata renders, but the status token is no longer appended to that run-on
    expect(screen.getByText(/codex/)).toBeInTheDocument();
    expect(screen.queryByText(/· active$/i)).toBeNull();
  });
});
