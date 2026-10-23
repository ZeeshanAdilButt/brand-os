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
  ['muted-foreground', 'raised', 4.5],
  ['foreground', 'raised', 4.5],
  ['foreground', 'code-background', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['muted-foreground', 'surface', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['sidebar-foreground', 'sidebar', 4.5],
  ['sidebar-muted', 'sidebar', 4.5],
  ['sidebar-muted', 'sidebar-active', 4.5],
  ['sidebar-foreground', 'sidebar-active', 4.5],
  ['sidebar-accent', 'sidebar', 4.5],
  ['sidebar-accent', 'sidebar-active', 4.5],
  ['solid-foreground', 'solid', 4.5],
  ['solid-muted', 'solid', 4.5],
  ['solid-accent', 'solid', 4.5],
  ['accent-warm', 'background', 4.5],
  ['accent-warm', 'surface', 4.5],
  ['accent-warm', 'raised', 4.5],
  ['accent-warm', 'accent-warm-soft', 4.5],
  ['accent-warm-ink', 'accent-warm-soft', 4.5],
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
  ['category-blogs', 'background', 4.5],
  ['category-blogs', 'surface', 4.5],
  ['category-blogs', 'raised', 4.5],
  ['category-social', 'background', 4.5],
  ['category-social', 'surface', 4.5],
  ['category-social', 'raised', 4.5],
  ['category-communities', 'background', 4.5],
  ['category-communities', 'surface', 4.5],
  ['category-communities', 'raised', 4.5],
  ['category-video', 'background', 4.5],
  ['category-video', 'surface', 4.5],
  ['category-video', 'raised', 4.5],
  ['category-conferences', 'background', 4.5],
  ['category-conferences', 'surface', 4.5],
  ['category-conferences', 'raised', 4.5],
  ['category-editorial', 'background', 4.5],
  ['category-editorial', 'surface', 4.5],
  ['category-editorial', 'raised', 4.5],
  ['category-launches', 'background', 4.5],
  ['category-launches', 'surface', 4.5],
  ['category-launches', 'raised', 4.5],
  ['category-aggregators', 'background', 4.5],
  ['category-aggregators', 'surface', 4.5],
  ['category-aggregators', 'raised', 4.5],
  ['ring', 'background', 3],
  ['ring', 'surface', 3],
  // A form control must be findable: its boundary is at least 3:1 against the page and against a surface.
  ['input', 'background', 3],
  ['input', 'surface', 3],
  ['input', 'raised', 3],
  ['input-border', 'surface', 3],
  ['ring', 'raised', 3],
  ['info', 'surface', 4.5],
  ['primary', 'surface', 4.5],
  ['primary', 'background', 4.5],
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

describe('design system v3, Field Notes', () => {
  const light = block(':root');
  const dark = block('.dark,\n[data-theme="dark"]');
  const all = { dark: { ...light, ...dark }, light };

  it('defines every status, category and surface token in both themes', () => {
    for (const name of ['surface', 'surface-raised', 'raised', 'input-border', 'primary-hover', 'primary-active', 'neutral', 'neutral-subtle', 'success', 'success-subtle', 'warning', 'warning-subtle', 'danger', 'danger-subtle', 'info', 'info-subtle', 'code-background', 'accent-warm', 'accent-warm-soft', 'accent-warm-ink', 'solid', 'sidebar', 'sidebar-muted']) {
      expect(light[name], `light ${name}`).toBeTruthy();
      expect(all.dark[name], `dark ${name}`).toBeTruthy();
    }
    for (const area of ['blogs', 'social', 'communities', 'video', 'conferences', 'editorial', 'launches', 'aggregators']) {
      expect(light[`category-${area}`], area).toMatch(/^#/);
      expect(dark[`category-${area}`], area).toMatch(/^#/);
    }
  });

  it('uses bone paper, white surfaces, forest as the action colour and lime for selection', () => {
    expect(light.background).toBe('#f6f4ec');
    expect(light.surface).toBe('#ffffff');
    expect(light.foreground).toBe('#14211b');
    expect(light.primary).toBe('#12372a');
    expect(light.sidebar).toBe('#12372a');
    expect(light['primary-foreground']).toBe('#d6f36b');
    expect(light.accent).toBe('#eef3dc');
    expect(light.danger).toBe('#8a2b14');
    expect(light['danger-bg']).toBe('#fbe0d8');
    expect(light.border).toBe('#c9cfbd');
    // Forest is green, not blue: its green channel leads its blue one.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt((light.primary as string).slice(i, i + 2), 16)) as [number, number, number];
    expect(g).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(r);
  });

  it('has a deep green dark theme: every dark neutral leans green, never blue and never plain grey', () => {
    for (const name of ['background', 'surface', 'raised', 'border', 'muted', 'sidebar']) {
      const hex = dark[name] as string;
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      expect(g, `${name} ${hex}`).toBeGreaterThan(r);
      expect(g, `${name} ${hex}`).toBeGreaterThan(b);
    }
    expect(luminance(dark.surface as string)).toBeGreaterThan(luminance(dark.background as string));
    expect(luminance(dark.raised as string)).toBeGreaterThan(luminance(dark.surface as string));
  });

  it('keeps the old brand names only as aliases of the new tokens, if at all', () => {
    for (const legacy of ['cream', 'rust', 'sand', 'ink', 'success-subtle', 'danger-subtle', 'neutral-subtle']) expect(light[legacy] === undefined || light[legacy]?.startsWith('var(')).toBe(true);
  });

  it('uses Instrument Sans for the interface, Bricolage Grotesque for headings, Plex Mono for labels and a serif for articles only', () => {
    expect(css).toMatch(/--font-sans:\s*var\(--font-instrument-sans\)/);
    expect(css).toMatch(/--font-display:\s*var\(--font-bricolage\)/);
    expect(css).toMatch(/--font-mono:\s*var\(--font-plex-mono\)/);
    expect(css).toMatch(/--font-serif:\s*var\(--font-newsreader\)/);
    expect(css).toMatch(/h1,\s*\n\s*h2,\s*\n\s*h3,\s*\n\s*h4 \{\s*\n\s*@apply font-display/);
  });

  it('loads its fonts through next/font, with no font service link in the stylesheet', () => {
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    const layout = fs.readFileSync(path.resolve(import.meta.dirname, '../src/app/layout.tsx'), 'utf8');
    for (const family of ['Bricolage_Grotesque', 'Instrument_Sans', 'IBM_Plex_Mono', 'Newsreader']) expect(layout).toContain(family);
    expect(layout).not.toMatch(/<link[^>]+fonts\./);
  });

  it('draws a faint 32px field grid on the page', () => {
    expect(css).toMatch(/background-size:\s*32px 32px/);
    expect(light.grid).toBeTruthy();
    expect(dark.grid).toBeTruthy();
  });

  it('respects reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('has one focus treatment: an opaque ring', () => {
    expect(css).toMatch(/:focus-visible \{\s*\n\s*outline: 2px solid var\(--ring\)/);
  });
});
