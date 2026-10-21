'use client';

import { forwardRef, useEffect, useState } from 'react';
import type { RenderResult } from '@/lib/markdown/render';
import { RenderedMarkdown, RenderNotices } from './rendered-markdown';

/**
 * Live preview. It runs the same renderMarkdown the reading view uses (loaded on demand so the
 * editor opens quickly), a moment after typing pauses. The scroll container is exposed so the studio
 * can keep it level with the editor.
 */
export const PreviewPane = forwardRef<HTMLDivElement, { markdown: string; delayMs?: number }>(function PreviewPane({ markdown, delayMs = 250 }, ref) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => {
        import('@/lib/markdown/render')
          .then((m) => m.renderMarkdown(markdown))
          .then((next) => {
            if (!current) return;
            setResult(next);
            setFailed(false);
          })
          .catch(() => {
            if (current) setFailed(true);
          });
      },
      result === null ? 0 : delayMs,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // `result` only decides whether the first render waits; leaving it out is deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, delayMs]);

  return (
    <div ref={ref} className="h-full overflow-y-auto overscroll-contain px-4 py-5 sm:px-6" tabIndex={-1} aria-label="Preview">
      {failed ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          The preview could not be drawn. Your text is safe; keep writing.
        </p>
      ) : null}
      {result === null && !failed ? <p className="text-sm text-muted-foreground">Preparing the preview...</p> : null}
      {result ? (
        <>
          <RenderNotices notices={result.notices} className="mb-5" />
          {markdown.trim() === '' ? (
            <p className="text-sm text-muted-foreground">Nothing to preview yet. Start writing on the left, or paste Markdown.</p>
          ) : (
            <RenderedMarkdown html={result.html} />
          )}
        </>
      ) : null}
    </div>
  );
});
