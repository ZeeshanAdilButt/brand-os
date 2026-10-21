import { describe, expect, it } from 'vitest';
import { countLinks, graphemeLength } from '../src/lint/text.js';

describe('graphemeLength', () => {
  it('counts grapheme clusters, not UTF-16 units', () => {
    expect('ρ👩‍💻'.length).toBeGreaterThan(2);
    expect(graphemeLength('ρ👩‍💻')).toBe(2);
  });

  it('handles empty, ASCII and combining sequences', () => {
    expect(graphemeLength('')).toBe(0);
    expect(graphemeLength('abc')).toBe(3);
    expect(graphemeLength('e\u0301')).toBe(1);
    expect(graphemeLength('🇵🇰')).toBe(1);
  });
});

describe('countLinks', () => {
  it('returns the URLs found, without trailing punctuation', () => {
    const text = 'Read https://www.example-blog.dev/blog/x?utm_source=linkedin, then (http://example.com/a).';
    expect(countLinks(text)).toEqual(['https://www.example-blog.dev/blog/x?utm_source=linkedin', 'http://example.com/a']);
  });

  it('returns [] when there is no link', () => {
    expect(countLinks('no links here, just example.com')).toEqual([]);
  });

  it('keeps markdown link targets and stops at the closing bracket', () => {
    expect(countLinks('see [the post](https://a.example/p) now')).toEqual(['https://a.example/p']);
  });
});
