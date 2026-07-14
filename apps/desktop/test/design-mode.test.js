const { describe, expect, test } = require('bun:test');
const {
  DESIGN_MODE_OVERLAY_RESERVE_PX,
  designModeElementLabel,
  normalizeGuestPick,
  buildPickerInstallScript,
  buildPickerUninstallScript,
} = require('../src/design-mode');

describe('design-mode helpers', () => {
  test('reserves a slim React gap for the floating pill', () => {
    expect(DESIGN_MODE_OVERLAY_RESERVE_PX).toBeGreaterThanOrEqual(48);
  });

  test('labels prefer accessible names over obfuscated CSS classes', () => {
    expect(designModeElementLabel({ tag: 'input', placeholder: 'Search', className: 'RNNXgb' })).toBe(
      'Search',
    );
    expect(designModeElementLabel({ tag: 'div', className: 'RNNXgb' })).toBe('div');
  });

  test('normalizeGuestPick keeps identity fields and truncates oversized html', () => {
    const huge = `<div>${'x'.repeat(20_000)}</div>`;
    const pick = normalizeGuestPick({
      tag: 'BUTTON',
      id: 'save',
      className: 'cta primary',
      xpath: '/html/body/button',
      cssPath: 'button#save.cta',
      outerHTML: huge,
      styles: { fontSize: '14px' },
      bbox: { x: 10.2, y: 20.8, width: 100.4, height: 32.1 },
    });
    expect(pick.tag).toBe('button');
    expect(pick.label).toBe('button#save');
    expect(pick.outerHTML.length).toBeLessThan(huge.length);
  });

  test('picker install script reports picks and is re-entrant', () => {
    const script = buildPickerInstallScript();
    expect(script).toContain('__nuncioDesignModeBridge');
    expect(script).toContain('reportPick');
    expect(script).toContain('preventDefault');
    expect(script).toContain('__nuncio-design-mode-highlight');
  });

  test('picker uninstall clears handlers', () => {
    const script = buildPickerUninstallScript();
    expect(script).toContain('__nuncioDesignModeActive = false');
  });
});
