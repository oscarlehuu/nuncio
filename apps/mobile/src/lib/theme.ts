/**
 * Nativewind semantic colors for the mobile app.
 *
 * Nuncio is intentionally dark-first; the single palette keeps the RNR
 * primitives aligned with the shared core tokens without introducing a light
 * theme.
 */
export const NAV_THEME = {
  dark: {
    background: '#121314',
    foreground: '#eff0f1',
    card: '#18191c',
    'card-foreground': '#eff0f1',
    popover: '#1b1c1e',
    'popover-foreground': '#eff0f1',
    primary: '#e3e4e6',
    'primary-foreground': '#161719',
    secondary: '#242528',
    'secondary-foreground': '#eff0f1',
    muted: '#222325',
    'muted-foreground': '#83868b',
    accent: '#252629',
    'accent-foreground': '#eff0f1',
    destructive: '#f5605b',
    // Hairline edges — foreground at low alpha, not a hard white line.
    border: 'rgba(240, 240, 240, 0.08)',
    input: 'rgba(240, 240, 240, 0.14)',
    ring: '#606369',
    radius: '0.625rem',
  },
} as const;
