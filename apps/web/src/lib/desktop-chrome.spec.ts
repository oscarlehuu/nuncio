import { describe, it, expect, afterEach } from 'vitest';
import { applyDesktopChromeAttribute, isMacDesktopShell } from './desktop-chrome';

type NuncioWindow = Window & { nuncioDesktop?: { marker?: string; platform?: string } };

afterEach(() => {
  delete (window as NuncioWindow).nuncioDesktop;
  delete document.documentElement.dataset.desktopChrome;
});

describe('isMacDesktopShell', () => {
  it('is true inside the desktop shell on macOS', () => {
    (window as NuncioWindow).nuncioDesktop = { marker: 'desktop', platform: 'darwin' };
    expect(isMacDesktopShell()).toBe(true);
  });

  it('is false in a plain browser', () => {
    expect(isMacDesktopShell()).toBe(false);
  });

  it('is false inside the desktop shell on other platforms', () => {
    (window as NuncioWindow).nuncioDesktop = { marker: 'desktop', platform: 'win32' };
    expect(isMacDesktopShell()).toBe(false);
  });
});

describe('applyDesktopChromeAttribute', () => {
  it('stamps data-desktop-chrome="mac" on the root element in the mac shell', () => {
    (window as NuncioWindow).nuncioDesktop = { marker: 'desktop', platform: 'darwin' };
    applyDesktopChromeAttribute();
    expect(document.documentElement.dataset.desktopChrome).toBe('mac');
  });

  it('leaves the root element untouched outside the mac shell', () => {
    applyDesktopChromeAttribute();
    expect(document.documentElement.dataset.desktopChrome).toBeUndefined();
  });
});
