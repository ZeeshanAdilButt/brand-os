// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsManager, type ConnectionView } from '../src/components/publishing/connections-manager';
import { PublishPanel } from '../src/components/publishing/publish-panel';
import { PLATFORMS, approvalChecklist, type ConnectionDTO, type DestinationDTO, type PlatformDraftDTO } from '../src/lib/publishing';

afterEach(cleanup);

const KEY = ['fake', 'ui', 'key', '0a1b2c3d'].join('-');
const ARTICLE = '22222222-2222-4222-8222-222222222222';

const connection = (over: Partial<ConnectionDTO> = {}): ConnectionDTO => ({
  id: '33333333-3333-4333-8333-333333333333',
  platform: 'devto',
  status: 'connected',
  who: '@writer',
  keyLast4: '0a1b',
  config: {},
  lastCheckedAt: '2026-10-21T10:00:00.000Z',
  lastCheckMessage: null,
  createdAt: '2026-10-21T09:00:00.000Z',
  ...over,
});

function draft(over: Partial<PlatformDraftDTO> = {}): PlatformDraftDTO {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    articleId: ARTICLE,
    platform: 'devto',
    status: 'staged',
    stale: false,
    payload: { title: 'Write path stalls', description: 'Short.', tags: ['go', 'queues'], canonicalUrl: 'https://example-blog.dev/p/stalls', coverImageUrl: null, series: null, bodyMarkdown: 'Body text.' },
    payloadSha256: 'a'.repeat(64),
    requestPreview: '{\n  "article": {\n    "title": "Write path stalls",\n    "published": true\n  }\n}',
    tagReport: { original: ['Go', 'queues'], sent: ['go', 'queues'], changes: ['“Go” became “go”.'] },
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
    ...over,
  };
}

function destinations(devto: Partial<DestinationDTO> = {}): DestinationDTO[] {
  return [
    { platform: 'devto', info: PLATFORMS.devto, connection: connection(), draft: null, ...devto },
    { platform: 'hashnode', info: PLATFORMS.hashnode, connection: null, draft: null },
  ];
}

function serve(data: DestinationDTO[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/destinations')) return new Response(JSON.stringify({ destinations: data }), { status: 200 });
    if (url.endsWith('/approve')) return new Response(JSON.stringify({ outcome: 'published', message: 'Published on DEV.to.', draft: draft({ status: 'published', remoteUrl: 'https://dev.to/writer/stalls-1001' }) }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('the connections page', () => {
  const views = (connected: ConnectionDTO | null): ConnectionView[] => [
    { platform: 'devto', info: PLATFORMS.devto, connection: connected },
    { platform: 'hashnode', info: PLATFORMS.hashnode, connection: null },
  ];

  it('takes the key only in a password field, empty, with autofill off', () => {
    render(<ConnectionsManager initial={views(null)} />);
    const field = screen.getByLabelText(/DEV Community API key/i) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect((screen.getByRole('button', { name: /connect dev\.to/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what each platform can and cannot do, and marks Hashnode live-unverified', () => {
    render(<ConnectionsManager initial={views(null)} />);
    expect(screen.getByText('Live-unverified')).toBeTruthy();
    expect(screen.getByText('Live check pending')).toBeTruthy();
    expect(screen.getAllByText(/Scheduling/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Pro plan/).length).toBeGreaterThan(0);
  });

  it('sends the key once, then clears the field and never shows it again', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(connection()), { status: 201 });
      }),
    );
    const { container } = render(<ConnectionsManager initial={views(null)} />);
    fireEvent.change(screen.getByLabelText(/DEV Community API key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /connect dev\.to/i }));
    await waitFor(() => expect(screen.getByText(/Connected as @writer/)).toBeTruthy());
    expect(calls).toEqual([{ platform: 'devto', secret: KEY }]);
    expect(container.innerHTML).not.toContain(KEY);
    expect(screen.getByText(/ends in 0a1b/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /test connection/i })).toBeTruthy();
  });

  it('shows a refusal without keeping the key in the page text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'DEV.to did not accept the key.', fields: { secret: 'DEV.to did not accept the key.' } }), { status: 400 })));
    render(<ConnectionsManager initial={views(null)} />);
    fireEvent.change(screen.getByLabelText(/DEV Community API key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /connect dev\.to/i }));
    await waitFor(() => expect(screen.getAllByText(/did not accept the key/).length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('flags a connection that needs reconnecting', () => {
    render(<ConnectionsManager initial={views(connection({ status: 'needs_reconnect', lastCheckMessage: 'DEV.to did not accept the key.' }))} />);
    expect(screen.getAllByText('Needs reconnecting').length).toBeGreaterThan(0);
    expect(screen.getByText(/Last problem/)).toBeTruthy();
  });

  it('asks before deleting the saved key', () => {
    render(<ConnectionsManager initial={views(connection())} />);
    fireEvent.click(screen.getByRole('button', { name: /disconnect dev\.to/i }));
    expect(screen.getByText(/Delete the saved key/)).toBeTruthy();
  });
});

describe('the publish panel', () => {
  it('says "Connect DEV.to first" when there is no connection, and offers nothing that sends', async () => {
    serve(destinations({ connection: null }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    await screen.findByText('Connect DEV.to first');
    expect(screen.queryByRole('button', { name: /prepare draft/i })).toBeNull();
    expect(screen.getAllByRole('link', { name: /open connections/i })[0]!.getAttribute('href')).toBe('/settings/connections');
  });

  it('waits for unsaved editor changes before building a draft', async () => {
    serve(destinations());
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved={false} />);
    const button = (await screen.findByRole('button', { name: /prepare draft/i })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Saving your latest changes first/)).toBeTruthy();
  });

  it('blocks staging and approval while a lint error stands, with the reason', async () => {
    serve(destinations({ draft: draft({ status: 'draft', lint: [{ code: 'image_local', severity: 'error', message: 'This image only exists on your machine; use a public URL.', items: ['asset:abc'] }] }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    const stage = (await screen.findByRole('button', { name: /stage private draft/i })) as HTMLButtonElement;
    expect(stage.disabled).toBe(true);
    expect(stage.title).toMatch(/Must fix/);
    expect(screen.getByText(/only exists on your machine/)).toBeTruthy();
    expect(screen.getByText('asset:abc')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /request approval/i })).toBeNull();
  });

  it('shows the approval card with the exact payload, the tag and a checklist that gates the button', async () => {
    const approval = { id: '55555555-5555-4555-8555-555555555555', status: 'pending' as const, tag: '#AAAAAAAA', payloadSha256: 'a'.repeat(64), expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(), createdAt: new Date().toISOString(), invalidReason: null, requestedBy: 'owner' as const };
    const calls = serve(destinations({ draft: draft({ status: 'pending_approval', approval }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    const card = await screen.findByRole('region', { name: /approve this exact post/i });
    expect(within(card).getByText('#AAAAAAAA')).toBeTruthy();
    expect(within(card).getByLabelText(/request body that will be sent/i).textContent).toContain('"published": true');
    expect(within(card).getByText('@writer')).toBeTruthy();
    expect(within(card).getByText('https://example-blog.dev/p/stalls')).toBeTruthy();

    const approve = within(card).getByRole('button', { name: /approve and publish #AAAAAAAA/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const boxes = within(card).getAllByRole('checkbox');
    expect(boxes).toHaveLength(approvalChecklist('DEV.to', true).length);
    boxes.slice(0, -1).forEach((b) => fireEvent.click(b));
    expect(approve.disabled).toBe(true);
    fireEvent.click(boxes.at(-1)!);
    expect(approve.disabled).toBe(false);

    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/api/approvals/${approval.id}/approve`))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/approve'))!;
    expect(sent.method).toBe('POST');
    expect((sent.body as { checked: string[] }).checked).toEqual(approvalChecklist('DEV.to', true));
  });

  it('an expired request cannot be approved', async () => {
    const approval = { id: '55555555-5555-4555-8555-555555555555', status: 'pending' as const, tag: '#AAAAAAAA', payloadSha256: 'a'.repeat(64), expiresAt: new Date(Date.now() - 60_000).toISOString(), createdAt: new Date().toISOString(), invalidReason: null, requestedBy: 'owner' as const };
    serve(destinations({ draft: draft({ status: 'pending_approval', approval }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    const card = await screen.findByRole('region', { name: /approve this exact post/i });
    await waitFor(() => expect(within(card).getByText(/has expired/)).toBeTruthy());
    within(card).getAllByRole('checkbox').forEach((b) => expect((b as HTMLInputElement).matches(':disabled')).toBe(true));
    expect((within(card).getByRole('button', { name: /approve and publish/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a draft whose article changed shows no approval card and asks for a rebuild', async () => {
    serve(destinations({ draft: draft({ status: 'source_changed', stale: true }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    await screen.findByText(/You edited the article after building this draft/);
    expect(screen.queryByRole('region', { name: /approve this exact post/i })).toBeNull();
    expect(screen.getByRole('button', { name: /rebuild draft/i })).toBeTruthy();
    expect(screen.getByText(/out of date/)).toBeTruthy();
  });

  it('an unknown result offers a read-only check and a confirmed hand mark, never a retry', async () => {
    serve(destinations({ draft: draft({ status: 'unknown', failureKind: 'timeout', failureMessage: 'DEV.to did not answer. The post may or may not be live.', nextAction: 'Use “Check on platform”.' }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    await screen.findByRole('button', { name: /check on platform/i });
    expect(screen.queryByRole('button', { name: /request approval/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /stage private draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve and publish/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mark by hand/i }));
    const record = screen.getByRole('button', { name: /record this/i }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I checked on the platform myself/i));
    expect(record.disabled).toBe(false);
  });

  it('shows the published link and no more action buttons', async () => {
    serve(destinations({ draft: draft({ status: 'published', remoteUrl: 'https://dev.to/writer/stalls-1001', publishedAt: '2026-10-21T10:10:00.000Z', attempts: [{ id: 'a1', kind: 'publish', status: 'succeeded', httpStatus: 200, errorKind: null, message: null, remoteId: '1001', remoteUrl: 'https://dev.to/writer/stalls-1001', startedAt: '2026-10-21T10:10:00.000Z', finishedAt: '2026-10-21T10:10:01.000Z' }] }) }));
    render(<PublishPanel articleId={ARTICLE} refreshKey={1} saved />);
    const links = await screen.findAllByRole('link', { name: /dev\.to\/writer\/stalls-1001/ });
    expect(links[0]!.getAttribute('href')).toBe('https://dev.to/writer/stalls-1001');
    expect(screen.queryByRole('button', { name: /stage|rebuild|request approval|approve/i })).toBeNull();
  });
});
