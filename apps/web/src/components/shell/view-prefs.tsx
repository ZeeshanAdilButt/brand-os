'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_VIEW_PREFS, viewCookieString, type ViewPrefs } from '@/lib/view-prefs';

interface ViewPrefsApi {
  prefs: ViewPrefs;
  /** Change some preferences; the new state is remembered in this browser at once. */
  update(patch: Partial<ViewPrefs>): void;
}

const FALLBACK: ViewPrefsApi = { prefs: DEFAULT_VIEW_PREFS, update: () => undefined };
const ViewPrefsContext = createContext<ViewPrefsApi>(FALLBACK);

/**
 * Holds the layout preferences. `initial` comes from the cookie, read on the server, so the first paint already has
 * the right layout. Without a provider (a bare component in a test) the defaults apply and changes are not kept.
 */
export function ViewPrefsProvider({ initial, children, write = writeCookie }: { initial: ViewPrefs; children: ReactNode; write?: (prefs: ViewPrefs) => void }) {
  const [prefs, setPrefs] = useState(initial);
  const latest = useRef(initial);
  const update = useCallback(
    (patch: Partial<ViewPrefs>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setPrefs(next);
      try {
        write(next);
      } catch {
        /* cookies blocked: the choice lasts until the page is closed */
      }
    },
    [write],
  );
  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <ViewPrefsContext.Provider value={value}>{children}</ViewPrefsContext.Provider>;
}

function writeCookie(prefs: ViewPrefs): void {
  document.cookie = viewCookieString(prefs);
}

export function useViewPrefs(): ViewPrefsApi {
  return useContext(ViewPrefsContext);
}
