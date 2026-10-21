import { describe, expect, it } from 'vitest';
import { extractNumbers, findUnsourcedNumbers } from '../src/lint/numbers.js';

describe('extractNumbers', () => {
  it.each([
    ['1,000 requests', ['1000']],
    ['16,800 series', ['16800']],
    ['1,234,567.50 total', ['1234567.5']],
    ['p99.9 latency', ['99.9']],
    ['12% of memory', ['12']],
    ['x12 faster', ['12']],
    ['1 to 2 bytes', ['1', '2']],
    ['a 007 and 45.0', ['7', '45']],
    ['no numbers here', []],
  ])('%s', (input, expected) => {
    expect(extractNumbers(input)).toEqual(expected);
  });

  it('counts ordinals as numbers', () => {
    expect(extractNumbers('the 1st, 2nd, 3rd and 4th, then 20 and the 95th')).toEqual(['1', '2', '3', '4', '20', '95']);
  });

  it('ignores everything inside URLs', () => {
    expect(extractNumbers('see https://example.com/2026/05/post?utm_campaign=2026 for 31')).toEqual(['31']);
  });
});

describe('findUnsourcedNumbers', () => {
  it('accepts numbers that appear in a source', () => {
    expect(findUnsourcedNumbers('drops 31 series to 7', ['31 series to 7 after aggregation'])).toEqual([]);
  });

  it('flags a number with no source', () => {
    expect(findUnsourcedNumbers('saves 45% of memory', ['memory use fell after aggregation'])).toEqual(['45']);
  });

  it('matches across formatting: 16,800 against 16800', () => {
    expect(findUnsourcedNumbers('16,800 series', ['16800'])).toEqual([]);
    expect(findUnsourcedNumbers('16800 series', ['16,800'])).toEqual([]);
  });

  it('ignores numbers inside URLs, including UTM params', () => {
    expect(findUnsourcedNumbers('read https://www.example-blog.dev/blog/x?utm_campaign=2026', [])).toEqual([]);
  });

  it('allows single digits 0-9 without a source', () => {
    expect(findUnsourcedNumbers('3 points, 0 regrets, 9 lives', [])).toEqual([]);
  });

  it('flags an ordinal with no source: the 95th percentile is not the 99th', () => {
    expect(findUnsourcedNumbers('the 95th percentile', ['the 99th percentile'])).toEqual(['95']);
    expect(findUnsourcedNumbers('the 99th percentile', ['the 99th percentile'])).toEqual([]);
  });

  it('still allows single-digit ordinals 1st to 9th without a source', () => {
    expect(findUnsourcedNumbers('the 1st, 2nd and 9th step', [])).toEqual([]);
  });

  it('still flags decimals and multi-digit numbers', () => {
    expect(findUnsourcedNumbers('0.5 and 10', [])).toEqual(['0.5', '10']);
  });

  it('reports each unsourced number once, in order of appearance', () => {
    expect(findUnsourcedNumbers('45 then 62 then 45 again', ['62'])).toEqual(['45']);
  });

  it('looks across all sources', () => {
    expect(findUnsourcedNumbers('12 and 13', ['12', 'thirteen is 13'])).toEqual([]);
  });
});
