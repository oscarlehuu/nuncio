const { dark, radius } = require('./tailwind-colors');

/**
 * The mobile app is dark-first like the phone PWA it replaces, so the dark
 * palette IS the semantic palette for now; a light theme can layer on later
 * via NativeWind color schemes.
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: dark.background,
        foreground: dark.foreground,
        card: { DEFAULT: dark.card, foreground: dark['card-foreground'] },
        popover: { DEFAULT: dark.popover, foreground: dark['popover-foreground'] },
        primary: { DEFAULT: dark.primary, foreground: dark['primary-foreground'] },
        secondary: { DEFAULT: dark.secondary, foreground: dark['secondary-foreground'] },
        muted: { DEFAULT: dark.muted, foreground: dark['muted-foreground'] },
        accent: { DEFAULT: dark.accent, foreground: dark['accent-foreground'] },
        destructive: dark.destructive,
        border: dark.border,
        input: dark.input,
        ring: dark.ring,
      },
      borderRadius: {
        lg: radius,
      },
    },
  },
  plugins: [],
};
