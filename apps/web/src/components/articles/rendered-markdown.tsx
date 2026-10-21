'use client';

import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { RenderNotice } from '@/lib/markdown/render';
import { cn } from '@/lib/utils';

/** Hidden items found by the renderer, shown plainly: how many, and what kind. */
export function RenderNotices({ notices, className }: { notices: RenderNotice[]; className?: string }) {
  const total = notices.reduce((sum, n) => sum + n.count, 0);
  if (total === 0) return null;
  return (
    <div role="status" className={cn('rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm leading-relaxed', className)}>
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{total === 1 ? '1 item was not rendered' : `${total} items were not rendered`}</span>
      </p>
      <p className="mt-1 text-muted-foreground">
        They are still in your Markdown. The preview and the reading view leave them out because they can run code, load other pages or are not supported here.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        {notices.map((n) => (
          <li key={n.key}>
            {n.label}
            {n.count > 1 ? <span className="text-muted-foreground"> (x{n.count})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let drawQueue: Promise<unknown> = Promise.resolve();
let counter = 0;
const drawn = new Map<string, string>();

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral');

function sourceBlock(source: string): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.dataset.lang = 'mermaid';
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.append(code);
  return pre;
}

function shortMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n').find((line) => line.trim()) ?? 'unknown error';
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

function showDiagram(block: HTMLElement, source: string, svg: string) {
  const diagram = document.createElement('div');
  diagram.className = 'mermaid-diagram';
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', 'Diagram. The source is available below.');
  diagram.innerHTML = svg; // mermaid runs in strict mode, which sanitizes its own output
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Show diagram source';
  details.append(summary, sourceBlock(source));
  block.replaceChildren(diagram, details);
}

function showFailure(block: HTMLElement, source: string, err: unknown) {
  const warning = document.createElement('p');
  warning.className = 'mermaid-warning';
  warning.setAttribute('role', 'alert');
  warning.textContent = `This diagram could not be drawn (${shortMessage(err)}). The source is shown below instead.`;
  block.replaceChildren(warning, sourceBlock(source));
}

/** Draw every ```mermaid block in `root`. Failures leave the code block and a visible warning. */
async function drawDiagrams(root: HTMLElement, cancelled: () => boolean) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'));
  if (blocks.length === 0) return;
  const theme = currentTheme();
  for (const block of blocks) {
    if (cancelled()) return;
    const source = block.dataset.source ?? block.querySelector('code')?.textContent ?? '';
    block.dataset.source = source;
    const key = `${theme}\u0000${source}`;
    const cached = drawn.get(key);
    if (cached) {
      showDiagram(block, source, cached);
      continue;
    }
    block.replaceChildren(Object.assign(document.createElement('p'), { className: 'mermaid-pending', textContent: 'Drawing diagram...' }), sourceBlock(source));
    const id = `cph-mermaid-${++counter}`;
    const task = drawQueue.then(async () => {
      if (cancelled()) return;
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'ui-sans-serif, system-ui, sans-serif' });
        const { svg } = await mermaid.render(id, source);
        drawn.set(key, svg);
        if (!cancelled()) showDiagram(block, source, svg);
      } catch (err) {
        // mermaid leaves a half-built element behind when it fails
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
        if (!cancelled()) showFailure(block, source, err);
      }
    });
    drawQueue = task.catch(() => undefined);
    await task;
  }
}

function addCopyButtons(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.closest('.mermaid-block') || pre.querySelector(':scope > .code-copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy this code');
    pre.append(button);
  }
}

/**
 * Show the HTML produced by renderMarkdown (already sanitized). Adds what needs a browser: copy
 * buttons on code, and Mermaid diagrams drawn lazily, with the source kept visible on failure.
 */
export function RenderedMarkdown({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let stop = false;
    addCopyButtons(root);
    void drawDiagrams(root, () => stop);
    const observer = new MutationObserver(() => {
      // The theme changed: draw the diagrams again in the matching palette.
      void drawDiagrams(root, () => stop);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      stop = true;
      observer.disconnect();
    };
  }, [html]);

  function onClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('code-copy')) return;
    const code = target.closest('pre')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code).then(
      () => {
        target.textContent = 'Copied';
        window.setTimeout(() => (target.textContent = 'Copy'), 1500);
      },
      () => {
        target.textContent = 'Copy failed';
        window.setTimeout(() => (target.textContent = 'Copy'), 1500);
      },
    );
  }

  // The HTML comes from renderMarkdown, which sanitizes against an allow-list and reports removals.
  return <div ref={ref} onClick={onClick} className={cn('article-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
