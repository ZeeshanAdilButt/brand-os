'use client';

import { createContext, useContext, useEffect } from 'react';

/** What a page can ask the application chrome to do while it needs the room (full view, focus mode). */
export interface ShellLayout {
  /** Hide the left sidebar completely. */
  hideSidebar: boolean;
  /** Hide the top bar too. */
  hideHeader: boolean;
  /** Let the page use the whole width instead of the reading column. */
  wide: boolean;
  /** The full width with the usual page padding: for a page of two or more columns that wants room but not the edge. */
  fluid: boolean;
}

export const NORMAL_LAYOUT: ShellLayout = { hideSidebar: false, hideHeader: false, wide: false, fluid: false };

export const ShellLayoutContext = createContext<(layout: ShellLayout) => void>(() => undefined);

/**
 * Ask the shell for a layout while `active` is true. The shell goes back to normal when it turns false or the page
 * is left, so a page can never strand the person without navigation.
 */
export function useShellLayout(active: boolean, layout: Partial<ShellLayout>): void {
  const set = useContext(ShellLayoutContext);
  const { hideSidebar = false, hideHeader = false, wide = false, fluid = false } = layout;
  useEffect(() => {
    if (!active) return;
    set({ hideSidebar, hideHeader, wide, fluid });
    return () => set(NORMAL_LAYOUT);
  }, [active, hideSidebar, hideHeader, wide, fluid, set]);
}

/** One step of the rail the sidebar shows on a page that has a short journey (Publishing). */
export interface ShellStep {
  id: string;
  label: string;
  state: 'done' | 'current' | 'todo';
}

export const ShellStepsContext = createContext<(steps: ShellStep[] | null) => void>(() => undefined);

/** Show these steps in the sidebar while the page is open. They go away when the page is left. */
export function useShellSteps(steps: ShellStep[] | null): void {
  const set = useContext(ShellStepsContext);
  const key = steps ? JSON.stringify(steps) : '';
  useEffect(() => {
    if (!key) return;
    set(JSON.parse(key) as ShellStep[]);
    return () => set(null);
  }, [key, set]);
}
