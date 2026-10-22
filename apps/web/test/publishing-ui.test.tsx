// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalReview, type SiteFacts } from '../src/components/publish/approval-review';
import { usePublish } from '../src/components/publish/use-publish';
import { PLATFORMS, approvalChecklist, type ApprovalDTO, type ConnectionDTO, type DestinationDTO, type PlatformDraftDTO, type PlatformId } from '../src/lib/publishing';

afterEach(cleanup);

const ARTICLE = '22222222-2222-4222-8222-222222222222';
const FACTS: SiteFacts = { siteHost: 'example-blog.dev', repo: null, baseBranch: 'main' };

const connection = (platform: PlatformId = 'devto', over: Partial<ConnectionDTO> = {}): ConnectionDTO => ({
  id: '33333333-3333-4333-8333-333333333333',
  platform,
  status: 'connected',
  who: '@writer',
  keyLast4: '0a1b',
  config: {},
  lastCheckedAt: '2026-10-21T10:00:00.000Z',
  lastCheckMessage: null,
  createdAt: '2026-10-21T09:00:00.000Z',
  ...over,
});

const PAYLOAD = { title: 'Write path stalls', description: 'Short.', tags: ['go', 'queues'], canonicalUrl: 'https://example-blog.dev/p/stalls', coverImageUrl: null, series: null, bodyMarkdown: 'Body text.' };

function approval(over: Partial<ApprovalDTO> = {}): ApprovalDTO {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    status: 'pending',
    tag: '#AAAAAAAA',
    payloadSha256: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    invalidReason: null,
    requestedBy: 'owner',
    kind: 'publish',
    checklist: approvalChecklist('DEV.to', true),
    ...over,
  };
}

function draft(over: Partial<PlatformDraftDTO> = {}): PlatformDraftDTO {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    articleId: ARTICLE,
    platform: 'devto',
    status: 'staged',
    stale: false,
    payload: PAYLOAD,
    payloadSha256: 'a'.repeat(64),
    requestPreview: '{\n  "article": {\n    "title": "Write path stalls",\n    "published": true\n  }\n}',
    tagReport: { original: ['Go', 'queues'], sent: ['go', 'queues'], changes: [] },
    lint: [],
    account: '@writer',
    sourceRevision: 3,
    remoteId: '1001',
    remoteUrl: null,
    remotePreviewUrl: 'https://dev.to/writer/preview-1001',
    failureKind: null,
    failureMessage: null,
    nextAction: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:05:00.000Z',
    stagedAt: '2026-10-21T10:05:00.000Z',
    publishedAt: null,
    approval: null,
    attempts: [],
    generated: PAYLOAD,
    divergence: { edited: [], fromSource: [] },
    extras: {},
    remoteInfo: null,
    publishedVia: null,
    editedAt: null,
    editCount: 0,
    canonical: null,
    ...over,
  };
}

function destination(platform: PlatformId, over: Partial<DestinationDTO> = {}): DestinationDTO {
  return { platform, info: PLATFORMS[platform], connection: platform === 'devto' ? connection() : null, draft: null, added: true, position: 0, siteReady: null, ...over };
}

/** Records every request the screen makes, and answers the few the tests care about. */
function serve(answers: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = Object.entries(answers).find(([suffix]) => url.endsWith(suffix));
      // An array answers one call after another, repeating the last.
      const answer = hit ? (Array.isArray(hit[1]) ? (hit[1].length > 1 ? hit[1].shift() : hit[1][0]) : hit[1]) : {};
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
  return calls;
}

function Harness({ data, platform = 'devto', onEdit }: { data: DestinationDTO[]; platform?: PlatformId; onEdit?: () => void }) {
  const api = usePublish(ARTICLE, data);
  const d = api.destinations.find((x) => x.platform === platform)!;
  return <ApprovalReview destination={d} api={api} facts={FACTS} {...(onEdit ? { onEdit } : {})} />;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('reviewing one destination', () => {
  it('says the destination is not connected, links to connecting, and offers no stage button', () => {
    serve();
    render(<Harness data={[destination('devto', { connection: null, draft: draft({ status: 'draft' }) })]} />);
    expect(screen.getByText('DEV.to is not connected')).toBeTruthy();
    expect(screen.getByRole('link', { name: /connect dev\.to/i }).getAttribute('href')).toBe('/platforms/integrations#devto');
    expect(screen.queryByRole('button', { name: /create private draft/i })).toBeNull();
  });

  it('blocks staging and approval while a problem stands, and offers a way back to fix it', () => {
    serve();
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} data={[destination('devto', { draft: draft({ status: 'draft', lint: [{ code: 'image_local', severity: 'error', message: 'This image only exists on your machine; use a public URL.', items: ['asset:abc'] }] }) })]} />);
    expect(screen.getByText(/only exists on your machine/)).toBeTruthy();
    expect(screen.getByText('asset:abc')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create private draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /go back and fix/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('creates a private draft only on an explicit click, and says it is not public', async () => {
    const calls = serve({ '/stage': { ok: true, message: 'Private draft created.', draft: draft({ status: 'draft' }) } });
    render(<Harness data={[destination('devto', { draft: draft({ status: 'draft' }) })]} />);
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/but it is not public/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /create private draft on dev\.to/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/stage') && c.method === 'POST')).toBe(true));
  });

  it('arriving at a staged post creates its one approval request, once', async () => {
    const calls = serve({ '/request-approval': { link: '/x', draft: draft({ status: 'pending_approval', approval: approval() }) } });
    render(<Harness data={[destination('devto', { draft: draft({ status: 'staged' }) })]} />);
    await waitFor(() => expect(screen.getByRole('region', { name: /approve this exact post/i })).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith('/request-approval'))).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
  });

  it('a staged post whose account is no longer connected asks for nothing on load: no request, no conflict', async () => {
    const calls = serve();
    render(<Harness data={[destination('devto', { connection: null, draft: draft({ status: 'staged' }) })]} />);
    expect(screen.getByText('DEV.to is not connected')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it('staging again after a refusal is a new private copy and gets its own approval request', async () => {
    const calls = serve({
      '/stage': [
        { ok: true, message: 'Private draft created.', draft: draft({ status: 'staged', stagedAt: '2026-10-21T10:06:00.000Z' }) },
        { ok: true, message: 'Private draft updated.', draft: draft({ status: 'staged', stagedAt: '2026-10-21T10:09:00.000Z' }) },
      ],
      '/request-approval': [
        { link: '/x', draft: draft({ status: 'failed', failureMessage: 'DEV.to refused the request.', failureKind: 'validation' }) },
        { link: '/x', draft: draft({ status: 'pending_approval', approval: approval() }) },
      ],
    });
    render(<Harness data={[destination('devto', { draft: draft({ status: 'draft' }) })]} />);
    fireEvent.click(screen.getByRole('button', { name: /create private draft on dev.to/i }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/request-approval'))).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /create private draft on dev.to/i }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/request-approval'))).toHaveLength(2));
    await screen.findByRole('region', { name: /approve this exact post/i });
  });

  it('shows the approval card with the exact payload and a checklist that gates the one button', async () => {
    const calls = serve({
      '/approve': { outcome: 'published', message: 'Published on DEV.to.', draft: draft({ status: 'published', remoteUrl: 'https://dev.to/writer/stalls-1001' }) },
    });
    const ask = approval();
    render(<Harness data={[destination('devto', { draft: draft({ status: 'pending_approval', approval: ask }) })]} />);
    const card = screen.getByRole('region', { name: /approve this exact post/i });
    expect(within(card).getByText('#AAAAAAAA')).toBeTruthy();
    expect(within(card).getByLabelText(/request body that will be sent/i).textContent).toContain('"published": true');
    expect(within(card).getByText('@writer')).toBeTruthy();
    expect(within(card).getByText('https://example-blog.dev/p/stalls')).toBeTruthy();

    const button = within(card).getByRole('button', { name: /approve and publish to dev\.to/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const boxes = within(card).getAllByRole('checkbox');
    expect(boxes).toHaveLength(ask.checklist.length);
    boxes.slice(0, -1).forEach((b) => fireEvent.click(b));
    expect(button.disabled).toBe(true);
    fireEvent.click(boxes.at(-1)!);
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/api/approvals/${ask.id}/approve`))).toBe(true));
    const sent = calls.filter((c) => c.url.endsWith('/approve'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ checked: ask.checklist });
  });

  it('a canonical page that is not live adds one more box, and names the reason', () => {
    serve();
    const box = approvalChecklist('DEV.to', true, { canonicalNotLive: true });
    const ask = approval({ checklist: box });
    const canonical = { url: PAYLOAD.canonicalUrl, state: 'not_live' as const, httpStatus: 404, title: null, finalUrl: null, message: 'Your page answers 404.', checkedAt: new Date().toISOString() };
    render(<Harness data={[destination('devto', { draft: draft({ status: 'pending_approval', approval: ask, canonical }) })]} />);
    const card = screen.getByRole('region', { name: /approve this exact post/i });
    expect(within(card).getByText(/The canonical page is not live/)).toBeTruthy();
    expect(within(card).getByLabelText(/I know the canonical page is not live yet/i)).toBeTruthy();
    expect(within(card).getAllByRole('checkbox')).toHaveLength(approvalChecklist('DEV.to', true).length + 1);
  });

  it('an expired request cannot be approved', async () => {
    serve();
    render(<Harness data={[destination('devto', { draft: draft({ status: 'pending_approval', approval: approval({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) }) })]} />);
    const card = screen.getByRole('region', { name: /approve this exact post/i });
    await waitFor(() => expect(within(card).getByText(/has expired/)).toBeTruthy());
    within(card).getAllByRole('checkbox').forEach((b) => expect((b as HTMLInputElement).matches(':disabled')).toBe(true));
    expect((within(card).getByRole('button', { name: /approve and publish/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses the label it is given for the queue button and still approves only this post', () => {
    serve();
    function Labelled() {
      const api = usePublish(ARTICLE, [destination('devto', { draft: draft({ status: 'pending_approval', approval: approval() }) })]);
      return <ApprovalReview destination={api.destinations[0]!} api={api} facts={FACTS} approveLabel="Approve and next" />;
    }
    render(<Labelled />);
    expect(screen.getAllByRole('button', { name: /^approve/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Approve and next' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve all|publish all|approve everything/i })).toBeNull();
  });

  it('a draft whose article changed shows no approval card and asks for a rebuild', () => {
    serve();
    render(<Harness data={[destination('devto', { draft: draft({ status: 'source_changed', stale: true }) })]} />);
    expect(screen.getByText(/You edited the article after this was built/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /approve this exact post/i })).toBeNull();
    expect(screen.getByRole('button', { name: /rebuild from the article/i })).toBeTruthy();
  });

  it('an unknown result offers a read-only check and a confirmed hand mark, never a retry', () => {
    serve();
    render(<Harness data={[destination('devto', { draft: draft({ status: 'unknown', failureKind: 'timeout', failureMessage: 'DEV.to did not answer. The post may or may not be live.', nextAction: 'Use “Check on platform”.' }) })]} />);
    expect(screen.getByRole('button', { name: /check on platform/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create private draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve and publish/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mark by hand/i }));
    const record = screen.getByRole('button', { name: /record this/i }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I checked on the platform myself/i));
    expect(record.disabled).toBe(false);
  });

  it('shows the published link and no more publishing buttons', () => {
    serve();
    render(<Harness data={[destination('devto', { draft: draft({ status: 'published', remoteUrl: 'https://dev.to/writer/stalls-1001', publishedAt: '2026-10-21T10:10:00.000Z' }) })]} />);
    const links = screen.getAllByRole('link', { name: /dev\.to\/writer\/stalls-1001/ });
    expect(links[0]!.getAttribute('href')).toBe('https://dev.to/writer/stalls-1001');
    expect(screen.queryByRole('button', { name: /create private draft|rebuild|approve and publish/i })).toBeNull();
  });
});

describe('posting by hand', () => {
  it('a platform the app cannot send to says so, offers the hand route, and never an approve-and-publish button', () => {
    serve();
    render(<Harness platform="medium" data={[destination('medium', { draft: draft({ platform: 'medium', status: 'draft' }) })]} />);
    expect(screen.getByText(/cannot be published to from here yet/)).toBeTruthy();
    expect(screen.getByRole('region', { name: /post on medium by hand/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy everything/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve and publish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create private draft/i })).toBeNull();
  });

  it('"I posted it" only asks for a manual approval; the record needs a valid link and every box', async () => {
    const manual = approval({ kind: 'manual', checklist: approvalChecklist('Medium', true, { kind: 'manual' }), tag: '#BBBBBBBB' });
    const calls = serve({ '/request-approval': { link: '/x', draft: draft({ platform: 'medium', status: 'draft', approval: manual }) } });
    render(<Harness platform="medium" data={[destination('medium', { draft: draft({ platform: 'medium', status: 'draft' }) })]} />);
    fireEvent.click(screen.getByRole('button', { name: /^i posted it$/i }));
    await waitFor(() => expect(screen.getByText(/Tick every box to record/)).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/request-approval'))!.body).toEqual({ mode: 'manual' });
    const record = screen.getByRole('button', { name: /i posted it: record the link/i }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/link to your post/i), { target: { value: 'https://evil.example.test/x' } });
    expect(screen.getByText(/That address is not on/)).toBeTruthy();
    screen.getAllByRole('checkbox').forEach((b) => fireEvent.click(b));
    expect(record.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/link to your post/i), { target: { value: 'https://medium.com/@writer/stalls-1a2b3c' } });
    expect(record.disabled).toBe(false);
  });
});
