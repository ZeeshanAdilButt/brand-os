'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { RenderedMarkdown } from '@/components/articles/rendered-markdown';
import { buttonVariants } from '@/components/ui/button';

/** Wrap the first occurrence of `quote` in the rendered article in a <mark>, and scroll to it. Returns false when it is not found. */
export function highlightQuote(root: HTMLElement, quote: string): boolean {
  root.querySelectorAll('mark[data-jump]').forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
  root.normalize();
  const wanted = quote.trim().replace(/\s+/g, ' ');
  if (wanted.length < 3) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? '';
    const at = text.replace(/\s+/g, ' ').indexOf(wanted);
    if (at === -1) continue;
    const range = document.createRange();
    // Offsets are exact only when whitespace was not collapsed; fall back to the whole node otherwise.
    const exact = text.indexOf(wanted);
    if (exact >= 0) {
      range.setStart(node, exact);
      range.setEnd(node, exact + wanted.length);
    } else range.selectNodeContents(node);
    const mark = document.createElement('mark');
    mark.dataset.jump = 'true';
    mark.className = 'rounded bg-warning-subtle px-0.5 text-foreground ring-2 ring-warning/50';
    try {
      range.surroundContents(mark);
    } catch {
      return false;
    }
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }
  return false;
}

/** The article as written, read-only, with a way back to the studio. A review note can point at the words it is about. */
export function OriginalPane({ articleId, title, html, jump }: { articleId: string; title: string; html: string; jump: { quote: string; nonce: number } | null }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jump && body.current) highlightQuote(body.current, jump.quote);
  }, [jump]);
  return (
    <section aria-label="Your article" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b px-4 py-2">
        <Link href={`/articles/${articleId}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft aria-hidden />
          Back to the studio
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <h3 className="text-xl leading-7 font-semibold">{title || 'Untitled article'}</h3>
        <div ref={body} className="mt-4">
          <RenderedMarkdown html={html} />
        </div>
      </div>
    </section>
  );
}
