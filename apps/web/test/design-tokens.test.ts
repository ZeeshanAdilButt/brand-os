import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[name as string] = value as string;
  return vars;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] as number) + 0.7152 * (channels[1] as number) + 0.0722 * (channels[2] as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio]. 4.5 for text, 3 for UI strokes such as focus rings.
const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['muted-foreground', 'sidebar', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['link', 'background', 4.5],
  ['link', 'card', 4.5],
  ['teal-text', 'background', 4.5],
  ['teal-text', 'card', 4.5],
  ['background', 'success', 4.5],
  ['background', 'warning', 4.5],
  ['background', 'destructive', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['ring', 'background', 3],
  ['input', 'background', 1.8],
];

describe.each([
  ['light', ':root'],
  ['dark', '[data-theme="dark"]'],
])('%s theme tokens', (_name, selector) => {
  const vars = { ...block(':root'), ...(selector === ':root' ? {} : block(selector)) };
  it.each(PAIRS)('%s on %s has contrast >= %s', (fg, bg, min) => {
    const f = vars[fg];
    const b = vars[bg];
    if (!f || !b) throw new Error(`missing token ${fg} or ${bg}`);
    expect(contrast(f, b), `${fg} ${f} on ${bg} ${b}`).toBeGreaterThanOrEqual(min);
  });
});

describe('palette and fonts', () => {
  it('keeps the personal-site palette in light mode', () => {
    expect(block(':root')).toMatchObject({ cream: '#f7f3eb', ink: '#1a1a18', rust: '#c45d35', teal: '#2d5a5a', sand: '#d4c5a9' });
  });

  it('uses local font stacks only (no network fonts)', () => {
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it('respects reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
