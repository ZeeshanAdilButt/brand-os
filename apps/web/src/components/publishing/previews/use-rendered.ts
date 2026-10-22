'use client';

import { useEffect, useState } from 'react';
import type { RenderNotice } from '@/lib/markdown/render';

export interface RenderedState {
  html: string | null;
  notices: RenderNotice[];
  failed: boolean;
}

/**
 * The Markdown of a draft, rendered with the same sanitizing pipeline as the article studio (loaded on demand).
 * Anything the pipeline removes is reported, never silently dropped. The input is always the adapted payload, so
 * the preview shows what would be sent and not a fresh reading of the article.
 */
export function useRenderedMarkdown(markdown: string): RenderedState {
  const [state, setState] = useState<RenderedState>({ html: null, notices: [], failed: false });
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      import('@/lib/markdown/render')
        .then((m) => m.renderMarkdown(markdown))
        .then((result) => {
          if (current) setState({ html: result.html, notices: result.notices, failed: false });
        })
        .catch(() => {
          if (current) setState({ html: null, notices: [], failed: true });
        });
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [markdown]);
  return state;
}
