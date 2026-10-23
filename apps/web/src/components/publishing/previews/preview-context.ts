'use client';

import { createContext, useContext } from 'react';
import type { PlatformId } from '@/lib/catalog';

/** How much the simulated surface is scaled. 1 is the default size; the previews area and the expanded overlay set it. */
export const PreviewScaleContext = createContext(1);
export const usePreviewScale = () => useContext(PreviewScaleContext);

/**
 * Lets a preview offer an "Expand" control. Where a provider exists (the publishing screen, the composer) every
 * preview shows the control; elsewhere, and inside the expanded overlay itself, it is simply absent.
 */
export interface ExpandApi {
  open(platform: PlatformId, opener: HTMLElement | null): void;
}
export const PreviewExpandContext = createContext<ExpandApi | null>(null);
export const usePreviewExpand = () => useContext(PreviewExpandContext);
