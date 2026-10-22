import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/app/globals.css'), 'utf8');

/** The custom properties of one block, with `var(--other)` aliases resolved against the same block. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const raw: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) raw[name as string] = (value as string).trim();
  return raw;
}

function resolve(vars: Record<string, string>, name: string, depth = 0): string | undefined {
  const value = vars[name];
  if (value === undefined || depth > 5) return undefined;
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolve(vars, alias[1] as string, depth + 1) : value;
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

// [foreground, background, minimum ratio]. 4.5 for text, 3 for the boundary of a control and for focus.
const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['foreground', 'surface', 4.5],
  ['card-foreground', 'card', 4.5],
  ['popover-foreground', 'popover', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'surface', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['muted-foreground', 'sidebar', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['primary-foreground', 'primary-hover', 4.5],
  ['primary-foreground', 'primary-active', 4.5],
  ['link', 'background', 4.5],
  ['link', 'surface', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['neutral', 'neutral-subtle', 4.5],
  ['success', 'success-subtle', 4.5],
  ['warning', 'warning-subtle', 4.5],
  ['danger', 'danger-subtle', 4.5],
  ['info', 'info-subtle', 4.5],
  ['success', 'surface', 4.5],
  ['warning', 'surface', 4.5],
  ['danger', 'surface', 4.5],
  ['danger-foreground', 'danger', 4.5],
  ['selection-foreground', 'selection', 4.5],
  ['category-blogs', 'surface', 4.5],
  ['category-social', 'surface', 4.5],
  ['category-communities', 'surface', 4.5],
  ['category-video', 'surface', 4.5],
  ['category-conferences', 'surface', 4.5],
  ['category-editorial', 'surface', 4.5],
  ['category-launches', 'surface', 4.5],
  ['category-aggregators', 'surface', 4.5],
  ['ring', 'background', 3],
  ['ring', 'surface', 3],
  // A form control must be findable: its boundary is at least 3:1 against the page and against a surface.
  ['input', 'background', 3],
  ['input', 'surface', 3],
];

describe.each([
  ['light', ':root'],
  ['dark', '[data-theme="dark"]'],
])('%s theme tokens', (_name, selector) => {
  const own = selector === ':root' ? block(':root') : block('.dark,\n[data-theme="dark"]');
  const vars = selector === ':root' ? own : { ...block(':root'), ...own };
  it.each(PAIRS)('%s on %s has contrast >= %s', (fg, bg, min) => {
    const f = resolve(vars, fg);
    const b = resolve(vars, bg);
    if (!f || !b || !f.startsWith('#') || !b.startsWith('#')) throw new Error(`missing or non-hex token ${fg} (${f}) or ${bg} (${b})`);
    expect(contrast(f, b), `${fg} ${f} on ${bg} ${b}`).toBeGreaterThanOrEqual(min);
  });
});

describe('design system v2', () => {
  const light = block(':root');
  const dark = block('.dark,\n[data-theme="dark"]');

  it('defines every status, category and surface token in both themes', () => {
    for (const name of ['surface', 'surface-raised', 'primary-hover', 'primary-active', 'neutral', 'neutral-subtle', 'success', 'success-subtle', 'warning', 'warning-subtle', 'danger', 'danger-subtle', 'info', 'info-subtle', 'code-background']) {
      expect(light[name], `light ${name}`).toBeTruthy();
      expect(dark[name], `dark ${name}`).toBeTruthy();
    }
    for (const area of ['blogs', 'social', 'communities', 'video', 'conferences', 'editorial', 'launches', 'aggregators']) {
      expect(light[`category-${area}`], area).toMatch(/^#/);
      expect(dark[`category-${area}`], area).toMatch(/^#/);
    }
  });

  it('uses a cool neutral canvas with white working surfaces and an indigo action colour', () => {
    expect(light.background).toBe('#f6f8fc');
    expect(light.surface).toBe('#ffffff');
    expect(light.primary).toBe('#4338ca');
    // Page and surface are distinguishable by more than a hair, and the dark canvas is darker than its surface.
    expect(luminance(dark.surface as string)).toBeGreaterThan(luminance(dark.background as string));
  });

  it('keeps the old brand names only as aliases of the new tokens, if at all', () => {
    for (const legacy of ['cream', 'rust', 'sand', 'ink']) expect(light[legacy] === undefined || light[legacy]?.startsWith('var(')).toBe(true);
  });

  it('uses the sans stack for the application and reserves serif for reading', () => {
    expect(css).toMatch(/--font-sans:\s*"Segoe UI"/);
    expect(css).toMatch(/h1,\s*\n\s*h2,\s*\n\s*h3 \{\s*\n\s*@apply font-sans/);
  });

  it('uses local font stacks only (no network fonts)', () => {
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it('respects reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('has one focus treatment: an opaque ring', () => {
    expect(css).toMatch(/:focus-visible \{\s*\n\s*outline: 2px solid var\(--ring\)/);
  });
});
