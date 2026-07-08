import { byteLength, truncateHeadBytes, truncateTailBytes } from '../../../src/orchestration/byte-truncate';

describe('byte-truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncateHeadBytes('hello', 100)).toBe('hello');
    expect(truncateTailBytes('hello', 100)).toBe('hello');
  });

  it('truncateHeadBytes keeps the head within budget on a clean boundary', () => {
    // Each emoji is 4 bytes; a 10-byte budget lands mid-character.
    const text = '😀😀😀';
    const out = truncateHeadBytes(text, 10);
    expect(byteLength(out)).toBeLessThanOrEqual(10);
    expect(out).not.toContain('�');
    expect(out).toBe('😀😀'); // 8 bytes, the third is dropped whole
  });

  it('truncateTailBytes keeps the tail within budget on a clean boundary', () => {
    const text = '😀😀😀';
    const out = truncateTailBytes(text, 10);
    expect(byteLength(out)).toBeLessThanOrEqual(10);
    expect(out).not.toContain('�');
    expect(out).toBe('😀😀');
  });

  it('never splits a multi-byte character at the budget edge (probe every offset)', () => {
    const text = 'a😀b€c𐍈d'; // mix of 1/2/3/4-byte characters
    for (let budget = 1; budget <= byteLength(text) + 2; budget += 1) {
      const head = truncateHeadBytes(text, budget);
      const tail = truncateTailBytes(text, budget);
      expect(head).not.toContain('�');
      expect(tail).not.toContain('�');
      expect(byteLength(head)).toBeLessThanOrEqual(budget);
      expect(byteLength(tail)).toBeLessThanOrEqual(budget);
    }
  });
});
