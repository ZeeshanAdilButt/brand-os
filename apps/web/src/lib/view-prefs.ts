/**
 * How the person likes the workspace laid out: which panels are folded away, the preview layout and size, the density
 * of the directories. Kept in one small cookie so the server renders the right layout on the first paint (no jump on
 * load) and so the choice belongs to this browser. Pure: no React and no document access here.
 */

export const VIEW_COOKIE = 'cph-view';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const PUBLISH_AREAS = ['article', 'platforms', 'previews'] as const;
export type PublishArea = (typeof PUBLISH_AREAS)[number];

export const PREVIEW_LAYOUTS = ['single', 'grid2', 'grid3', 'compare'] as const;
export type PreviewLayout = (typeof PREVIEW_LAYOUTS)[number];

export const PREVIEW_SIZES = ['compact', 'comfortable', 'large'] as const;
export type PreviewSize = (typeof PREVIEW_SIZES)[number];

export const PREVIEW_DEVICES = ['desktop', 'mobile'] as const;
export type PreviewDevice = (typeof PREVIEW_DEVICES)[number];

export const PREVIEW_APPEARANCES = ['light', 'dark'] as const;
export type PreviewAppearance = (typeof PREVIEW_APPEARANCES)[number];

export const STUDIO_PANELS = ['details', 'history', 'ai'] as const;
export type StudioPanel = (typeof STUDIO_PANELS)[number];

export const COMPOSER_PANES = ['original', 'suggestions'] as const;
export type ComposerPane = (typeof COMPOSER_PANES)[number];

export const DENSITIES = ['list', 'compact', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];

export interface ViewPrefs {
  /** The app sidebar is folded into a slim icon rail. */
  sidebarCollapsed: boolean;
  /** Publishing screen areas that are folded into a slim bar. */
  collapsedAreas: PublishArea[];
  previewLayout: PreviewLayout;
  previewSize: PreviewSize;
  /** The width a platform's preview is drawn at, and whether the platform is shown in light or dark. */
  previewDevice: PreviewDevice;
  previewAppearance: PreviewAppearance;
  /** The article studio side panel that was open last, or none. */
  studioPanel: StudioPanel | null;
  /** Composer side panes that are folded into a slim bar. */
  collapsedPanes: ComposerPane[];
  /** The category filter column on Platforms and Integrations is folded away. */
  filtersCollapsed: boolean;
  platformsDensity: Density;
  integrationsDensity: Density;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  sidebarCollapsed: false,
  collapsedAreas: [],
  previewLayout: 'single',
  previewSize: 'comfortable',
  previewDevice: 'desktop',
  previewAppearance: 'light',
  studioPanel: null,
  collapsedPanes: [],
  filtersCollapsed: false,
  platformsDensity: 'comfortable',
  integrationsDensity: 'list',
};

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function subset<T extends string>(allowed: readonly T[], value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return allowed.filter((item) => value.includes(item));
}

/** Read the cookie value. Anything missing, malformed or unknown falls back to its default, field by field. */
export function parseViewPrefs(raw: string | null | undefined): ViewPrefs {
  if (!raw) return { ...DEFAULT_VIEW_PREFS };
  let data: unknown;
  try {
    data = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { ...DEFAULT_VIEW_PREFS };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ...DEFAULT_VIEW_PREFS };
  const d = data as Record<string, unknown>;
  const panel = d.studioPanel;
  return {
    sidebarCollapsed: d.sidebarCollapsed === true,
    collapsedAreas: subset(PUBLISH_AREAS, d.collapsedAreas),
    previewLayout: oneOf(PREVIEW_LAYOUTS, d.previewLayout, DEFAULT_VIEW_PREFS.previewLayout),
    previewSize: oneOf(PREVIEW_SIZES, d.previewSize, DEFAULT_VIEW_PREFS.previewSize),
    previewDevice: oneOf(PREVIEW_DEVICES, d.previewDevice, DEFAULT_VIEW_PREFS.previewDevice),
    previewAppearance: oneOf(PREVIEW_APPEARANCES, d.previewAppearance, DEFAULT_VIEW_PREFS.previewAppearance),
    studioPanel: typeof panel === 'string' && (STUDIO_PANELS as readonly string[]).includes(panel) ? (panel as StudioPanel) : null,
    collapsedPanes: subset(COMPOSER_PANES, d.collapsedPanes),
    filtersCollapsed: d.filtersCollapsed === true,
    platformsDensity: oneOf(DENSITIES, d.platformsDensity, DEFAULT_VIEW_PREFS.platformsDensity),
    integrationsDensity: oneOf(DENSITIES, d.integrationsDensity, DEFAULT_VIEW_PREFS.integrationsDensity),
  };
}

/** Only values that differ from the defaults are written, so the cookie stays tiny and new defaults reach everyone. */
export function serializeViewPrefs(prefs: ViewPrefs): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_VIEW_PREFS) as (keyof ViewPrefs)[]) {
    if (JSON.stringify(prefs[key]) !== JSON.stringify(DEFAULT_VIEW_PREFS[key])) out[key] = prefs[key];
  }
  return encodeURIComponent(JSON.stringify(out));
}

/** The full `Set-Cookie`-style string for `document.cookie`. A layout choice is not a secret, so it is readable by the page. */
export function viewCookieString(prefs: ViewPrefs): string {
  return `${VIEW_COOKIE}=${serializeViewPrefs(prefs)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

export function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  const without = list.filter((x) => x !== item);
  return on ? [...without, item] : without;
}
