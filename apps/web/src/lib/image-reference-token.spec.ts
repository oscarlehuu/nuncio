import { describe, it, expect } from 'vitest';
import { appendImageTokens, stripImageToken } from './image-reference-token';

describe('appendImageTokens', () => {
  it('returns the text unchanged when there are no labels', () => {
    expect(appendImageTokens('hello', [])).toBe('hello');
  });

  it('uses just the tokens when the prompt is empty', () => {
    expect(appendImageTokens('', ['image 1'])).toBe('[image 1]');
  });

  it('spaces the token off the preceding word', () => {
    expect(appendImageTokens('look at this', ['image 1'])).toBe('look at this [image 1]');
  });

  it('does not double the space when the text already ends with one', () => {
    expect(appendImageTokens('look ', ['image 1'])).toBe('look [image 1]');
  });

  it('joins multiple tokens', () => {
    expect(appendImageTokens('compare', ['image 1', 'image 2'])).toBe('compare [image 1] [image 2]');
  });
});

describe('stripImageToken', () => {
  it('removes a token and the space it leaves behind', () => {
    expect(stripImageToken('look at this [image 1]', 'image 1')).toBe('look at this');
  });

  it('leaves other tokens intact', () => {
    expect(stripImageToken('a [image 1] b [image 2]', 'image 1')).toBe('a b [image 2]');
  });

  it('is a no-op when the token is absent', () => {
    expect(stripImageToken('nothing here', 'image 9')).toBe('nothing here');
  });
});
