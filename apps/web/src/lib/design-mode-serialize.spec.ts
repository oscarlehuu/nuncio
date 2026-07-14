import { describe, expect, it } from 'vitest';
import {
  DESIGN_MODE_MAX_COMPONENTS,
  buildDesignModeSteerMessage,
  designModeElementLabel,
  insertComponentChipAtCaret,
  type DesignModeComponent,
} from './design-mode-serialize';

function component(overrides: Partial<DesignModeComponent> = {}): Omit<DesignModeComponent, 'index' | 'label'> {
  return {
    tag: 'button',
    id: 'btn',
    className: 'cta',
    xpath: '/html/body/button[1]',
    cssPath: 'button#btn',
    outerHTML: '<button id="btn">Save</button>',
    styles: { fontSize: '14px' },
    bbox: { x: 10, y: 20, width: 80, height: 32 },
    ...overrides,
  };
}

describe('design-mode-serialize', () => {
  it('labels picks with accessible name before obfuscated classes', () => {
    expect(designModeElementLabel({ tag: 'div', id: 'HomeSurface', className: '' })).toBe('HomeSurface');
    expect(
      designModeElementLabel({
        tag: 'textarea',
        id: '',
        className: '',
        ariaLabel: 'Ask Nuncio',
      }),
    ).toBe('Ask Nuncio');
    expect(
      designModeElementLabel({
        tag: 'input',
        id: '',
        className: 'RNNXgb',
        placeholder: 'Search',
      }),
    ).toBe('Search');
    expect(designModeElementLabel({ tag: 'div', id: '', className: 'RNNXgb' })).toBe('div');
    expect(designModeElementLabel({ tag: 'button', id: 'save', className: 'cta' })).toBe('button#save');
  });

  it('inserts a readable element chip at the caret', () => {
    const next = insertComponentChipAtCaret('move ', 5, component({ id: 'save', className: 'cta' }));
    expect(next.text).toBe('move [button#save] ');
    expect(next.components[0]?.label).toBe('button#save');
  });

  it('disambiguates duplicate labels with a short index suffix', () => {
    const first = insertComponentChipAtCaret('', 0, component({ id: '', className: '', tag: 'div' }));
    const second = insertComponentChipAtCaret(
      first.text,
      first.caret,
      component({ id: '', className: '', tag: 'div' }),
      first.components,
    );
    expect(second.text).toContain('[div]');
    expect(second.text).toContain('[div·2]');
  });

  it('builds a steer message with readable chips and a visible identity appendix', () => {
    const first = insertComponentChipAtCaret('move ', 5, component({ id: 'btn-1', cssPath: 'button#btn-1' }));
    const second = insertComponentChipAtCaret(
      `${first.text}to where `,
      `${first.text}to where `.length,
      component({ id: 'btn-2', cssPath: 'button#btn-2', cropPngBase64: 'aaa' }),
      first.components,
    );

    const result = buildDesignModeSteerMessage(second.text, second.components);
    expect(result.message).toContain('move [button#btn-1] to where [button#btn-2]');
    expect(result.attachments).toEqual([{ kind: 'image', mimeType: 'image/png', data: 'aaa' }]);
  });

  it('caps the number of components per send', () => {
    expect(DESIGN_MODE_MAX_COMPONENTS).toBe(8);
    let text = '';
    let caret = 0;
    let components: DesignModeComponent[] = [];
    let capped = false;
    for (let i = 0; i < DESIGN_MODE_MAX_COMPONENTS + 1; i += 1) {
      const next = insertComponentChipAtCaret(text, caret, component({ id: `b${i}` }), components);
      text = next.text;
      caret = next.caret;
      components = next.components;
      capped = next.capped;
    }
    expect(components).toHaveLength(DESIGN_MODE_MAX_COMPONENTS);
    expect(capped).toBe(true);
  });

  it('refuses an empty steer (no text and no chips)', () => {
    expect(() => buildDesignModeSteerMessage('   ', [])).toThrow(/empty/i);
  });
});
