'use client';

import { GitCompare, History, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { REASON_LABELS, type VersionDTO, type VersionSummaryDTO } from '@/lib/articles';
import { api } from '@/lib/api-client';
import { diffLines, diffStats } from '@/lib/diff';
import { DiffStatChips, DiffView } from './diff-view';

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return RTF.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return RTF.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86_400 * 30) return RTF.format(Math.round(seconds / 86_400), 'day');
  return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

const absolute = (iso: string) => new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
const CURRENT = 'current';
type Side = number | typeof CURRENT;

interface Props {
  articleId: string;
  /** Changes whenever a save is confirmed, so the list refreshes. */
  refreshKey: number;
  current: { title: string; body: string };
  /** Restoring is paused while a conflict or an unsent change is being sorted out. */
  restoreDisabled: boolean;
  onRestore(versionNo: number): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function HistoryPanel({ articleId, refreshKey, current, restoreDisabled, onRestore }: Props) {
  const [versions, setVersions] = useState<VersionSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ from: Side; to: Side } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(async () => {
      const result = await api<{ versions: VersionSummaryDTO[] }>(`/api/articles/${articleId}/versions`);
      if (!live) return;
      if (result.ok) {
        setVersions(result.data.versions);
        setError(null);
      } else {
        setError(result.network ? 'Could not load the history while offline.' : result.error);
      }
    }, versions === null ? 0 : 700);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // Reload on every confirmed save; `versions` only decides the first, immediate load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, refreshKey]);

  const shown = versions && !showAll ? versions.slice(0, 30) : (versions ?? []);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every save is kept. Autosaves from one sitting are folded into a single entry; saves you make with Ctrl+S, imports and restores each get their own. Restoring never
        deletes anything: it adds a new version.
      </p>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {versions === null && !error ? <p className="text-sm text-muted-foreground">Loading history...</p> : null}
      {versions && versions.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
          <History aria-hidden className="mb-2 size-5" />
          No versions yet. The first one appears after your first save.
        </div>
      ) : null}
      <ol className="grid gap-2">
        {shown.map((version, index) => (
          <li key={version.id} className="rounded-lg border bg-background p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">Version {version.versionNo}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{REASON_LABELS[version.reason]}</span>
              {index === 0 ? <span className="text-xs text-muted-foreground">Latest</span> : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground" title={absolute(version.createdAt)}>
              {relativeTime(version.createdAt)} · {version.chars.toLocaleString('en')} characters
            </p>
            <p className="mt-1 truncate text-sm" title={version.title}>
              {version.title || 'Untitled'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button type="button" size="xs" variant="outline" onClick={() => setCompare({ from: version.versionNo, to: CURRENT })}>
                <GitCompare aria-hidden />
                Compare
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={restoreDisabled} onClick={() => setCompare({ from: version.versionNo, to: CURRENT })}>
                <RotateCcw aria-hidden />
                Restore
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {versions && versions.length > 30 && !showAll ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll(true)}>
          Show all {versions.length} versions
        </Button>
      ) : null}

      {compare && versions ? (
        <CompareDialog
          articleId={articleId}
          versions={versions}
          current={current}
          initial={compare}
          restoreDisabled={restoreDisabled}
          onClose={() => setCompare(null)}
          onRestore={onRestore}
        />
      ) : null}
    </div>
  );
}

function CompareDialog({
  articleId,
  versions,
  current,
  initial,
  restoreDisabled,
  onClose,
  onRestore,
}: {
  articleId: string;
  versions: VersionSummaryDTO[];
  current: { title: string; body: string };
  initial: { from: Side; to: Side };
  restoreDisabled: boolean;
  onClose(): void;
  onRestore: Props['onRestore'];
}) {
  const [from, setFrom] = useState<Side>(initial.from);
  const [to, setTo] = useState<Side>(initial.to);
  const [loaded, setLoaded] = useState<Record<number, VersionDTO>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const requested = useRef(new Set<number>());

  const need = useMemo(() => [from, to].filter((s): s is number => s !== CURRENT), [from, to]);
  const load = useCallback(
    async (no: number) => {
      if (requested.current.has(no)) return;
      requested.current.add(no);
      const result = await api<VersionDTO>(`/api/articles/${articleId}/versions/${no}`);
      if (result.ok) setLoaded((prev) => ({ ...prev, [no]: result.data }));
      else {
        requested.current.delete(no);
        setLoadError(result.error);
      }
    },
    [articleId],
  );
  useEffect(() => {
    need.forEach((no) => void load(no));
  }, [need, load]);

  const content = (side: Side): { title: string; body: string } | null => {
    if (side === CURRENT) return current;
    const version = loaded[side];
    return version ? { title: version.title, body: version.body } : null;
  };
  const a = content(from);
  const b = content(to);
  const stats = useMemo(() => (a && b ? diffStats(diffLines(a.body, b.body)) : null), [a, b]);
  const label = (side: Side) => {
    if (side === CURRENT) return 'Current text';
    const v = versions.find((x) => x.versionNo === side);
    return v ? `Version ${v.versionNo} · ${REASON_LABELS[v.reason]} · ${relativeTime(v.createdAt)}` : `Version ${side}`;
  };

  async function restore() {
    if (typeof from !== 'number') return;
    setRestoring(true);
    setRestoreError(null);
    const result = await onRestore(from);
    setRestoring(false);
    if (result.ok) onClose();
    else setRestoreError(result.error);
  }

  const options: Side[] = [CURRENT, ...versions.map((v) => v.versionNo)];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] gap-3 overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Compare versions</DialogTitle>
          <DialogDescription>Lines in red are in the left version only; lines in green are in the right one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            From
            <Select value={String(from)} onChange={(e) => setFrom(e.target.value === CURRENT ? CURRENT : Number(e.target.value))}>
              {options.map((side) => (
                <option key={String(side)} value={String(side)}>
                  {label(side)}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            To
            <Select value={String(to)} onChange={(e) => setTo(e.target.value === CURRENT ? CURRENT : Number(e.target.value))}>
              {options.map((side) => (
                <option key={String(side)} value={String(side)}>
                  {label(side)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : null}
        {a && b ? (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {stats ? <DiffStatChips added={stats.added} removed={stats.removed} /> : null}
              {a.title !== b.title ? (
                <span className="text-muted-foreground">
                  Title: &ldquo;{a.title || 'Untitled'}&rdquo; to &ldquo;{b.title || 'Untitled'}&rdquo;
                </span>
              ) : null}
            </div>
            <DiffView oldText={a.body} newText={b.body} className="max-h-[50dvh] overflow-y-auto" />
          </>
        ) : (
          !loadError && <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {restoreError ? (
          <p role="alert" className="text-sm text-destructive">
            {restoreError}
          </p>
        ) : null}
        <DialogFooter className="items-center gap-2 sm:gap-2">
          {typeof from === 'number' && to === CURRENT ? (
            confirming ? (
              <>
                <span className="text-sm text-muted-foreground sm:mr-auto">Put version {from} back as the current text? Your current text stays in the history.</span>
                <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={restoring}>
                  Cancel
                </Button>
                <Button type="button" onClick={restore} disabled={restoring || restoreDisabled}>
                  {restoring ? 'Restoring...' : `Restore version ${from}`}
                </Button>
              </>
            ) : (
              <>
                {restoreDisabled ? <span className="text-xs text-muted-foreground sm:mr-auto">Resolve the save problem first, then restore.</span> : null}
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button type="button" onClick={() => setConfirming(true)} disabled={restoreDisabled}>
                  <RotateCcw aria-hidden />
                  Restore version {from}
                </Button>
              </>
            )
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
