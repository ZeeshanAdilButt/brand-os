/**
 * A line diff for comparing two versions of an article. Pure, no dependencies.
 * Myers' O(ND) algorithm over lines, after trimming the common start and end. Very different texts
 * (more than MAX_EDITS changed lines) fall back to "everything between the common start and end was
 * replaced", which is correct if less fine-grained.
 */

export type DiffKind = 'equal' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old text (not for added lines). */
  oldNo: number | null;
  /** 1-based line number in the new text (not for deleted lines). */
  newNo: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
}

const MAX_EDITS = 1500;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline does not make an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Edit script between two line arrays: for each position, equal / delete (from a) / add (from b). */
function myers(a: string[], b: string[]): { kind: DiffKind; a?: number; b?: number }[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Walk the trace backwards to recover the path.
        const script: { kind: DiffKind; a?: number; b?: number }[] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd >= 0; dd--) {
          const prev = trace[dd]!;
          const ck = cx - cy;
          const down = ck === -dd || (ck !== dd && prev[offset + ck - 1]! < prev[offset + ck + 1]!);
          const pk = down ? ck + 1 : ck - 1;
          const px = prev[offset + pk]!;
          const py = px - pk;
          while (cx > px && cy > py) {
            cx -= 1;
            cy -= 1;
            script.push({ kind: 'equal', a: cx, b: cy });
          }
          if (dd > 0) {
            if (down) script.push({ kind: 'add', b: py });
            else script.push({ kind: 'del', a: px });
          }
          cx = px;
          cy = py;
        }
        return script.reverse();
      }
    }
  }
  return null;
}

/** Diff two texts line by line. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'equal', text: a[i]!, oldNo: i + 1, newNo: i + 1 });

  const script = midA.length === 0 || midB.length === 0 ? null : myers(midA, midB);
  if (script) {
    for (const step of script) {
      if (step.kind === 'equal') out.push({ kind: 'equal', text: midA[step.a!]!, oldNo: start + step.a! + 1, newNo: start + step.b! + 1 });
      else if (step.kind === 'del') out.push({ kind: 'del', text: midA[step.a!]!, oldNo: start + step.a! + 1, newNo: null });
      else out.push({ kind: 'add', text: midB[step.b!]!, oldNo: null, newNo: start + step.b! + 1 });
    }
  } else {
    midA.forEach((text, i) => out.push({ kind: 'del', text, oldNo: start + i + 1, newNo: null }));
    midB.forEach((text, i) => out.push({ kind: 'add', text, oldNo: null, newNo: start + i + 1 }));
  }

  const tailA = a.length - endA;
  for (let i = 0; i < tailA; i++) out.push({ kind: 'equal', text: a[endA + i]!, oldNo: endA + i + 1, newNo: endB + i + 1 });
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
  }
  return { added, removed };
}

export type DiffRow = DiffLine | { kind: 'gap'; hidden: number };

/** Hide long runs of unchanged lines, keeping `context` lines around every change. */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === 'equal') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (hidden > 0) {
        rows.push({ kind: 'gap', hidden });
        hidden = 0;
      }
      rows.push(line);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) rows.push({ kind: 'gap', hidden });
  return rows;
}

export interface WordSegment {
  kind: DiffKind;
  text: string;
}

const NEWLINE_MARK = '\u21b5';

/**
 * Diff two texts word by word (runs of non-space and runs of space are the units), for showing a rewritten
 * paragraph inline. Adjacent pieces of the same kind are joined. Built on the line diff by giving every
 * token its own line.
 */
export function diffWords(oldText: string, newText: string): WordSegment[] {
  const tokens = (text: string) => (text.match(/\s+|\S+/g) ?? []).map((t) => t.replace(/\r?\n/g, NEWLINE_MARK));
  const lines = diffLines(tokens(oldText).join('\n'), tokens(newText).join('\n'));
  const out: WordSegment[] = [];
  for (const line of lines) {
    const text = line.text.split(NEWLINE_MARK).join('\n');
    const last = out[out.length - 1];
    if (last && last.kind === line.kind) last.text += text;
    else out.push({ kind: line.kind, text });
  }
  return out;
}
