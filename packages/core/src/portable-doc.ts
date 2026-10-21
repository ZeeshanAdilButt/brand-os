import type { PhrasingContent } from 'mdast';

/**
 * Inline content: mdast phrasing content (text, emphasis, strong, delete,
 * inlineCode, link, image, break, html, ...). Link and image URLs are already
 * absolute and `position` data is stripped.
 */
export type Inline = PhrasingContent;

/** Components that `lowerMdx` turns into `interactive` nodes. */
export const INTERACTIVE_COMPONENTS = ['PacketJourney', 'StateMachine', 'OutOfBandDiagram'] as const;

export type PNode =
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  /** `start`: the first number of an ordered list, when the source gives one (lists may start at 7). */
  | { type: 'list'; ordered: boolean; start?: number; items: PNode[][] }
  | { type: 'code'; lang?: string; value: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'image'; src: string; alt: string; svg: boolean }
  | { type: 'callout'; kind: 'note' | 'aside' | 'alert'; title?: string; children: PNode[] }
  | { type: 'interactive'; component: string; name?: string; anchor: string }
  | { type: 'blockquote'; children: PNode[] }
  | { type: 'thematicBreak' }
  | { type: 'html'; value: string }
  | { type: 'unsupported'; component: string; line: number };

export interface PortableDoc {
  nodes: PNode[];
  /** Plain text of the whole post, used for numeric provenance checks. */
  plainText: string;
}
