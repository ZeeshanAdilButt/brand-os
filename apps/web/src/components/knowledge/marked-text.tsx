import { splitMarked } from '@/lib/knowledge';

/** Text from the search layer with matches highlighted. Rendered as React text nodes, never as HTML. */
export function MarkedText({ text }: { text: string }) {
  return (
    <>
      {splitMarked(text).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-warning/25 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
