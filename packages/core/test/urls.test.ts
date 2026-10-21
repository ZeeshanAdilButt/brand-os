import { describe, expect, it } from 'vitest';
import { absolutize, canonicalUrlFor, coverPngUrl, withUtm } from '../src/urls.js';

const base = 'https://www.example-blog.dev';

describe('canonicalUrlFor', () => {
  it('builds the blog URL with the default base', () => {
    expect(canonicalUrlFor('s')).toBe(`${base}/blog/s`);
  });

  it('contains no utm_ parameters', () => {
    expect(canonicalUrlFor('s')).not.toContain('utm_');
  });

  it('honours a custom base and ignores a trailing slash on it', () => {
    expect(canonicalUrlFor('s', 'http://localhost:3000/')).toBe('http://localhost:3000/blog/s');
  });
});

describe('coverPngUrl', () => {
  it('maps a site-relative SVG cover to its absolute PNG twin', () => {
    expect(coverPngUrl('/images/blogs-covers/prometheus-cardinality.svg', base)).toBe(
      'https://www.example-blog.dev/images/blogs-covers/prometheus-cardinality.png',
    );
  });

  it('leaves a cover that is already a PNG as an absolute PNG', () => {
    expect(coverPngUrl('/images/blogs-covers/x.png', base)).toBe(`${base}/images/blogs-covers/x.png`);
  });

  it('handles an uppercase .SVG extension and absolute inputs', () => {
    expect(coverPngUrl('https://cdn.example.com/c/X.SVG', base)).toBe('https://cdn.example.com/c/X.png');
  });
});

describe('absolutize', () => {
  it('makes a site-relative path absolute', () => {
    expect(absolutize('/images/a.svg', base)).toBe(`${base}/images/a.svg`);
  });

  it('does not double the slash when the base has a trailing slash', () => {
    expect(absolutize('/images/a.svg', `${base}/`)).toBe(`${base}/images/a.svg`);
  });

  it('leaves absolute http, https and data URLs unchanged', () => {
    for (const src of ['https://a.com/x.png', 'http://a.com/x.png', 'data:image/png;base64,AAAA']) {
      expect(absolutize(src, base)).toBe(src);
    }
  });

  it('resolves a bare relative path against the site root', () => {
    expect(absolutize('images/a.svg', base)).toBe(`${base}/images/a.svg`);
  });

  it('gives protocol-relative URLs an https scheme', () => {
    expect(absolutize('//cdn.example.com/a.png', base)).toBe('https://cdn.example.com/a.png');
  });
});

describe('withUtm', () => {
  const canon = canonicalUrlFor('s');

  it('appends source, medium and campaign in that order', () => {
    expect(withUtm(canon, 'linkedin', 's')).toBe(
      `${canon}?utm_source=linkedin&utm_medium=social&utm_campaign=s`,
    );
  });

  it('keeps existing query parameters and the fragment', () => {
    expect(withUtm(`${canon}?ref=1#section`, 'x', 's')).toBe(
      `${canon}?ref=1&utm_source=x&utm_medium=social&utm_campaign=s#section`,
    );
  });

  it('replaces existing utm parameters instead of duplicating them', () => {
    const out = withUtm(`${canon}?utm_source=old&utm_medium=old&utm_campaign=old`, 'bluesky', 's');
    expect(out).toBe(`${canon}?utm_source=bluesky&utm_medium=social&utm_campaign=s`);
  });

  it('encodes unusual slugs', () => {
    expect(withUtm(canon, 'x', 'a b&c')).toContain('utm_campaign=a+b%26c');
  });
});
