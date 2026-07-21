import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { AppearanceProvider } from './appearance-provider';
import { SettingsView } from './settings-view';
import type { Setting } from '../lib/settings-api';

// Mock the forge status API
vi.mock('../lib/forge-status-api', () => ({
  fetchForgeStatus: vi.fn().mockResolvedValue([
    { id: 'github', name: 'GitHub', connected: true, method: 'cli', login: 'octocat' },
    { id: 'gitlab', name: 'GitLab', connected: false, method: null, login: null }
  ]),
}));

vi.mock('../lib/provider-updates-api', () => ({
  fetchProviderUpdates: vi.fn().mockResolvedValue({
    enabled: true,
    notificationsEnabled: true,
    providers: [],
  }),
  updateProviderTool: vi.fn(),
}));

function renderWithTheme(ui: ReactElement) {
  return render(
    <ThemeProvider defaultTheme="light">
      <AppearanceProvider>{ui}</AppearanceProvider>
    </ThemeProvider>,
  );
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

/** Click a left-sidebar section navigation entry. */
async function goToSection(name: string) {
  const nav = screen.getByRole('navigation', { name: /settings sections/i });
  await userEvent.click(within(nav).getByRole('button', { name }));
}

describe('SettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Reset any deep-link section query left by a prior test.
    window.history.replaceState(null, '', '/settings');
  });

  it('renders a left section navigation sidebar with every section', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
      makeSetting({ key: 'B', label: 'GitHub token', category: 'provider', providerId: 'github' }),
      makeSetting({ key: 'C', label: 'Alpha', category: 'general', providerId: undefined }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Providers' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Usage' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Source control' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'MCP & Tools' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Crew profiles' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Mobile' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Remote access' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'General' })).toBeInTheDocument();
  });

  it('defaults to the Appearance section and hides other sections until selected', () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    // Provider content lives in a different section, not shown by default.
    expect(screen.queryByText('Cursor')).not.toBeInTheDocument();
  });

  it('selecting a section swaps the visible content pane', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    // Appearance content is no longer rendered once Providers is active.
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('marks the active section navigation entry as current', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(nav).getByRole('button', { name: 'Providers' }));
    const providersButton = within(nav).getByRole('button', { name: 'Providers' });
    const appearanceButton = within(nav).getByRole('button', { name: 'Appearance' });
    expect(providersButton).toHaveAttribute('aria-current', 'page');
    expect(providersButton.className).toContain('bg-primary/10');
    expect(appearanceButton).not.toHaveAttribute('aria-current', 'page');
    expect(appearanceButton).toHaveClass('border-transparent');
  });

  it('filters rows across sections with the search field', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
      makeSetting({
        key: 'B',
        label: 'GitHub token',
        description: 'Personal access token for source control',
        category: 'provider',
        providerId: 'github',
      }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'cursor');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    // GitHub is in another section and does not match the query.
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
  });

  it('shows an empty state when the search matches nothing', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'zzzznomatch');
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument();
  });

  it('finds the Remote access section when searching for Tailscale trust settings', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'tailscale');
    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeInTheDocument();
  });

  it('surfaces the default subagent models section via search', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    // Query by the section's own title — the raw NUNCIO_SUBAGENT_MODELS row is
    // replaced by the custom picker section, so search must still reach it.
    await userEvent.type(search, 'default subagent models');
    expect(await screen.findByText('Default subagent models')).toBeInTheDocument();
  });

  it('opens the Remote access pane when deep-linked via ?section=remote-access', () => {
    window.history.replaceState(null, '', '/settings?section=remote-access');
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    // The pairing pane is shown immediately, not the default Appearance pane.
    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('opens the Mobile pane when deep-linked via ?section=mobile', () => {
    window.history.replaceState(null, '', '/settings?section=mobile');
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    // The phone-pairing pane is shown immediately, not the default Appearance pane.
    expect(screen.getByRole('heading', { name: 'Mobile' })).toBeInTheDocument();
    expect(screen.getByText('Connect your phone')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('finds the Mobile section when searching for phone pairing', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'phone');
    expect(screen.getByRole('heading', { name: 'Mobile' })).toBeInTheDocument();
  });

  it('opens Crew profiles directly from the composer setup deep-link', async () => {
    window.history.replaceState(null, '', '/settings?section=crew-profiles');
    renderWithTheme(<SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Crew profiles' })).toBeInTheDocument();
  });

  it('falls back to Appearance when the ?section value is unknown', () => {
    window.history.replaceState(null, '', '/settings?section=not-a-real-section');
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('renders provider rows with brand names in the Providers section', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
  });

  it('renders MCP & Tools settings and updates the default browser option', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const settings = [
      makeSetting({
        key: 'NUNCIO_BROWSER_DEFAULT_TARGET',
        category: 'tools',
        providerId: undefined,
        type: 'string',
        label: 'Default browser',
        description: 'Browser target used when tools do not specify one',
        hasValue: true,
        source: 'default',
        value: 'auto',
        options: [
          { value: 'auto', label: 'Auto', description: 'Prefer in-app, then external' },
          { value: 'in_app', label: 'In-app', description: 'Require the desktop browser' },
          { value: 'external', label: 'External CDP', description: 'Use the managed Chrome browser' },
        ],
      }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );

    await goToSection('MCP & Tools');

    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByText('Default browser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'External CDP' }));

    expect(onUpdate).toHaveBeenCalledWith('NUNCIO_BROWSER_DEFAULT_TARGET', 'external');
  });

  it('shows connection status in subtitles in the Source control section', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'GitHub token', category: 'provider', providerId: 'github' }),
      makeSetting({ key: 'B', label: 'GitLab token', category: 'provider', providerId: 'gitlab' }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await goToSection('Source control');
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
    await goToSection('Providers');

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
    await goToSection('Providers');

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
    await goToSection('Providers');

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
    await goToSection('Providers');

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
    await goToSection('Providers');

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
    await goToSection('Providers');

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

  it('renders the Appearance section with theme, font size, and density controls', () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByLabelText('Chat font size')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByLabelText('Interface font size')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Reduce motion' })).toBeInTheDocument();
  });

  it('"Reduce motion: On" force-stills motion (label contract, not raw axis)', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const reduce = screen.getByRole('group', { name: 'Reduce motion' });
    // Selecting the option that reduces motion must reach the force-still state.
    await userEvent.click(within(reduce).getByRole('button', { name: 'On' }));
    expect(document.documentElement.getAttribute('data-motion')).toBe('off');
    // And "Off" (do not reduce) keeps motion running.
    await userEvent.click(within(reduce).getByRole('button', { name: 'Off' }));
    expect(document.documentElement.getAttribute('data-motion')).toBe('on');
  });




  it('moving the font size slider updates the applied --chat-font-scale', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const slider = screen.getByLabelText('Chat font size');
    fireEvent.change(slider, { target: { value: '1.2' } });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--chat-font-scale')).toBe('1.2');
    });
  });

  it('clicking a density option toggles the pressed state', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const compactBtn = screen.getByRole('button', { name: 'Compact' });
    await userEvent.click(compactBtn);
    expect(compactBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting a theme card calls setTheme (reflected as checked)', async () => {
    renderWithTheme(
      <SettingsView settings={[]} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    const themeGroup = screen.getByRole('radiogroup', { name: 'Theme' });
    const darkCard = within(themeGroup).getByRole('radio', { name: 'Dark' });
    await userEvent.click(darkCard);
    expect(darkCard).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
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
    await goToSection('Providers');

    const manageBtn = screen.getByRole('button', { name: /connect cursor/i });
    await userEvent.click(manageBtn);

    await userEvent.type(screen.getByPlaceholderText(/enter new value/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/saving/i)).toBeInTheDocument());
    resolveUpdate();
  });

  it('renders a boolean general setting as a switch and toggles it on', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const settings = [
      makeSetting({
        key: 'NUNCIO_TELEMETRY',
        category: 'general',
        providerId: undefined,
        type: 'boolean',
        label: 'Telemetry',
        description: 'Send anonymous usage stats',
        hasValue: true,
        value: '0',
      }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={onUpdate} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await goToSection('General');

    const toggle = screen.getByRole('switch', { name: 'Telemetry' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('NUNCIO_TELEMETRY', '1'));
  });

  it('renders the global CLI update notification setting in Advanced', async () => {
    const settings = [
      makeSetting({
        key: 'NUNCIO_CLI_UPDATE_NOTIFICATIONS',
        category: 'advanced',
        providerId: undefined,
        type: 'boolean',
        label: 'CLI update notifications',
        description: 'Show toast notifications when Pi or Codex CLI updates are available.',
        hasValue: true,
        value: '1',
      }),
    ];
    renderWithTheme(
      <SettingsView settings={settings} onUpdate={vi.fn()} onClear={vi.fn()} onBack={vi.fn()} />,
    );
    await goToSection('Advanced');

    expect(screen.getByRole('switch', { name: 'CLI update notifications' })).toBeInTheDocument();
  });
});
