// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectDrawer } from '../src/components/integrations/connect-drawer';
import { ConnectOverview } from '../src/components/integrations/connect-overview';
import { CONNECTORS, CONNECTOR_LIST, type ConnectorId } from '../src/lib/connectors';
import type { ConnectorViewDTO } from '../src/lib/connectors/dto';
import { setupGuideFor } from '../src/lib/connectors/guide';
import { connectorChip } from '../src/lib/chips';
import { STATE_LABELS } from '../src/lib/connectors';
import { defaultSiteSettings } from '../src/lib/site-export';

const W = (...parts: string[]) => parts.join('-');
/** A tiny stand-in for user-event: the app only needs typing and clicking. */
const userEvent = {
  setup: () => ({
    type: async (el: HTMLElement, text: string) => void fireEvent.change(el, { target: { value: text } }),
    click: async (el: HTMLElement) => void fireEvent.click(el),
  }),
};
const SECRET = W('fake', 'ui', 'secret', 'value', '5f6a7b');
const SITE = defaultSiteSettings();

const view = (id: ConnectorId, over: Partial<ConnectorViewDTO> = {}): ConnectorViewDTO => ({
  id,
  state: 'needs_key',
  label: 'Needs key',
  detail: 'Add the key to connect.',
  expiresInDays: null,
  reconnect: false,
  connection: null,
  app: { saved: false, hint: '', source: null },
  deviceApp: { saved: false, hint: '', source: null },
  redirectUri: CONNECTORS[id].oauth && !CONNECTORS[id].oauth?.perInstance ? `http://127.0.0.1:3100/api/connect/${id}/callback` : null,
  device: null,
  legacyKeyHint: null,
  publishes: false,
  ...over,
});

const connection = (id: ConnectorId, over: Partial<NonNullable<ConnectorViewDTO['connection']>> = {}): NonNullable<ConnectorViewDTO['connection']> => ({
  id: '33333333-3333-4333-8333-333333333333',
  platform: id,
  status: 'connected',
  who: 'The Fake Notes',
  keyLast4: '5f6a',
  config: {},
  lastCheckedAt: '2026-10-24T09:00:00.000Z',
  lastCheckMessage: null,
  createdAt: '2026-10-24T08:00:00.000Z',
  authKind: 'api_key',
  scopesGranted: [],
  tokenExpiresAt: null,
  renewable: false,
  lastErrorCode: null,
  ...over,
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function drawer(v: ConnectorViewDTO, extra: Partial<React.ComponentProps<typeof ConnectDrawer>> = {}) {
  const onView = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const utils = render(<ConnectDrawer id={v.id} view={v} site={SITE} result={null} onClose={onClose} onView={onView} onOpen={onOpen} next={null} {...extra} />);
  return { ...utils, onView, onOpen, onClose };
}

let calls: { url: string; init: RequestInit | undefined }[];
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

beforeEach(() => {
  stubFetch(() => reply({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Connect drawer for a platform that takes a key', () => {
  it('shows ordered steps with a deep link that opens the platform in a new tab, the access asked for, and a password field', () => {
    drawer(view('beehiiv'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Beehiiv' })).toBeTruthy();
    const steps = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('Create a key'));
    expect(steps.length).toBeGreaterThan(0);
    const link = screen.getByRole('link', { name: /Open the Beehiiv guide/ });
    expect(link.getAttribute('href')).toBe('https://developers.beehiiv.com/welcome/create-an-api-key');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('publications:read')).toBeTruthy();
    const field = screen.getByLabelText('Beehiiv API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect((screen.getByRole('button', { name: /Test and connect/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the key once, never shows it, and shows the account name on success', async () => {
    const connected = view('beehiiv', { state: 'connected', label: 'Connected', detail: 'Checked and working.', connection: connection('beehiiv') });
    stubFetch(() => reply({ ok: true, message: 'Connected as The Fake Notes.', account: 'The Fake Notes', view: connected }));
    const { onView } = drawer(view('beehiiv'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Beehiiv API key'), SECRET);
    // The typed value is in a password field and nowhere in the readable text.
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(screen.getByRole('button', { name: /Test and connect/ }));
    await waitFor(() => expect(onView).toHaveBeenCalledWith(connected));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/connect/beehiiv/fields');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ fields: { apiKey: SECRET } });
    expect(document.body.textContent).not.toContain(SECRET);
    expect(await screen.findByText('Connected as The Fake Notes.')).toBeTruthy();
  });

  it('shows a plain error under the field when the platform refuses the key, and keeps the key out of the page', async () => {
    stubFetch(() => reply({ error: 'Beehiiv did not accept the key. It may have been revoked or have expired.', code: 'invalid', fields: { apiKey: 'Beehiiv did not accept the key.' } }, 400));
    drawer(view('beehiiv'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Beehiiv API key'), SECRET);
    await user.click(screen.getByRole('button', { name: /Test and connect/ }));
    expect((await screen.findAllByText(/did not accept the key/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('shows who it is connected as with Test, Replace key and Disconnect, and no key form until Replace is chosen', async () => {
    const v = view('beehiiv', { state: 'connected', label: 'Connected', detail: 'Checked and working.', connection: connection('beehiiv') });
    drawer(v);
    expect(screen.getByText('Connected as The Fake Notes')).toBeTruthy();
    expect(screen.getByText(/Key ends in 5f6a/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(screen.queryByLabelText('Beehiiv API key')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Replace key' }));
    expect(screen.getByLabelText('Beehiiv API key')).toBeTruthy();
  });

  it('asks before it disconnects and then shows what is left to do on the platform', async () => {
    const v = view('beehiiv', { state: 'connected', label: 'Connected', detail: 'Checked and working.', connection: connection('beehiiv') });
    const after = view('beehiiv');
    stubFetch(() => reply({ revoked: 'manual', message: 'Disconnected. The stored secret was deleted from this app.', steps: ['Open the API settings in Beehiiv.', 'Delete the key named Brand OS.'], view: after }));
    const { onView } = drawer(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Disconnect Beehiiv' }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onView).toHaveBeenCalledWith(after));
    expect(calls[0]?.url).toBe('/api/connect/beehiiv');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect((await screen.findAllByText('Delete the key named Brand OS.')).length).toBeGreaterThan(0);
  });

  it('asks quietly to reconnect when the platform no longer accepts the key', () => {
    const v = view('beehiiv', { state: 'needs_reconnect', label: 'Needs reconnect', detail: 'The platform no longer accepts the saved key. Replace it.', reconnect: true, connection: connection('beehiiv', { status: 'needs_reconnect', lastErrorCode: 'rejected', lastCheckMessage: 'Beehiiv did not accept the key.' }) });
    drawer(v);
    expect(screen.getByText(/no longer accepts the saved key/)).toBeTruthy();
    expect(screen.getByText('Beehiiv did not accept the key.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeTruthy();
  });
});

describe('the Connect drawer for a platform that signs in with OAuth', () => {
  it('shows the exact redirect address to register, steps to create the app, and keeps Sign in off until the app is saved', () => {
    drawer(view('x', { state: 'set_up', label: 'Set up' }));
    expect(screen.getByText('http://127.0.0.1:3100/api/connect/x/callback')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open the X developer console/ }).getAttribute('target')).toBe('_blank');
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText('Client ID') as HTMLInputElement).type).toBe('password');
    expect((screen.getByRole('button', { name: /Sign in with X/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Save your app first.')).toBeTruthy();
  });

  it('lists what it asks for, required ones fixed and optional ones off until ticked, and sends only what was ticked', async () => {
    stubFetch(() => reply({ flowId: 'x', authorizeUrl: 'http://127.0.0.1:4310/i/oauth2/authorize?state=abc', redirectUri: 'r', expiresAt: 'e' }));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    drawer(view('x', { app: { saved: true, hint: '0001', source: 'saved' } }));
    expect(screen.getAllByText('always').length).toBe(3);
    const write = screen.getByLabelText(/tweet\.write/) as HTMLInputElement;
    expect(write.checked).toBe(false);
    const user = userEvent.setup();
    await user.click(write);
    await user.click(screen.getByRole('button', { name: /Sign in with X/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:4310/i/oauth2/authorize?state=abc'));
    expect(calls[0]?.url).toBe('/api/connect/x/start');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ scopes: ['tweet.write'] });
  });

  it('shows what the platform answered when it sent the person back', () => {
    drawer(view('x'), { result: 'denied' });
    expect(screen.getByText(/You declined access on the platform/)).toBeTruthy();
  });

  it('asks for the instance first for Mastodon and registers no app by hand', () => {
    drawer(view('mastodon'));
    expect(screen.getByLabelText('Your instance')).toBeTruthy();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect((screen.getByRole('button', { name: /Sign in with Mastodon/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the device code, a link to the platform, and a Cancel that stops waiting', async () => {
    const waiting = view('youtube', { app: { saved: true, hint: '0001', source: 'saved' }, deviceApp: { saved: true, hint: '0002', source: 'saved' }, device: { flowId: '44444444-4444-4444-8444-444444444444', userCode: 'ABCD-EFGH', verificationUri: 'https://www.google.com/device', expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSec: 60 } });
    stubFetch(() => reply(view('youtube')));
    drawer(waiting);
    expect(screen.getByLabelText('Your code').textContent).toBe('ABCD-EFGH');
    expect(screen.getByRole('link', { name: /Open www\.google\.com/ }).getAttribute('target')).toBe('_blank');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/connect/youtube/device' && c.init?.method === 'DELETE')).toBe(true));
  });
});

describe('manual and not-yet-confirmed platforms', () => {
  it('says why there is nothing to connect and what to do, with no field at all', () => {
    drawer(view('medium', { state: 'manual', label: 'Manual', detail: 'No API.' }));
    expect(screen.getAllByText(/no longer issues integration tokens/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Open Medium.s import tool/ }).getAttribute('target')).toBe('_blank');
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(screen.queryByText('This stays at Set up')).toBeNull();
  });

  it('keeps an unverified connector at Set up with the reasons and no form', () => {
    drawer(view('slack', { state: 'set_up', label: 'Set up' }));
    expect(screen.getByText('This stays at Set up')).toBeTruthy();
    expect(screen.getAllByText(/no read-only way to check a webhook/).length).toBeGreaterThan(0);
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Test and connect/ })).toBeNull();
  });

  it('points LinkedIn video at the LinkedIn sign-in', async () => {
    const { onOpen } = drawer(view('linkedin_video', { state: 'set_up', label: 'Set up' }));
    await userEvent.setup().click(screen.getByRole('button', { name: /Open LinkedIn$/ }));
    expect(onOpen).toHaveBeenCalledWith('linkedin');
  });
});

describe('the setup guide for the owner’s own browser agent', () => {
  it('says the owner types every secret and lists the steps and the redirect address', () => {
    const guide = setupGuideFor(CONNECTORS.x, 'http://127.0.0.1:3100/api/connect/x/callback');
    expect(guide).toMatch(/I type every secret myself/);
    expect(guide).toMatch(/Never ask me to paste a key, token, secret or password into this chat/);
    expect(guide).toContain('http://127.0.0.1:3100/api/connect/x/callback');
    expect(guide).toContain('users.read');
    expect(guide).not.toMatch(/tweet\.write/);
    expect(setupGuideFor(CONNECTORS.medium, null)).toMatch(/no connection to make/i);
  });

  it('is offered in every drawer, folded, and never contains a secret', async () => {
    for (const def of CONNECTOR_LIST) {
      const guide = setupGuideFor(def, `http://127.0.0.1:3100/api/connect/${def.id}/callback`);
      expect(guide, def.id).toMatch(/I type every secret myself/);
      expect(guide.replace(/https:\/\/\S+/g, ''), def.id).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
    drawer(view('beehiiv'));
    expect(screen.getByText('Show the setup guide')).toBeTruthy();
  });
});

describe('the overview', () => {
  const ready = view('beehiiv');
  const done = view('x', { state: 'connected', label: 'Connected', connection: connection('x') });
  const owner = view('linkedin', { state: 'set_up', label: 'Set up' });
  const manual = view('medium', { state: 'manual', label: 'Manual' });

  it('counts what is connected, what is ready, what needs set up and what is manual, and connects the ready ones in turn', async () => {
    const onConnectReady = vi.fn();
    render(<ConnectOverview views={[ready, done, owner, manual]} onOpen={vi.fn()} onConnectReady={onConnectReady} />);
    expect(screen.getByRole('region', { name: 'Connected' }).textContent).toContain('X');
    expect(screen.getByRole('region', { name: 'Ready for your key or sign-in' }).textContent).toContain('Beehiiv');
    expect(screen.getByRole('region', { name: 'Set up needed' }).textContent).toContain('LinkedIn');
    expect(screen.getByRole('region', { name: 'Manual: you post it' })).toBeTruthy();
    const button = screen.getByRole('button', { name: /Connect all that are ready \(1\)/ });
    await userEvent.setup().click(button);
    expect(onConnectReady).toHaveBeenCalled();
  });

  it('turns the button off when nothing is ready, and says what needs reconnecting', () => {
    render(<ConnectOverview views={[done, manual]} onOpen={vi.fn()} onConnectReady={vi.fn()} />);
    expect((screen.getByRole('button', { name: /Connect all that are ready/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const lost = view('beehiiv', { state: 'needs_reconnect', label: 'Needs reconnect', reconnect: true });
    render(<ConnectOverview views={[lost]} onOpen={vi.fn()} onConnectReady={vi.fn()} />);
    expect(screen.getByText('Beehiiv needs reconnecting.')).toBeTruthy();
  });
});

describe('state words', () => {
  it('uses exactly the six labels, each with its own icon and tone', () => {
    const labels = ['connected', 'needs_key', 'needs_reconnect', 'set_up', 'manual', 'planned'] as const;
    expect(labels.map((s) => STATE_LABELS[s])).toEqual(['Connected', 'Needs key', 'Needs reconnect', 'Set up', 'Manual', 'Planned']);
    const chips = labels.map((s) => connectorChip(s));
    expect(new Set(chips.map((c) => c.label)).size).toBe(6);
    expect(new Set(chips.map((c) => `${c.tone}:${c.icon}`)).size).toBe(6);
    // Nothing relies on colour alone: every chip has text and an icon name.
    for (const chip of chips) expect(chip.icon).toBeTruthy();
  });
});

