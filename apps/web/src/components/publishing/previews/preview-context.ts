'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformId } from '@/lib/catalog';

export type Device = 'desktop' | 'mobile';
export type Appearance = 'light' | 'dark';

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

/**
 * Where the choices about how previews are drawn live, when a page keeps them in one place. With it, a preview shows one
 * slim bar with a single View control, and device and appearance are the page's choice rather than each preview's;
 * `menu` adds the page's own sections (layout, size, window) to the same View panel. Without it a preview keeps its own
 * state and shows its controls in a row, as the composer and the expanded overlay do.
 */
export interface PreviewView {
  device: Device;
  onDevice(device: Device): void;
  appearance: Appearance;
  onAppearance(appearance: Appearance): void;
  menu?: ReactNode;
}
export const PreviewViewContext = createContext<PreviewView | null>(null);
export const usePreviewView = () => useContext(PreviewViewContext);
