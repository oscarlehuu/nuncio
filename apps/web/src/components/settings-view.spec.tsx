import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { SettingsView } from './settings-view';
import type { Setting } from '../lib/settings-api';

// Mock the forge status API
vi.mock('../lib/forge-status-api', () => ({
  fetchForgeStatus: vi.fn().mockResolvedValue([
    { id: 'github', name: 'GitHub', connected: true, method: 'cli', login: 'octocat' },
    { id: 'gitlab', name: 'GitLab', connected: false, method: null, login: null }
  ]),
}));

function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

function makeSetting(over: Partial<Setting> = {}): Setting {
  return {
    key: 'CURSOR_API_KEY',
    category: 'provider',
    providerId: 'cursor',
    type: 'secret',
    label: 'Cursor API Key',
    description: 'Mint at cursor.com/dashboard',
    hasValue: false,
    source: null,
    value: null,
    readOnly: false,
    ...over,
  };
}

describe('SettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Providers, Source Control, and General section headers', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
      makeSetting({ key: 'B', label: 'GitHub token', category: 'provider', providerId: 'github' }),
      makeSetting({ key: 'C', label: 'Alpha', category: 'general' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.getByText('Source Control')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('renders provider rows with brand names', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
      makeSetting({ key: 'B', label: 'GitHub token', category: 'provider', providerId: 'github' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('shows connection status in subtitles', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'GitHub token', category: 'provider', providerId: 'github' }),
      makeSetting({ key: 'B', label: 'GitLab token', category: 'provider', providerId: 'gitlab' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Connected as octocat · via gh CLI')).toBeInTheDocument();
      expect(screen.getByText('Connect GitLab for merge requests and pipelines')).toBeInTheDocument();
    });
  });

  it('reveals setting input when clicking Manage/Connect', async () => {
    const settings = [
      makeSetting({ key: 'CURSOR_API_KEY', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    
    expect(screen.queryByPlaceholderText(/enter new value/i)).not.toBeInTheDocument();
    
    const manageBtn = screen.getByRole('button', { name: /connect cursor/i });
    await userEvent.click(manageBtn);
    
    expect(screen.getByPlaceholderText(/enter new value/i)).toBeInTheDocument();
  });

  it('shows the masked value for a set secret after expanded (never raw)', async () => {
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
        hasValue: true,
        source: 'db',
        value: '••••12ab'
      })
    ];
    renderWithTheme(
      <SettingsView
        settings={settings}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /manage cursor/i });
    await userEvent.click(manageBtn);
    
    expect(screen.getByText('••••12ab')).toBeInTheDocument();
  });

  it('shows "Not set" for an unset secret after expanded', async () => {
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
        hasValue: false,
        value: null
      })
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /connect cursor/i });
    await userEvent.click(manageBtn);
    
    expect(screen.getByText(/not set/i)).toBeInTheDocument();
  });

  it('calls onUpdate with key + input value when Save is clicked after expanded', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
      })
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /connect cursor/i });
    await userEvent.click(manageBtn);
    
    const input = screen.getByPlaceholderText(/enter new value/i);
    await userEvent.type(input, 'sk-new-secret');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onUpdate).toHaveBeenCalledWith('CURSOR_API_KEY', 'sk-new-secret');
  });

  it('calls onClear with the key when Clear is clicked after expanded', async () => {
    const onClear = vi.fn().mockResolvedValue(undefined);
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
        hasValue: true,
        source: 'db',
        value: '••••12ab'
      })
    ];
    renderWithTheme(
      <SettingsView
        settings={settings}
        onUpdate={vi.fn()}
        onClear={onClear}
        onBack={vi.fn()}
      />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /manage cursor/i });
    await userEvent.click(manageBtn);
    
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onClear).toHaveBeenCalledWith('CURSOR_API_KEY');
  });

  it('shows a source badge (env/db/default)', async () => {
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
        hasValue: true,
        source: 'env',
        value: 'x'
      })
    ];
    renderWithTheme(
      <SettingsView
        settings={settings}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /manage cursor/i });
    await userEvent.click(manageBtn);
    
    expect(screen.getByText('env')).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={onBack} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows a saving indicator while an update is in flight', async () => {
    let resolveUpdate: () => void = () => {};
    const onUpdate = vi.fn(
      () => new Promise<void>((resolve) => { resolveUpdate = resolve; }),
    );
    const settings = [
      makeSetting({
        key: 'CURSOR_API_KEY',
        label: 'Cursor API Key',
        category: 'provider',
        providerId: 'cursor',
      })
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    
    const manageBtn = screen.getByRole('button', { name: /connect cursor/i });
    await userEvent.click(manageBtn);
    
    await userEvent.type(screen.getByPlaceholderText(/enter new value/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/saving/i)).toBeInTheDocument());
    resolveUpdate();
  });
});
