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
}

export const NORMAL_LAYOUT: ShellLayout = { hideSidebar: false, hideHeader: false, wide: false };

export const ShellLayoutContext = createContext<(layout: ShellLayout) => void>(() => undefined);

/**
 * Ask the shell for a layout while `active` is true. The shell goes back to normal when it turns false or the page
 * is left, so a page can never strand the person without navigation.
 */
export function useShellLayout(active: boolean, layout: Partial<ShellLayout>): void {
  const set = useContext(ShellLayoutContext);
  const { hideSidebar = false, hideHeader = false, wide = false } = layout;
  useEffect(() => {
    if (!active) return;
    set({ hideSidebar, hideHeader, wide });
    return () => set(NORMAL_LAYOUT);
  }, [active, hideSidebar, hideHeader, wide, set]);
}
