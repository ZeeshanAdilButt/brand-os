import { isPlatformId, type PlatformId } from './catalog';

/**
 * What the publish wizard remembers so a reload loses nothing: the step, the chosen destinations and the one in
 * focus. The destinations and drafts themselves are saved on the server the moment they change; this is only the
 * walkthrough's place. Storage can be missing or full, so every read and write is guarded and the wizard works
 * without it.
 */

export type WizardStep = 1 | 2 | 3 | 4;

export interface WizardState {
  v: 1;
  step: WizardStep;
  selected: PlatformId[];
  focus: PlatformId | null;
}

export const DEFAULT_WIZARD: WizardState = { v: 1, step: 1, selected: [], focus: null };

export const wizardKey = (articleId: string) => `brand-os.wizard.${articleId}`;
export const REMEMBERED_KEY = 'brand-os.last-destinations';

type Reader = Pick<Storage, 'getItem'> | null | undefined;
type Writer = Pick<Storage, 'setItem' | 'removeItem'> | null | undefined;

/** Parse stored text. Anything unexpected becomes the default instead of an error. */
export function parseWizard(raw: string | null): WizardState {
  if (!raw) return { ...DEFAULT_WIZARD, selected: [] };
  try {
    const value = JSON.parse(raw) as Partial<WizardState> | null;
    if (!value || typeof value !== 'object' || value.v !== 1) return { ...DEFAULT_WIZARD, selected: [] };
    const step = value.step === 2 || value.step === 3 || value.step === 4 ? value.step : 1;
    const selected = Array.isArray(value.selected) ? [...new Set(value.selected.filter(isPlatformId))] : [];
    const focus = value.focus && isPlatformId(value.focus) && selected.includes(value.focus) ? value.focus : null;
    return { v: 1, step, selected, focus };
  } catch {
    return { ...DEFAULT_WIZARD, selected: [] };
  }
}

export function loadWizard(storage: Reader, articleId: string): WizardState {
  try {
    return parseWizard(storage?.getItem(wizardKey(articleId)) ?? null);
  } catch {
    return { ...DEFAULT_WIZARD, selected: [] };
  }
}

export function saveWizard(storage: Writer, articleId: string, state: WizardState): void {
  try {
    storage?.setItem(wizardKey(articleId), JSON.stringify(state));
  } catch {
    /* private window or full storage: the wizard still works */
  }
}

export function clearWizard(storage: Writer, articleId: string): void {
  try {
    storage?.removeItem(wizardKey(articleId));
  } catch {
    /* ignore */
  }
}

export function loadRemembered(storage: Reader): PlatformId[] {
  try {
    const raw = storage?.getItem(REMEMBERED_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? [...new Set(value.filter(isPlatformId))].slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function saveRemembered(storage: Writer, chosen: readonly PlatformId[]): void {
  try {
    storage?.setItem(REMEMBERED_KEY, JSON.stringify([...new Set(chosen)].slice(0, 8)));
  } catch {
    /* ignore */
  }
}
