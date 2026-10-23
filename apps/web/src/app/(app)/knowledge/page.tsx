import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Plus, Search, ShieldAlert } from 'lucide-react';
import { BranchArt } from '@/components/brand/branch-art';
import { ConfidentialityBadge, KindBadge, PublicUseBadge, VerificationBadge } from '@/components/knowledge/badges';
import { ReviewButton } from '@/components/knowledge/item-actions';
import { MarkedText } from '@/components/knowledge/marked-text';
import { PageHeader } from '@/components/page-header';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import {
  CONFIDENTIALITY_LABELS,
  CONFIDENTIALITY_LEVELS,
  ITEM_KINDS,
  KIND_LABELS,
  VERIFICATION_LABELS,
  VERIFICATION_STATUSES,
} from '@/lib/knowledge';
import { cn } from '@/lib/utils';
import { itemCounts, listItems } from '@/server/actions/knowledge';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : value;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function href(params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ''));
  const s = query.toString();
  return s ? `/knowledge?${s}` : '/knowledge';
}

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const raw = await searchParams;
  const q = first(raw.q).trim();
  const kind = first(raw.kind);
  const confidentiality = first(raw.confidentiality);
  const status = first(raw.status);
  const page = Math.max(1, Number.parseInt(first(raw.page), 10) || 1);
  const filtered = Boolean(q || kind || confidentiality || status);

  const counts = await itemCounts(owner);
  let items: Awaited<ReturnType<typeof listItems>> | null = null;
  let problem: string | null = null;
  try {
    items = await listItems(owner, {
      q,
      kind,
      confidentiality,
      verificationStatus: status,
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    });
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    problem = 'One of the filters is not valid. Reset the filters and try again.';
  }
  const hasMore = (items?.items.length ?? 0) > PAGE_SIZE;
  const shown = items ? items.items.slice(0, PAGE_SIZE) : [];
  const hitById = new Map(items?.hits?.map((h) => [h.item.id, h]) ?? []);
  const base = { q, kind, confidentiality, status };
  const more = hasMore || page > 1 ? '+' : '';
  const noun = (n: number, one: string, many: string) => (n === 1 && !more ? one : many);
  const summary = q
    ? `${shown.length}${more} ranked ${noun(shown.length, 'result', 'results')} for "${q}"`
    : filtered
      ? `${shown.length}${more} matching ${noun(shown.length, 'item', 'items')}`
      : `${counts.total} ${counts.total === 1 ? 'item' : 'items'}`;

  return (
    <>
      <PageHeader
        eyebrow="Knowledge"
        title="Your private source material"
        description="The experience, notes and facts your articles draw on. Each item records where it came from, how sure you are, and whether it may be used in public writing."
      >
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href="/knowledge/new" className={buttonVariants()}>
            <Plus aria-hidden />
            Add item
          </Link>
          <Link href="/onboarding" className={buttonVariants({ variant: 'outline' })}>
            Set up your profile
          </Link>
        </div>
      </PageHeader>

      {counts.needsReview > 0 && status !== 'owner_claim_needs_review' ? (
        <Link
          href={href({ status: 'owner_claim_needs_review' })}
          className="mb-6 flex items-center gap-3 rounded-xl border border-warning/50 bg-warning/10 p-4 transition-colors hover:bg-warning/15"
        >
          <ShieldAlert aria-hidden className="size-5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-sm leading-relaxed">
            <span className="font-medium">
              {counts.needsReview} {counts.needsReview === 1 ? 'item needs' : 'items need'} review.
            </span>{' '}
            <span className="text-muted-foreground">
              These are claims awaiting your confirmation. Nothing here is used in public writing until you review it and allow it.
            </span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ) : null}

      {counts.total > 0 || filtered ? (
        <form method="get" action="/knowledge" role="search" className="mb-6 grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[1fr_9rem_9rem_10rem_auto]">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={q} placeholder="Search titles, details and tags" aria-label="Search your knowledge" className="pl-9" maxLength={200} />
          </div>
          <Select name="kind" defaultValue={kind} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <Select name="confidentiality" defaultValue={confidentiality} aria-label="Filter by confidentiality">
            <option value="">Any privacy</option>
            {CONFIDENTIALITY_LEVELS.map((c) => (
              <option key={c} value={c}>
                {CONFIDENTIALITY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={status} aria-label="Filter by verification">
            <option value="">Any verification</option>
            {VERIFICATION_STATUSES.map((v) => (
              <option key={v} value={v}>
                {VERIFICATION_LABELS[v]}
              </option>
            ))}
          </Select>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
            <Button type="submit" className="flex-1 lg:flex-none">
              Apply
            </Button>
            {filtered ? (
              <Link href="/knowledge" className={buttonVariants({ variant: 'ghost' })}>
                Reset
              </Link>
            ) : null}
          </div>
        </form>
      ) : null}

      {problem ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p> : null}

      {!problem && counts.total === 0 && !filtered ? (
        <section className="rounded-xl border bg-surface p-6 text-center sm:p-10">
          <BranchArt branches={4} className="mx-auto mb-4 h-20 w-auto" />
          <h2 className="text-2xl font-semibold">Nothing here yet</h2>
          <p className="mx-auto mt-2 max-w-xl leading-relaxed text-muted-foreground">
            Add what your writing should be built on: projects, results with their numbers, reading notes, certifications. Every item starts private and
            unverified, and stays out of public writing until you allow it.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href="/knowledge/new" className={buttonVariants()}>
              <Plus aria-hidden />
              Add your first item
            </Link>
            <Link href="/onboarding" className={buttonVariants({ variant: 'outline' })}>
              Guided setup
            </Link>
          </div>
        </section>
      ) : null}

      {!problem && items && shown.length === 0 && (counts.total > 0 || filtered) ? (
        <section className="rounded-xl border border-input bg-card/60 p-8 text-center">
          <h2 className=" text-xl font-semibold">{q ? 'No matches' : 'No items match these filters'}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {q
              ? 'Search looks at titles, details and tags, and matches word stems (run finds running). Try fewer or different words.'
              : 'Try a different combination, or reset the filters.'}
          </p>
          <Link href="/knowledge" className={cn(buttonVariants({ variant: 'outline' }), 'mt-5')}>
            Reset filters
          </Link>
        </section>
      ) : null}

      {shown.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
            {summary}
          </p>
          <ul className="grid gap-3">
            {shown.map((item) => {
              const hit = hitById.get(item.id);
              const date = formatDate(item.sourceDate);
              const reviewed = formatDate(item.lastReviewedAt);
              return (
                <li key={item.id} className="rounded-xl border bg-card p-4 shadow-xs sm:p-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <KindBadge kind={item.kind} />
                    <VerificationBadge status={item.verificationStatus} />
                    <ConfidentialityBadge level={item.confidentiality} />
                    <PublicUseBadge permitted={item.publicUsePermitted} />
                  </div>
                  <h2 className="mt-3  text-lg font-semibold leading-snug">
                    <Link href={`/knowledge/${item.id}`} className="rounded-sm hover:underline">
                      {hit ? <MarkedText text={hit.titleMarked} /> : item.title}
                    </Link>
                  </h2>
                  {hit ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      <MarkedText text={hit.snippet} />
                    </p>
                  ) : item.body ? (
                    <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    {item.tags.length > 0 ? (
                      <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
                        {item.tags.map((tag) => (
                          <li key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">
                            {tag}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {date ? <span>Dated {date}</span> : null}
                    <span>{reviewed ? `Reviewed ${reviewed}` : 'Never reviewed'}</span>
                    <span className="sm:ml-auto flex items-center gap-2">
                      {item.verificationStatus !== 'verified' ? <ReviewButton id={item.id} /> : null}
                      <Link href={`/knowledge/${item.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                        Edit
                      </Link>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {page > 1 || hasMore ? (
            <nav aria-label="Pagination" className="mt-6 flex items-center justify-between">
              {page > 1 ? (
                <Link href={href({ ...base, page: String(page - 1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  <ChevronLeft aria-hidden />
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-muted-foreground">Page {page}</span>
              {hasMore ? (
                <Link href={href({ ...base, page: String(page + 1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Next
                  <ChevronRight aria-hidden />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : null}
    </>
  );
}
