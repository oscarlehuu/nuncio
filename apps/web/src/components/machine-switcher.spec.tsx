import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MachineSwitcher } from './machine-switcher';

vi.mock('../lib/hub-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/hub-api')>();
  return { ...actual, fetchHubMachines: vi.fn(), currentMachine: vi.fn(() => null) };
});

import { fetchHubMachines, currentMachine } from '../lib/hub-api';

const mockFetch = vi.mocked(fetchHubMachines);
const mockCurrent = vi.mocked(currentMachine);

const MACHINES = [
  { name: 'oscar-m5pro', dnsName: 'oscar-m5pro.ts.net', origin: 'http://oscar-m5pro.ts.net:3000', os: 'macOS', self: true },
  { name: 'macbook', dnsName: 'macbook.ts.net', origin: 'http://macbook.ts.net:3000', os: 'macOS', self: false },
];

describe('MachineSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrent.mockReturnValue(null);
  });

  it('renders nothing when hub mode is off', async () => {
    mockFetch.mockResolvedValue({ hubMode: false, machines: [] });
    const { container } = render(<MachineSwitcher />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('lists machines as origin-absolute /m/<name>/ links in hub mode', async () => {
    mockFetch.mockResolvedValue({ hubMode: true, machines: MACHINES });
    render(<MachineSwitcher />);

    const self = await screen.findByRole('link', { name: /oscar-m5pro/ });
    const other = screen.getByRole('link', { name: /macbook/ });
    expect(self).toHaveAttribute('href', '/m/oscar-m5pro/');
    expect(other).toHaveAttribute('href', '/m/macbook/');
    // At the hub root, the self machine is marked current.
    expect(self).toHaveAttribute('aria-current', 'page');
    expect(other).not.toHaveAttribute('aria-current');
  });

  it('marks the machine named in the base path as current', async () => {
    mockCurrent.mockReturnValue('macbook');
    mockFetch.mockResolvedValue({ hubMode: true, machines: MACHINES });
    render(<MachineSwitcher />);

    const other = await screen.findByRole('link', { name: /macbook/ });
    expect(other).toHaveAttribute('aria-current', 'page');
  });
});
