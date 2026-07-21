import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { AppearanceProvider } from './appearance-provider';
import { SettingsView } from './settings-view';
import { SettingsSidebarPanel } from './settings-sidebar-panel';
import type { Setting } from '../lib/settings-api';
import {
  parseSettingsSection,
  type SettingsSectionId,
} from '../lib/settings-sections';

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

// The Mobile section fires listDevices() on mount; stub the device API so rendering
// it (via nav/deep-link/search tests) doesn't hit a real fetch and leak an async
// rejection past the synchronous assertions.
vi.mock('../lib/devices-api', () => ({
  startPairing: vi.fn().mockResolvedValue({ code: '', expiresAt: 0, urls: [], hints: [] }),
  listDevices: vi.fn().mockResolvedValue([]),
  revokeDevice: vi.fn(),
}));

vi.mock('../lib/subscription-bridge-api', () => ({
  fetchSubscriptionBridgeStatus: vi.fn().mockResolvedValue({
    enabled: false,
    online: false,
    mode: 'external',
    baseUrl: 'http://127.0.0.1:8317',
    hasApiKey: false,
    accounts: { claude: false, codex: false },
    modelCount: 0,
    error: null,
    managed: { running: false, pid: null, configPath: null, port: null },
    loginHints: { claude: 'cli --claude-login', codex: 'cli --codex-login' },
  }),
  refreshSubscriptionBridgeStatus: vi.fn().mockResolvedValue({
    enabled: true,
    online: true,
    mode: 'external',
    baseUrl: 'http://127.0.0.1:8317',
    hasApiKey: true,
    accounts: { claude: true, codex: true },
    modelCount: 2,
    error: null,
    managed: { running: false, pid: null, configPath: null, port: null },
    loginHints: { claude: 'cli --claude-login', codex: 'cli --codex-login' },
  }),
  discoverSubscriptionBridgeInstalls: vi.fn().mockResolvedValue([]),
  adoptExternalSubscriptionBridge: vi.fn(),
  migrateManagedSubscriptionBridge: vi.fn(),
  initManagedSubscriptionBridge: vi.fn(),
  startManagedSubscriptionBridge: vi.fn(),
  stopManagedSubscriptionBridge: vi.fn(),
  fetchSubscriptionBridgeClaudeCodeEnv: vi.fn(),
  subscriptionBridgeSubtitle: vi.fn(
    (status: { enabled?: boolean; online?: boolean } | null) =>
      status?.online
        ? 'Online · External · Claude + Codex'
        : 'Disabled · External · enable to route Claude ↔ Codex subscriptions',
  ),
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

/** Mirrors App: settings sidebar + content pane sharing section/search state. */
function SettingsHarness({
  settings,
  onUpdate = vi.fn(),
  onClear = vi.fn(),
  onBack = vi.fn(),
  initialSection,
}: {
  settings: Setting[];
  onUpdate?: (key: string, value: string) => Promise<void>;
  onClear?: (key: string) => Promise<void>;
  onBack?: () => void;
  initialSection?: SettingsSectionId;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    () => initialSection ?? parseSettingsSection(window.location.search),
  );
  const [searchQuery, setSearchQuery] = useState('');
  return (
    <div className="flex h-full">
      <aside className="w-60 border-r border-border bg-sidebar">
        <SettingsSidebarPanel
          activeSection={activeSection}
          searchQuery={searchQuery}
          onSectionChange={(section) => {
            setActiveSection(section);
            setSearchQuery('');
          }}
          onSearchChange={setSearchQuery}
          onBack={onBack}
        />
      </aside>
      <SettingsView
        settings={settings}
        onUpdate={onUpdate}
        onClear={onClear}
        activeSection={activeSection}
        searchQuery={searchQuery}
      />
    </div>
  );
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
      <SettingsHarness settings={settings} />,
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Providers' })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: 'Subscription bridge' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: 'Tool updates' })).not.toBeInTheDocument();
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
      <SettingsHarness settings={settings} />,
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
      <SettingsHarness settings={settings} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    // Appearance content is no longer rendered once Providers is active.
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('marks the active section navigation entry as current', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(nav).getByRole('button', { name: 'Providers' }));
    const providersButton = within(nav).getByRole('button', { name: 'Providers' });
    const appearanceButton = within(nav).getByRole('button', { name: 'Appearance' });
    expect(providersButton).toHaveAttribute('aria-current', 'page');
    expect(providersButton.className).toContain('bg-sidebar-accent');
    expect(appearanceButton).not.toHaveAttribute('aria-current', 'page');
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
      <SettingsHarness settings={settings} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'cursor');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    // GitHub is in another section and does not match the query.
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
  });

  it('shows an empty state when the search matches nothing', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'zzzznomatch');
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument();
  });

  it('finds the Remote access section when searching for Tailscale trust settings', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'tailscale');
    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeInTheDocument();
  });

  it('surfaces the default subagent models section via search', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
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
      <SettingsHarness settings={[]} />,
    );
    // The pairing pane is shown immediately, not the default Appearance pane.
    expect(screen.getByRole('heading', { name: 'Remote access' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('opens the Mobile pane when deep-linked via ?section=mobile', () => {
    window.history.replaceState(null, '', '/settings?section=mobile');
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    // The phone-pairing pane is shown immediately, not the default Appearance pane.
    expect(screen.getByRole('heading', { name: 'Mobile' })).toBeInTheDocument();
    expect(screen.getByText('Connect your phone')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('finds the Mobile section when searching for phone pairing', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    await userEvent.type(search, 'phone');
    expect(screen.getByRole('heading', { name: 'Mobile' })).toBeInTheDocument();
  });

  it('opens Crew profiles directly from the composer setup deep-link', async () => {
    window.history.replaceState(null, '', '/settings?section=crew-profiles');
    renderWithTheme(<SettingsHarness settings={[]} />);
    expect(screen.getByRole('heading', { name: 'Crew profiles' })).toBeInTheDocument();
  });

  it('falls back to Appearance when the ?section value is unknown', () => {
    window.history.replaceState(null, '', '/settings?section=not-a-real-section');
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('renders provider rows with brand names in the Providers section', async () => {
    const settings = [
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsHarness settings={settings} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
  });

  it('shows Subscription bridge and Tool updates as sections under Providers', async () => {
    const settings = [
      makeSetting({
        key: 'NUNCIO_CLIPROXY_ENABLED',
        label: 'Enable Subscription bridge',
        category: 'provider',
        providerId: 'subscription-bridge',
        type: 'boolean',
        hasValue: true,
        source: 'default',
        value: '0',
      }),
      makeSetting({
        key: 'NUNCIO_CLIPROXY_BASE_URL',
        label: 'CLIProxyAPI base URL',
        category: 'provider',
        providerId: 'subscription-bridge',
        type: 'string',
        hasValue: true,
        source: 'default',
        value: 'http://127.0.0.1:8317',
      }),
      makeSetting({ key: 'A', label: 'Cursor API Key', category: 'provider', providerId: 'cursor' }),
    ];
    renderWithTheme(
      <SettingsHarness settings={settings} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Subscription bridge' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tool updates' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check Subscription bridge health/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy Claude Code env/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Initialize managed/i })).toBeInTheDocument();
    expect(screen.getByText(/Pi and Codex CLI updates/i)).toBeInTheDocument();
  });

  it('deep-links legacy subscription-bridge and tool-updates section ids to Providers', () => {
    window.history.replaceState(null, '', '/settings?section=subscription-bridge');
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    expect(screen.getByRole('heading', { name: 'Subscription bridge' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tool updates' })).toBeInTheDocument();
  });

  it('shows Claude and Devin rows with permission mode selects', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const settings = [
      makeSetting({
        key: 'NUNCIO_CLAUDE_PERMISSION_MODE',
        label: 'Claude permission mode',
        category: 'provider',
        providerId: 'claude',
        type: 'string',
        hasValue: true,
        source: 'default',
        value: 'bypassPermissions',
        options: [
          { value: 'bypassPermissions', label: 'Bypass' },
          { value: 'acceptEdits', label: 'Accept edits' },
          { value: 'default', label: 'Ask every time' },
          { value: 'plan', label: 'Plan only' },
        ],
      }),
      makeSetting({
        key: 'NUNCIO_DEVIN_PERMISSION_MODE',
        label: 'Devin permission mode',
        category: 'provider',
        providerId: 'devin',
        type: 'string',
        hasValue: true,
        source: 'default',
        value: 'bypass',
        options: [
          { value: 'bypass', label: 'Bypass Permissions' },
          { value: 'accept-edits', label: 'Code' },
          { value: 'ask', label: 'Ask' },
          { value: 'plan', label: 'Plan' },
        ],
      }),
    ];
    renderWithTheme(
      <SettingsHarness settings={settings} onUpdate={onUpdate} />,
    );
    await goToSection('Providers');
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Devin')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Manage Claude' }));
    expect(screen.getByText('Claude permission mode')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept edits' }));
    expect(onUpdate).toHaveBeenCalledWith('NUNCIO_CLAUDE_PERMISSION_MODE', 'acceptEdits');

    await userEvent.click(screen.getByRole('button', { name: 'Manage Devin' }));
    expect(screen.getByText('Devin permission mode')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(onUpdate).toHaveBeenCalledWith('NUNCIO_DEVIN_PERMISSION_MODE', 'accept-edits');
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
      <SettingsHarness settings={settings} onUpdate={onUpdate} />,
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
      <SettingsHarness settings={settings} />,
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
      <SettingsHarness settings={settings} />,
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
    renderWithTheme(<SettingsHarness settings={settings} />);
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
      <SettingsHarness settings={settings} />,
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
      <SettingsHarness settings={settings} onUpdate={onUpdate} />,
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
    renderWithTheme(<SettingsHarness settings={settings} onClear={onClear} />);
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
    renderWithTheme(<SettingsHarness settings={settings} />);
    await goToSection('Providers');

    const manageBtn = screen.getByRole('button', { name: /manage cursor/i });
    await userEvent.click(manageBtn);

    expect(screen.getByText('env')).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    renderWithTheme(
      <SettingsHarness settings={[]} onBack={onBack} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders the Appearance section with theme, font size, and density controls', () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
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
      <SettingsHarness settings={[]} />,
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
      <SettingsHarness settings={[]} />,
    );
    const slider = screen.getByLabelText('Chat font size');
    fireEvent.change(slider, { target: { value: '1.2' } });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--chat-font-scale')).toBe('1.2');
    });
  });

  it('clicking a density option toggles the pressed state', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
    );
    const compactBtn = screen.getByRole('button', { name: 'Compact' });
    await userEvent.click(compactBtn);
    expect(compactBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting a theme card calls setTheme (reflected as checked)', async () => {
    renderWithTheme(
      <SettingsHarness settings={[]} />,
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
      <SettingsHarness settings={settings} onUpdate={onUpdate} />,
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
      <SettingsHarness settings={settings} onUpdate={onUpdate} />,
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
      <SettingsHarness settings={settings} />,
    );
    await goToSection('Advanced');

    expect(screen.getByRole('switch', { name: 'CLI update notifications' })).toBeInTheDocument();
  });
});
