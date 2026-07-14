import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  copySelectionInside,
  hasSelectionInside,
  selectionTextInside,
} from './auto-copy-selection';

function fakeSelection(over: Partial<Selection> & { text: string; collapsed?: boolean }): Selection {
  const { text, collapsed = false, ...rest } = over;
  return {
    isCollapsed: collapsed,
    toString: () => text,
    anchorNode: document.body,
    focusNode: document.body,
    ...rest,
  } as unknown as Selection;
}

describe('auto-copy-selection', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when selection is collapsed or empty', () => {
    const root = document.createElement('div');
    expect(selectionTextInside(root, fakeSelection({ text: '', collapsed: true }))).toBeNull();
    expect(selectionTextInside(root, fakeSelection({ text: '   ' }))).toBeNull();
    expect(selectionTextInside(null, fakeSelection({ text: 'hi' }))).toBeNull();
  });

  it('returns the text only when both ends live inside root', () => {
    const root = document.createElement('div');
    const inside = document.createElement('span');
    root.appendChild(inside);
    const outside = document.createElement('span');
    document.body.appendChild(root);
    document.body.appendChild(outside);

    expect(
      selectionTextInside(
        root,
        fakeSelection({ text: 'hello', anchorNode: inside, focusNode: inside }),
      ),
    ).toBe('hello');
    expect(
      selectionTextInside(
        root,
        fakeSelection({ text: 'hello', anchorNode: inside, focusNode: outside }),
      ),
    ).toBeNull();
    expect(hasSelectionInside(root)).toBe(false);
  });

  it('copies the in-root selection to the clipboard', async () => {
    const root = document.createElement('div');
    const inside = document.createElement('span');
    root.appendChild(inside);
    const copied = await copySelectionInside(
      root,
      fakeSelection({ text: 'paste me', anchorNode: inside, focusNode: inside }),
    );
    expect(copied).toBe('paste me');
    expect(writeText).toHaveBeenCalledWith('paste me');
  });

  it('no-ops when there is nothing to copy', async () => {
    const root = document.createElement('div');
    await expect(
      copySelectionInside(root, fakeSelection({ text: '', collapsed: true })),
    ).resolves.toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});
