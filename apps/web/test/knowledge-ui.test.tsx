// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { FileUp } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';
import { DisabledOption } from '../src/components/disabled-option';
import { ConfidentialityBadge, PublicUseBadge, VerificationBadge } from '../src/components/knowledge/badges';
import { MarkedText } from '../src/components/knowledge/marked-text';
import { MARK_END, MARK_START, splitMarked } from '../src/lib/knowledge';

afterEach(cleanup);

describe('search highlighting', () => {
  it('splits marked text into plain and matched segments', () => {
    expect(splitMarked(`a ${MARK_START}hit${MARK_END} b`)).toEqual([
      { text: 'a ', match: false },
      { text: 'hit', match: true },
      { text: ' b', match: false },
    ]);
    expect(splitMarked('no marks')).toEqual([{ text: 'no marks', match: false }]);
  });

  it('renders matches as <mark> and never interprets item text as HTML', () => {
    const hostile = `<img src=x onerror=alert(1)> ${MARK_START}needle${MARK_END} <script>boom()</script>`;
    const { container } = render(<p><MarkedText text={hostile} /></p>);
    expect(container.querySelector('mark')?.textContent).toBe('needle');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>boom()</script>');
  });
});

describe('badges', () => {
  it('state verification, confidentiality and public use in words, not only colour', () => {
    render(
      <div>
        <VerificationBadge status="owner_claim_needs_review" />
        <ConfidentialityBadge level="private" />
        <PublicUseBadge permitted={false} />
      </div>,
    );
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('Not for public use')).toBeTruthy();
  });
});

describe('unbuilt features', () => {
  it('show a disabled control and the day they arrive, with no way to activate them', () => {
    render(
      <ul>
        <DisabledOption icon={FileUp} title="Resume upload" description="Read a resume." action="Upload a resume" day={3} />
      </ul>,
    );
    const button = screen.getByRole('button', { name: 'Upload a resume' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Arrives Day 3/)).toBeTruthy();
    expect(screen.getByText(/Not built yet/)).toBeTruthy();
  });
});
