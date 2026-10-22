import { isPlatformId, type PlatformId } from './catalog';
import type { WizardStep } from './wizard-state';

export type PublishView = 'guided' | 'composer';

/** What the publishing screen reads from its address. Anything that is not a known value is ignored, never trusted. */
export function parseSearch(search: { view?: string | undefined; step?: string | undefined; d?: string | undefined }): { view: PublishView | null; step: WizardStep | null; focus: PlatformId | null } {
  const step = Number(search.step);
  return {
    view: search.view === 'composer' || search.view === 'guided' ? search.view : null,
    step: step === 1 || step === 2 || step === 3 || step === 4 ? step : null,
    focus: search.d && isPlatformId(search.d) ? search.d : null,
  };
}
