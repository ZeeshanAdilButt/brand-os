// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPanel } from '../src/components/ai/ai-panel';
import { AssistBar } from '../src/components/ai/assist-bar';
import { TaskCard, type TaskActions } from '../src/components/ai/task-card';
import type { TaskDTO } from '../src/lib/ai';

afterEach(cleanup);

const NOOP = { onRun: () => {}, onAsk: () => {} };

function task(over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'improve_section',
    status: 'needs_review',
    articleId: '22222222-2222-4222-8222-222222222222',
    articleRevision: 3,
    selection: { start: 10, end: 52 },
    excerpt: 'The queue is long. We measured it twice.',
    excerptTruncated: false,
    instruction: '',
    provider: { id: '33333333-3333-4333-8333-333333333333', name: 'Claude', kind: 'api_key' },
    model: 'claude-test',
    result: { operations: [{ type: 'replace_range', original: 'The queue is long. We measured it twice.', proposed: 'The queue is long; we measured it twice.', rationale: 'One sentence.' }] },
    error: null,
    stale: null,
    waiting: false,
    usage: { tokensIn: 40, tokensOut: 20, estimated: true, fromCache: false, provider: 'Claude', model: 'claude-test', costUsd: null },
    notes: [],
    withheldCount: 0,
    attempts: 1,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:05.000Z',
    finishedAt: '2026-10-21T10:00:05.000Z',
    ...over,
  };
}

function actions(over: Partial<TaskActions> = {}): TaskActions {
  const ok = async () => ({ ok: true as const });
  return { accept: ok, reject: ok, retry: ok, reviewPrivate: () => {}, ...over };
}

describe('the assist bar', () => {
  it('in no-AI mode shows no AI actions, says so, and links to the setup', () => {
    render(<AssistBar available={false} selectedChars={0} busy={false} {...NOOP} />);
    expect(screen.getByText(/AI is off/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /improve/i })).toBeNull();
    expect(screen.getByRole('link', { name: /set up ai/i }).getAttribute('href')).toBe('/settings/ai');
  });

  it('disables the selection actions until text is selected, and says why', () => {
    const { rerender } = render(<AssistBar available selectedChars={0} busy={false} {...NOOP} />);
    const improve = screen.getByRole('button', { name: /improve/i }) as HTMLButtonElement;
    expect(improve.disabled).toBe(true);
    expect(improve.title).toMatch(/select some text/i);
    expect((screen.getByRole('button', { name: /suggest titles/i }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<AssistBar available selectedChars={120} busy={false} {...NOOP} />);
    expect((screen.getByRole('button', { name: /improve/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/120 selected/)).toBeTruthy();
  });

  it('refuses an over-long selection with a reason', () => {
    render(<AssistBar available selectedChars={25_000} busy={false} {...NOOP} />);
    const tighten = screen.getByRole('button', { name: /tighten/i }) as HTMLButtonElement;
    expect(tighten.disabled).toBe(true);
    expect(tighten.title).toMatch(/at most 20,000/);
  });

  it('asks the page to run the chosen task', () => {
    const onRun = vi.fn();
    render(<AssistBar available selectedChars={30} busy={false} onRun={onRun} onAsk={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /check accuracy/i }));
    expect(onRun).toHaveBeenCalledWith('check_accuracy');
  });
});

describe('the AI panel', () => {
  it('explains no-AI mode and offers no ask box', () => {
    render(<AiPanel providers={[]} tasks={[]} loaded stream="live" selection={null} onAsk={async () => ({ ok: true })} actions={actions()} askRef={createRef()} />);
    expect(screen.getByText('AI is off')).toBeTruthy();
    expect(screen.queryByLabelText(/ask about your text/i)).toBeNull();
    expect(screen.getByRole('link', { name: /set up ai/i })).toBeTruthy();
  });

  it('sends the typed question and clears it', async () => {
    const onAsk = vi.fn(async () => ({ ok: true as const }));
    render(<AiPanel providers={[{ id: 'p', name: 'Claude', kind: 'api_key', isDefault: true, executes: true }]} tasks={[]} loaded stream="live" selection={{ start: 0, end: 10, text: 'x'.repeat(10) }} onAsk={onAsk} actions={actions()} askRef={createRef()} />);
    expect(screen.getByText(/Applies to your selection \(10 characters\)/)).toBeTruthy();
    const box = screen.getByLabelText('Ask about your text') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Explain this more simply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith('Explain this more simply', null));
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('shows a clear empty state', () => {
    render(<AiPanel providers={[{ id: 'p', name: 'Claude', kind: 'api_key', isDefault: true, executes: true }]} tasks={[]} loaded stream="polling" selection={null} onAsk={async () => ({ ok: true })} actions={actions()} askRef={createRef()} />);
    expect(screen.getByText(/No tasks yet/)).toBeTruthy();
    expect(screen.getByText(/Checking every few seconds/)).toBeTruthy();
  });
});

describe('a task card', () => {
  it('shows the diff with removed and added words marked, and accepts only on a click', async () => {
    const accept = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(<ul><TaskCard task={task()} actions={actions({ accept })} /></ul>);
    expect(container.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(screen.getByText('Ready to review')).toBeTruthy();
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /accept change/i }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: task().id }), null));
  });

  it('refuses to accept a stale result and says why', () => {
    render(<ul><TaskCard task={task({ stale: 'The original text no longer matches the article.' })} actions={actions()} /></ul>);
    expect(screen.getByRole('alert').textContent).toMatch(/Out of date/);
    expect((screen.getByRole('button', { name: /accept change/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /reject/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('needs a title to be chosen before it can be used', async () => {
    const accept = vi.fn(async () => ({ ok: true as const }));
    render(
      <ul>
        <TaskCard task={task({ kind: 'suggest_titles', selection: null, result: { operations: [{ type: 'suggest_titles', titles: ['First', 'Second'] }] } })} actions={actions({ accept })} />
      </ul>,
    );
    const use = screen.getByRole('button', { name: /use this title/i }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Second'));
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    await waitFor(() => expect(accept).toHaveBeenCalledWith(expect.anything(), 1));
  });

  it('shows review notes as a list and never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <ul>
        <TaskCard task={task({ kind: 'check_accuracy', result: { operations: [{ type: 'review_notes', notes: [{ severity: 'warning', quote: hostile, note: 'Check this <b>claim</b>.' }] }] } })} actions={actions()} />
      </ul>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('button', { name: /mark as read/i })).toBeTruthy();
    expect(container.textContent).toContain('<b>claim</b>');
  });

  it('shows a waiting hand-off task with a copyable instruction and nothing running', () => {
    render(<ul><TaskCard task={task({ status: 'pending', waiting: true, result: null, provider: { id: null, name: 'Claude Code', kind: 'claude_code_handoff' } })} actions={actions()} /></ul>);
    expect(screen.getByText('Waiting for Claude Code')).toBeTruthy();
    expect(screen.getByText(`In Claude Code: list my Brand OS AI tasks and complete task ${task().id}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy instruction/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
  });

  it('offers to run a failed task again and shows the reason', async () => {
    const retry = vi.fn(async () => ({ ok: true as const }));
    render(<ul><TaskCard task={task({ status: 'failed', result: null, error: 'The provider did not accept the key (HTTP 401).' })} actions={actions({ retry })} /></ul>);
    expect(screen.getByRole('alert').textContent).toMatch(/did not accept the key/);
    fireEvent.click(screen.getByRole('button', { name: /run again/i }));
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });

  it('says when private notes were left out and offers to review the exact text', () => {
    const reviewPrivate = vi.fn();
    render(<ul><TaskCard task={task({ withheldCount: 2 })} actions={actions({ reviewPrivate })} /></ul>);
    expect(screen.getByText(/2 related private notes were not sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /review what would be sent/i }));
    expect(reviewPrivate).toHaveBeenCalled();
  });

  it('states usage as estimated and never shows a cost', () => {
    const { container } = render(<ul><TaskCard task={task()} actions={actions()} /></ul>);
    expect(container.textContent).toContain('60 tokens (estimated)');
    expect(container.textContent).not.toMatch(/\$|cost|usd/i);
  });
});
