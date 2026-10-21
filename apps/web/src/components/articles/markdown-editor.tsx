'use client';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, Prec, type ChangeSpec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import {
  Bold,
  Code,
  FileCode,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Table2,
  Workflow,
} from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from 'react';
import { MAX_IMAGE_BYTES } from '@/lib/articles';
import { cn } from '@/lib/utils';

export interface EditorHandle {
  /** Replace the whole document (restore, taking the other version). Does not fire onChange. */
  setValue(text: string): void;
  focus(): void;
  /** Open the image picker. */
  chooseImage(): void;
  /** The current selection, or null when nothing is selected. */
  getSelection(): EditorSelectionInfo | null;
}

export interface EditorSelectionInfo {
  /** Offsets into the Markdown text (UTF-16 code units, the same positions the server uses). */
  start: number;
  end: number;
  text: string;
}

export interface UploadOutcome {
  markdown?: string;
  error?: string;
}

interface Props {
  initialValue: string;
  onChange(value: string): void;
  onSave(): void;
  onTogglePreview(): void;
  onUploadImage(file: File): Promise<UploadOutcome>;
  onNotice(message: string): void;
  /** 0 to 1, how far the editor is scrolled. */
  onScroll?(fraction: number): void;
  /** Called when the selection changes: the selected range, or null when the cursor is just a caret. */
  onSelectionChange?(selection: EditorSelectionInfo | null): void;
  className?: string;
}

/** Colors come from the site tokens, so the editor follows light and dark with no second theme. */
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--foreground)', backgroundColor: 'var(--card)', fontSize: '0.875rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '1rem 0 40vh', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 1rem' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--foreground) 5%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--rust) 30%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--teal) 25%, transparent)', outline: 'none' },
});

const highlighting = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--foreground)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.quote, color: 'var(--muted-foreground)' },
  { tag: t.monospace, color: 'var(--teal-text)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--muted-foreground)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--link)' },
  { tag: [t.string, t.regexp, t.special(t.string)], color: 'var(--teal-text)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warning)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.definition(t.variableName), t.className, t.propertyName], color: 'var(--foreground)', fontWeight: '600' },
  { tag: [t.typeName, t.tagName, t.attributeName], color: 'var(--warning)' },
]);

/* Commands. Each takes the view and returns true so it can be a key binding or a toolbar action. */

function wrap(before: string, after = before, sample = 'text') {
  return (view: EditorView): boolean => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const selected = state.sliceDoc(range.from, range.to);
        const outerBefore = state.sliceDoc(Math.max(0, range.from - before.length), range.from);
        const outerAfter = state.sliceDoc(range.to, range.to + after.length);
        if (range.empty === false && outerBefore === before && outerAfter === after) {
          // Already wrapped: take the markers off again.
          return {
            changes: [
              { from: range.from - before.length, to: range.from },
              { from: range.to, to: range.to + after.length },
            ],
            range: EditorSelection.range(range.from - before.length, range.to - before.length),
          };
        }
        const inner = selected || sample;
        const insert = `${before}${inner}${after}`;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
        };
      }),
    );
    view.focus();
    return true;
  };
}

function link(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to) || 'link text';
      const url = 'https://';
      const insert = `[${text}](${url})`;
      const urlStart = range.from + text.length + 3;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlStart, urlStart + url.length) };
    }),
  );
  view.focus();
  return true;
}

/** Add `prefix` to every selected line, or remove it when every line already has it. */
function prefixLines(prefix: string | ((index: number) => string), strip: RegExp) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    const lines = new Set<number>();
    for (const range of state.selection.ranges) {
      for (let pos = range.from; pos <= range.to; ) {
        const line = state.doc.lineAt(pos);
        lines.add(line.number);
        pos = line.to + 1;
      }
    }
    const ordered = [...lines].sort((a, b) => a - b).map((n) => state.doc.line(n));
    const allPrefixed = ordered.every((line) => strip.test(line.text));
    ordered.forEach((line, index) => {
      if (allPrefixed) {
        const match = strip.exec(line.text);
        if (match) changes.push({ from: line.from, to: line.from + match[0].length });
      } else if (!strip.test(line.text)) {
        changes.push({ from: line.from, insert: typeof prefix === 'string' ? prefix : prefix(index) });
      }
    });
    view.dispatch({ changes });
    view.focus();
    return true;
  };
}

function insertBlock(text: string, selectFrom?: number, selectLength = 0) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const atLineStart = head === line.from && line.text === '';
    const lead = atLineStart ? '' : line.text === '' ? '' : '\n\n';
    const insert = `${lead}${text}\n`;
    const start = (atLineStart || line.text === '' ? line.from : line.to) + lead.length;
    const at = atLineStart || line.text === '' ? line.from : line.to;
    view.dispatch({
      changes: { from: at, insert },
      selection:
        selectFrom === undefined ? { anchor: at + insert.length } : EditorSelection.range(start + selectFrom, start + selectFrom + selectLength),
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
}

const heading = prefixLines('## ', /^#{1,6}\s+/);
const quote = prefixLines('> ', /^>\s?/);
const bullets = prefixLines('- ', /^[-*+]\s+/);
const numbers = prefixLines((i) => `${i + 1}. `, /^\d+[.)]\s+/);
const tasks = prefixLines('- [ ] ', /^[-*+]\s+\[[ xX]\]\s+/);
const codeBlock = insertBlock('```\ncode\n```', 4, 4);
const table = insertBlock('| Column | Column |\n| --- | --- |\n| Cell | Cell |');
const diagram = insertBlock('```mermaid\ngraph TD\n  A[Start] --> B[Next step]\n```');

const noopSubscribe = () => () => {};
const isApple = () => /Mac|iPhone|iPad/.test(navigator.platform);

interface ToolbarButton {
  label: string;
  shortcut?: string;
  icon: typeof Bold;
  run: (view: EditorView) => boolean;
}

const isImage = (file: File) => file.type.startsWith('image/');

/**
 * CodeMirror 6 Markdown editor. It owns the text while mounted: the parent hears every change and
 * can replace the text with the handle. Loaded on demand (the studio imports it dynamically), since
 * the editor and its language support are the heaviest part of the page.
 */
export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const apple = useSyncExternalStore(noopSubscribe, isApple, () => false);
  const mod = apple ? '⌘' : 'Ctrl+';

  useImperativeHandle(ref, () => ({
    setValue(text) {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 } });
    },
    focus() {
      view.current?.focus();
    },
    chooseImage() {
      fileInput.current?.click();
    },
    getSelection() {
      const v = view.current;
      if (!v) return null;
      const { from, to } = v.state.selection.main;
      return from === to ? null : { start: from, end: to, text: v.state.sliceDoc(from, to) };
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    let counter = 0;

    /** Upload each image and swap its placeholder for the Markdown that points at it. */
    async function uploadAll(files: File[], at: number) {
      const v = view.current;
      if (!v) return;
      for (const file of files) {
        if (file.size > MAX_IMAGE_BYTES) {
          latest.current.onNotice(`${file.name || 'The image'} is larger than 10 MB, so it was not uploaded.`);
          continue;
        }
        const placeholder = `![Uploading ${file.name || 'image'} ${++counter}...]()`;
        const position = Math.min(at, v.state.doc.length);
        v.dispatch({ changes: { from: position, insert: `${placeholder}\n` }, selection: { anchor: position + placeholder.length + 1 } });
        at = position + placeholder.length + 1;
        const outcome = await latest.current.onUploadImage(file);
        const current = view.current;
        if (!current) return;
        const found = current.state.doc.toString().indexOf(placeholder);
        if (found === -1) continue; // the person deleted it meanwhile
        if (outcome.markdown) {
          current.dispatch({ changes: { from: found, to: found + placeholder.length, insert: outcome.markdown } });
        } else {
          current.dispatch({ changes: { from: found, to: found + placeholder.length + 1 } });
          latest.current.onNotice(outcome.error ?? 'The image could not be uploaded.');
        }
      }
    }

    const keys = Prec.highest(
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave(), true) },
        { key: 'Mod-Shift-p', preventDefault: true, run: () => (latest.current.onTogglePreview(), true) },
        { key: 'Mod-b', preventDefault: true, run: wrap('**') },
        { key: 'Mod-i', preventDefault: true, run: wrap('*') },
        { key: 'Mod-k', preventDefault: true, run: link },
      ]),
    );

    const state = EditorState.create({
      doc: latest.current.initialValue,
      extensions: [
        keys,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlighting),
        EditorView.lineWrapping,
        placeholder('Write in Markdown. Paste or drop an image to upload it. Press Ctrl+Shift+P to hide or show the preview.'),
        EditorView.contentAttributes.of({ 'aria-label': 'Article body in Markdown', 'aria-multiline': 'true', spellcheck: 'true' }),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const { from, to } = update.state.selection.main;
            latest.current.onSelectionChange?.(from === to ? null : { start: from, end: to, text: update.state.sliceDoc(from, to) });
          }
        }),
        EditorView.domEventHandlers({
          paste(event, v) {
            const files = Array.from(event.clipboardData?.files ?? []).filter(isImage);
            if (files.length === 0) return false;
            event.preventDefault();
            void uploadAll(files, v.state.selection.main.head);
            return true;
          },
          drop(event, v) {
            const files = Array.from(event.dataTransfer?.files ?? []).filter(isImage);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head;
            void uploadAll(files, at);
            return true;
          },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;

    const onScroll = () => {
      const scroller = v.scrollDOM;
      const room = scroller.scrollHeight - scroller.clientHeight;
      latest.current.onScroll?.(room > 0 ? scroller.scrollTop / room : 0);
    };
    v.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

    // The picker in the toolbar goes through the same path as paste and drop.
    const input = fileInput.current;
    const onPick = () => {
      const files = Array.from(input?.files ?? []).filter(isImage);
      if (input) input.value = '';
      if (files.length) void uploadAll(files, v.state.selection.main.head);
    };
    input?.addEventListener('change', onPick);

    return () => {
      input?.removeEventListener('change', onPick);
      v.scrollDOM.removeEventListener('scroll', onScroll);
      v.destroy();
      view.current = null;
    };
  }, []);

  const buttons: (ToolbarButton | 'sep')[] = [
    { label: 'Heading', icon: Heading2, run: heading },
    { label: 'Bold', shortcut: `${mod}B`, icon: Bold, run: wrap('**') },
    { label: 'Italic', shortcut: `${mod}I`, icon: Italic, run: wrap('*') },
    { label: 'Link', shortcut: `${mod}K`, icon: Link2, run: link },
    'sep',
    { label: 'Inline code', icon: Code, run: wrap('`', '`', 'code') },
    { label: 'Code block', icon: FileCode, run: codeBlock },
    { label: 'Quote', icon: Quote, run: quote },
    'sep',
    { label: 'Bulleted list', icon: List, run: bullets },
    { label: 'Numbered list', icon: ListOrdered, run: numbers },
    { label: 'Task list', icon: ListChecks, run: tasks },
    'sep',
    { label: 'Table', icon: Table2, run: table },
    { label: 'Diagram (Mermaid)', icon: Workflow, run: diagram },
  ];

  return (
    <div className={cn('flex h-full min-h-0 flex-col', props.className)}>
      <div role="toolbar" aria-label="Formatting" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-card px-2 py-1.5">
        {buttons.map((button, i) =>
          button === 'sep' ? (
            <span key={`sep-${i}`} aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
          ) : (
            <button
              key={button.label}
              type="button"
              title={button.shortcut ? `${button.label} (${button.shortcut})` : button.label}
              aria-label={button.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => view.current && button.run(view.current)}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <button.icon aria-hidden className="size-4" />
            </button>
          ),
        )}
        <button
          type="button"
          title="Upload an image"
          aria-label="Upload an image"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fileInput.current?.click()}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ImagePlus aria-hidden className="size-4" />
        </button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" multiple hidden tabIndex={-1} aria-hidden />
      </div>
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
});
