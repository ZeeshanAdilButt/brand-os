/**
 * Keyboard helpers shared by the layout controls. A layout shortcut must never act while the person is typing, so
 * every handler asks `isTypingTarget` first.
 */

const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, [role="textbox"], [role="combobox"]';

/** True when the event came from a field the person can type in: an input, a textarea, a select or the editor. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest(TYPING_SELECTOR) !== null;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+\ (Cmd+\ on a Mac) folds or opens the sidebar. Not Ctrl+B: the editor uses that for bold. */
export function isSidebarShortcut(event: KeyLike): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return event.key === '\\' || event.code === 'Backslash';
}

/** Move through a list of `count` items and come round at either end. */
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
