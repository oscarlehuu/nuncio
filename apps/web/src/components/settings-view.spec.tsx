import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { SettingsView } from './settings-view';
import type { Setting } from '../lib/settings-api';

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
  it('renders Providers and General section headers', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'A', category: 'provider' }),
      makeSetting({ key: 'B', label: 'B', category: 'general' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('groups settings by category', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Alpha', category: 'general' }),
      makeSetting({ key: 'B', label: 'Beta', category: 'provider' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('shows the masked value for a set secret (never raw)', () => {
    renderWithTheme(
      <SettingsView
        settings={[makeSetting({ hasValue: true, source: 'db', value: '••••12ab' })]}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('••••12ab')).toBeInTheDocument();
  });

  it('shows "Not set" for an unset secret', () => {
    renderWithTheme(
      <SettingsView settings={[makeSetting()]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText(/not set/i)).toBeInTheDocument();
  });

  it('shows the raw value for a non-secret (path)', () => {
    renderWithTheme(
      <SettingsView
        settings={[
          makeSetting({
            key: 'NUNCIO_PROJECT_ROOTS',
            label: 'Project roots',
            type: 'path',
            hasValue: true,
            source: 'env',
            value: '~/code',
          }),
        ]}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('~/code')).toBeInTheDocument();
  });

  it('calls onUpdate with key + input value when Save is clicked', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(
      <SettingsView settings={[makeSetting()]} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const input = screen.getByPlaceholderText(/enter new value/i);
    await userEvent.type(input, 'sk-new-secret');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onUpdate).toHaveBeenCalledWith('CURSOR_API_KEY', 'sk-new-secret');
  });

  it('calls onClear with the key when Clear is clicked', async () => {
    const onClear = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(
      <SettingsView
        settings={[makeSetting({ hasValue: true, source: 'db', value: '••••12ab' })]}
        onUpdate={vi.fn()}
        onClear={onClear}
        onBack={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onClear).toHaveBeenCalledWith('CURSOR_API_KEY');
  });

  it('does not render Save/Clear controls for a readOnly setting', () => {
    renderWithTheme(
      <SettingsView
        settings={[makeSetting({ readOnly: true, hasValue: true, source: 'env', value: '/custom/pi' })]}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    expect(screen.getByText('/custom/pi')).toBeInTheDocument();
  });

  it('shows a source badge (env/db/default)', () => {
    renderWithTheme(
      <SettingsView
        settings={[makeSetting({ hasValue: true, source: 'env', value: 'x' })]}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    // Exact match — the footer note contains "environment" which would also match /env/i.
    expect(screen.getByText('env')).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    renderWithTheme(
      <SettingsView settings={[makeSetting()]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={onBack} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows a saving indicator while an update is in flight', async () => {
    let resolveUpdate: () => void = () => {};
    const onUpdate = vi.fn(
      () => new Promise<void>((resolve) => { resolveUpdate = resolve; }),
    );
    renderWithTheme(
      <SettingsView settings={[makeSetting()]} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText(/enter new value/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/saving/i)).toBeInTheDocument());
    resolveUpdate();
  });
});
