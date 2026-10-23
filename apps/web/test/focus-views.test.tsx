// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformDirectory, type DirectoryItem } from '../src/components/platforms/platform-directory';
import { AppShell } from '../src/components/shell/app-shell';
import { ViewPrefsProvider, useViewPrefs } from '../src/components/shell/view-prefs';
import { CollapsibleArea } from '../src/components/ui/collapsible-area';
import { DIRECTORY, directoryStatus } from '../src/lib/directory';
import { effectiveLayout, gridClass, OVERLAY_SCALE, SIZE_SCALE } from '../src/lib/preview-layout';
import { isSidebarShortcut, isTypingTarget, wrapIndex } from '../src/lib/shortcuts';
import { DEFAULT_VIEW_PREFS, parseViewPrefs, serializeViewPrefs, toggled, viewCookieString, VIEW_COOKIE, type ViewPrefs } from '../src/lib/view-prefs';

// The shell pieces that reach for the router, the network or matchMedia are not what these tests are about.
vi.mock('next/navigation', () => ({ usePathname: () => '/publishing', useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock('../src/components/shell/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/shell/status-chip', () => ({ StatusChip: () => null }));
vi.mock('../src/components/shell/theme-toggle', () => ({ ThemeToggle: () => null }));

afterEach(() => {
  cleanup();
  document.cookie = `${VIEW_COOKIE}=; Max-Age=0; Path=/`;
});

function provider(prefs: Partial<ViewPrefs> = {}) {
  const writes: ViewPrefs[] = [];
  const wrap = (node: React.ReactNode) => (
    <ViewPrefsProvider initial={{ ...DEFAULT_VIEW_PREFS, ...prefs }} write={(p) => writes.push(p)}>
      {node}
    </ViewPrefsProvider>
  );
  return { writes, wrap };
}

describe('the saved layout choices', () => {
  it('start from sensible defaults when nothing is saved or the cookie is damaged', () => {
    expect(parseViewPrefs(undefined)).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs('')).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs('%7Bnot json')).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs(encodeURIComponent('[1,2]'))).toEqual(DEFAULT_VIEW_PREFS);
    expect(DEFAULT_VIEW_PREFS).toMatchObject({ sidebarCollapsed: false, collapsedAreas: [], previewLayout: 'single', previewSize: 'comfortable', studioPanel: null, platformsDensity: 'comfortable', integrationsDensity: 'list' });
  });

  it('keep what is valid and drop what is not, field by field', () => {
    const raw = encodeURIComponent(JSON.stringify({ sidebarCollapsed: true, collapsedAreas: ['previews', 'nonsense'], previewLayout: 'cube', previewSize: 'large', studioPanel: 'history', collapsedPanes: 'x', platformsDensity: 'compact' }));
    expect(parseViewPrefs(raw)).toEqual({ ...DEFAULT_VIEW_PREFS, sidebarCollapsed: true, collapsedAreas: ['previews'], previewSize: 'large', studioPanel: 'history', platformsDensity: 'compact' });
  });

  it('round-trip through the cookie value, and only what differs from the defaults is written', () => {
    expect(serializeViewPrefs(DEFAULT_VIEW_PREFS)).toBe(encodeURIComponent('{}'));
    const prefs: ViewPrefs = { ...DEFAULT_VIEW_PREFS, sidebarCollapsed: true, collapsedAreas: ['article', 'platforms'], previewLayout: 'grid3', integrationsDensity: 'compact', studioPanel: 'ai' };
    expect(parseViewPrefs(serializeViewPrefs(prefs))).toEqual(prefs);
    expect(viewCookieString(prefs)).toMatch(new RegExp(`^${VIEW_COOKIE}=.*; Path=/; Max-Age=\\d+; SameSite=Lax$`));
    expect(toggled(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  it('remember the device and appearance of the previews, and fall back when either is not a known value', () => {
    expect(DEFAULT_VIEW_PREFS).toMatchObject({ previewDevice: 'desktop', previewAppearance: 'light' });
    const kept: ViewPrefs = { ...DEFAULT_VIEW_PREFS, previewDevice: 'mobile', previewAppearance: 'dark' };
    expect(parseViewPrefs(serializeViewPrefs(kept))).toEqual(kept);
    expect(parseViewPrefs(encodeURIComponent(JSON.stringify({ previewDevice: 'watch', previewAppearance: 'sepia' })))).toEqual(DEFAULT_VIEW_PREFS);
  });

  it('are kept in the cookie when changed, and the provider starts from what the server read', () => {
    function Probe() {
      const { prefs, update } = useViewPrefs();
      return (
        <button type="button" onClick={() => update({ sidebarCollapsed: !prefs.sidebarCollapsed })}>
          {prefs.sidebarCollapsed ? 'collapsed' : 'expanded'}
        </button>
      );
    }
    render(
      <ViewPrefsProvider initial={parseViewPrefs(serializeViewPrefs({ ...DEFAULT_VIEW_PREFS, sidebarCollapsed: true }))}>
        <Probe />
      </ViewPrefsProvider>,
    );
    expect(screen.getByRole('button').textContent).toBe('collapsed');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('expanded');
    expect(parseViewPrefs(document.cookie.split('; ').find((c) => c.startsWith(`${VIEW_COOKIE}=`))?.split('=')[1])).toEqual(DEFAULT_VIEW_PREFS);
    fireEvent.click(screen.getByRole('button'));
    expect(parseViewPrefs(document.cookie.split('; ').find((c) => c.startsWith(`${VIEW_COOKIE}=`))?.split('=')[1]).sidebarCollapsed).toBe(true);
  });
});

describe('keyboard helpers', () => {
  it('knows when the person is typing', () => {
    const make = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      return host;
    };
    const host = make('<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><span id="c">x</span></div><div class="cm-editor"><div id="e">y</div></div><button id="b">b</button><div id="p">p</div>');
    const el = (id: string) => host.querySelector(`#${id}`);
    for (const id of ['i', 't', 's', 'c', 'e']) expect(isTypingTarget(el(id)), id).toBe(true);
    for (const id of ['b', 'p']) expect(isTypingTarget(el(id)), id).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    host.remove();
  });

  it('matches Ctrl+backslash only, never Ctrl+B', () => {
    const base = { key: '\\', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(isSidebarShortcut(base)).toBe(true);
    expect(isSidebarShortcut({ ...base, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSidebarShortcut({ ...base, key: 'b' })).toBe(false);
    expect(isSidebarShortcut({ ...base, ctrlKey: false })).toBe(false);
    expect(isSidebarShortcut({ ...base, shiftKey: true })).toBe(false);
    expect(isSidebarShortcut({ ...base, altKey: true })).toBe(false);
  });

  it('goes round a list at either end', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(1, 1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe('preview layout rules', () => {
  it('falls back from compare when fewer than two previews are ready, and scales by size', () => {
    expect(effectiveLayout('compare', 1)).toBe('single');
    expect(effectiveLayout('compare', 2)).toBe('compare');
    expect(effectiveLayout('grid3', 1)).toBe('grid3');
    expect(SIZE_SCALE.compact).toBeLessThan(SIZE_SCALE.comfortable);
    expect(SIZE_SCALE.large).toBeGreaterThan(SIZE_SCALE.comfortable);
    expect(OVERLAY_SCALE).toBeGreaterThan(SIZE_SCALE.large);
    expect(gridClass('single')).toBe('');
    expect(gridClass('grid2')).toContain('grid-cols-2');
    expect(gridClass('grid3')).toContain('grid-cols-3');
  });
});

describe('the application shell', () => {
  const nav = () => screen.getByRole('complementary');

  it('renders the saved state on the first paint and folds to an icon rail whose links keep their names', () => {
    const { wrap } = provider({ sidebarCollapsed: true });
    render(wrap(<AppShell>content</AppShell>));
    expect(nav().getAttribute('data-collapsed')).toBe('true');
    const toggle = within(nav()).getByRole('button', { name: 'Expand sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(nav().id);
    // Icon only, but every link still has its text for a screen reader.
    expect(within(nav()).getByRole('link', { name: 'Publishing' })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Publishing' }).getAttribute('aria-current')).toBe('page');
  });

  it('the toggle folds and opens the sidebar and remembers it', () => {
    const { wrap, writes } = provider();
    render(wrap(<AppShell>content</AppShell>));
    const toggle = within(nav()).getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(writes.at(-1)!.sidebarCollapsed).toBe(true);
    expect(nav().getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(within(nav()).getByRole('button', { name: 'Expand sidebar' }));
    expect(writes.at(-1)!.sidebarCollapsed).toBe(false);
  });

  it('Ctrl+backslash toggles the sidebar, but never while typing in a field or the editor', () => {
    const { wrap, writes } = provider();
    render(
      wrap(
        <AppShell>
          <input aria-label="A field" />
          <textarea aria-label="Another field" />
          <div className="cm-editor">
            <div contentEditable suppressContentEditableWarning aria-label="Editor" role="textbox">
              text
            </div>
          </div>
        </AppShell>,
      ),
    );
    const press = (target: Element | Window) => fireEvent.keyDown(target, { key: '\\', ctrlKey: true });
    for (const typing of [screen.getByLabelText('A field'), screen.getByLabelText('Another field'), screen.getByLabelText('Editor')]) press(typing);
    expect(writes).toHaveLength(0);
    // Ctrl+B belongs to the editor.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(writes).toHaveLength(0);
    press(window);
    expect(writes.at(-1)!.sidebarCollapsed).toBe(true);
    press(document.body);
    expect(writes.at(-1)!.sidebarCollapsed).toBe(false);
  });

  it('keeps the shortcut quiet while a dialog is open', () => {
    const { wrap, writes } = provider();
    render(wrap(<AppShell>content</AppShell>));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(writes).toHaveLength(0);
    dialog.remove();
  });
});

describe('a foldable area', () => {
  function Demo({ initial = false }: { initial?: boolean }) {
    const [collapsed, setCollapsed] = useState(initial);
    return (
      <CollapsibleArea title="Panel" summary="Two things chosen" collapsed={collapsed} onCollapsedChange={setCollapsed}>
        <p>the body</p>
      </CollapsibleArea>
    );
  }

  it('says whether it is open, what it controls, and keeps its body mounted while folded', () => {
    render(<Demo />);
    const fold = screen.getByRole('button', { name: 'Fold Panel' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(fold.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(false);
    fireEvent.click(fold);
    const open = screen.getByRole('button', { name: /Panel.*Two things chosen/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.getAttribute('aria-controls')).toBe(body.id);
    expect(body.hidden).toBe(true);
    expect(within(body).getByText('the body')).toBeTruthy();
    fireEvent.click(open);
    expect(body.hidden).toBe(false);
  });
});

describe('the platform directory layout', () => {
  const items: DirectoryItem[] = DIRECTORY.map((entry) => ({ entry, status: directoryStatus(entry, false), who: null }));

  it('filters by the category column, with counts, and the buttons say which is chosen', () => {
    const { wrap } = provider();
    render(wrap(<PlatformDirectory items={items} />));
    const categories = within(screen.getByRole('list', { name: 'Categories' }));
    expect(categories.getByRole('button', { name: /All categories/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(categories.getByRole('button', { name: /Video/ }));
    expect(categories.getByRole('button', { name: /Video/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: 'YouTube' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'DEV.to' })).toBeNull();
  });

  it('folds the column and remembers it, and the bar names the chosen category', () => {
    const { wrap, writes } = provider();
    render(wrap(<PlatformDirectory items={items} />));
    fireEvent.click(screen.getByRole('button', { name: 'Fold Categories' }));
    expect(writes.at(-1)!.filtersCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: /Categories.*All categories/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('switches between list, compact grid and comfortable grid, and remembers the choice', () => {
    const { wrap, writes } = provider();
    const { container } = render(wrap(<PlatformDirectory items={items} />));
    const density = within(screen.getByRole('group', { name: 'Layout of the platform list' }));
    expect(density.getByRole('button', { name: /Comfortable/ }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('details').length).toBe(DIRECTORY.length);
    fireEvent.click(density.getByRole('button', { name: /^List/ }));
    expect(writes.at(-1)!.platformsDensity).toBe('list');
    // A row has no details block, but every platform is still there with its next step.
    expect(container.querySelectorAll('details').length).toBe(0);
    expect(container.querySelectorAll('li[id]').length).toBe(DIRECTORY.length);
    fireEvent.click(density.getByRole('button', { name: /Compact/ }));
    expect(writes.at(-1)!.platformsDensity).toBe('compact');
    expect(container.querySelectorAll('li[id]').length).toBe(DIRECTORY.length);
  });
});
