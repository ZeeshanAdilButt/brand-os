import type { DraftStatus, PlatformId, PublishedVia } from './publishing';

/**
 * The guided path: write or import, pick destinations, preview each, approve, share the link. The steps and the
 * single next action are computed from the real state (what articles and destinations exist, what each draft
 * says) and nothing else. There is no stored "progress" that could disagree with what is actually true.
 */

export type StepId = 'write' | 'pick' | 'preview' | 'approve' | 'share';

export interface JourneyDestination {
  platform: PlatformId;
  name: string;
  added: boolean;
  publishable: boolean;
  connected: boolean;
  draft: {
    status: DraftStatus;
    publishedVia: PublishedVia | null;
    lintErrors: number;
  } | null;
}

export interface JourneyInput {
  /** How many articles the owner has (not archived). */
  articleCount: number;
  /** The article this journey is about, or null when there is none. */
  article: { id: string; title: string; hasText: boolean } | null;
  /** The owner’s destinations for that article, in their order. Entries that are not added are ignored. */
  destinations: JourneyDestination[];
}

export interface JourneyStep {
  id: StepId;
  label: string;
  detail: string;
  state: 'done' | 'current' | 'todo';
}

export interface NextAction {
  label: string;
  href: string;
  /** One sentence on why this is the next thing. */
  why: string;
}

export interface Journey {
  steps: JourneyStep[];
  next: NextAction;
  /** Every destination the owner added is published or posted by hand. */
  allDone: boolean;
}

export const publishHref = (articleId: string, query: Record<string, string> = {}): string => {
  const search = new URLSearchParams(query).toString();
  return `/articles/${articleId}/publish${search ? `?${search}` : ''}`;
};

const STEP_LABELS: Record<StepId, string> = {
  write: 'Write or import an article',
  pick: 'Pick destinations',
  preview: 'Preview each one',
  approve: 'Approve',
  share: 'Share the link',
};

/** Which destination needs the owner next, and what to do about it. */
function nextForDestination(articleId: string, d: JourneyDestination): NextAction | null {
  const draft = d.draft;
  if (!draft) return { label: `Preview ${d.name}`, href: publishHref(articleId, { step: '2', d: d.platform }), why: `${d.name} has not been prepared yet. Preparing sends nothing.` };
  if (draft.status === 'published') return null;
  if (draft.status === 'unknown') return { label: `Check ${d.name} on the platform`, href: publishHref(articleId, { step: '3', d: d.platform }), why: 'The last publish has an unknown result. Checking only reads.' };
  if (draft.status === 'failed') return { label: `Fix and try ${d.name} again`, href: publishHref(articleId, { step: '3', d: d.platform }), why: 'The platform refused it, so nothing went out.' };
  if (draft.status === 'source_changed') return { label: `Rebuild ${d.name} from the changed article`, href: publishHref(articleId, { step: '2', d: d.platform }), why: 'The article changed after this was built, so any approval is void.' };
  if (draft.lintErrors > 0) {
    return { label: `Fix ${draft.lintErrors} ${draft.lintErrors === 1 ? 'problem' : 'problems'} in ${d.name}`, href: publishHref(articleId, { step: '2', d: d.platform }), why: 'A problem blocks approval until it is fixed.' };
  }
  if (!d.publishable) return { label: `Post ${d.name} by hand and record the link`, href: publishHref(articleId, { step: '3', d: d.platform }), why: `${d.name} cannot be published from here yet. You copy it and post it, then record the link.` };
  if (!d.connected) return { label: `Connect ${d.name}`, href: `/settings/integrations#${d.platform}`, why: `${d.name} needs your account before it can be staged and published.` };
  return { label: `Review and approve ${d.name}`, href: publishHref(articleId, { step: '3', d: d.platform }), why: 'Nothing goes out until you approve the exact post.' };
}

export function computeJourney(input: JourneyInput): Journey {
  const { article } = input;
  const added = input.destinations.filter((d) => d.added);
  const hasText = Boolean(article?.hasText);
  const picked = added.length > 0;
  const prepared = picked && added.every((d) => d.draft !== null);
  const published = picked && added.every((d) => d.draft?.status === 'published');

  const done: Record<StepId, boolean> = {
    write: hasText,
    pick: hasText && picked,
    preview: hasText && prepared,
    approve: hasText && published,
    // Sharing is the end of the path: it is current once everything is out, and nothing records that it was done.
    share: false,
  };
  const order: StepId[] = ['write', 'pick', 'preview', 'approve', 'share'];
  const currentIndex = order.findIndex((id) => !done[id]);
  const steps: JourneyStep[] = order.map((id, i) => ({
    id,
    label: STEP_LABELS[id],
    detail: stepDetail(id, input, added),
    state: done[id] ? 'done' : i === currentIndex ? 'current' : 'todo',
  }));

  let next: NextAction;
  if (input.articleCount === 0 || !article) {
    next = { label: 'Write or import an article', href: '/articles/import', why: 'Everything starts from one article. Import a Markdown file or a page, or start from a blank one.' };
  } else if (!hasText) {
    next = { label: `Add text to “${article.title || 'your article'}”`, href: `/articles/${article.id}`, why: 'The article is empty, so there is nothing to publish yet.' };
  } else if (!picked) {
    next = { label: 'Pick destinations', href: publishHref(article.id), why: 'Choose where this article should go. Choosing sends nothing.' };
  } else if (published) {
    next = { label: 'Copy your live links', href: publishHref(article.id, { step: '4' }), why: 'Everything you added is out. Share the links.' };
  } else {
    next = nextAfter(article.id, added) ?? { label: 'Open the publishing screen', href: publishHref(article.id), why: 'Review where each destination stands.' };
  }
  return { steps, next, allDone: published };
}

function nextAfter(articleId: string, added: JourneyDestination[]): NextAction | null {
  // Anything not prepared comes first so every destination is previewed before the first approval.
  const unprepared = added.find((d) => d.draft === null);
  if (unprepared) return nextForDestination(articleId, unprepared);
  for (const d of added) {
    const action = nextForDestination(articleId, d);
    if (action) return action;
  }
  return null;
}

function stepDetail(id: StepId, input: JourneyInput, added: JourneyDestination[]): string {
  switch (id) {
    case 'write':
      return input.article?.hasText ? `“${input.article.title || 'Untitled'}” has text.` : input.articleCount === 0 ? 'No article yet.' : 'The article is empty.';
    case 'pick':
      return added.length === 0 ? 'No destinations yet.' : `${added.length} ${added.length === 1 ? 'destination' : 'destinations'} chosen.`;
    case 'preview': {
      const ready = added.filter((d) => d.draft).length;
      return added.length === 0 ? 'Nothing to preview yet.' : `${ready} of ${added.length} prepared.`;
    }
    case 'approve': {
      const out = added.filter((d) => d.draft?.status === 'published').length;
      return added.length === 0 ? 'Nothing to approve yet.' : `${out} of ${added.length} published or posted.`;
    }
    case 'share':
      return added.length > 0 && added.every((d) => d.draft?.status === 'published') ? 'Copy the links and tell people.' : 'Available once everything is out.';
  }
}
