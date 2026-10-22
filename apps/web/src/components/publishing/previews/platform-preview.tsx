'use client';

import { useState } from 'react';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import type { DraftExtras, DraftPayload } from '@/lib/publishing';
import { Button } from '@/components/ui/button';
import { PreviewFrame, type Appearance, type Device, type FrameControl } from './preview-frame';
import { ArticleSkin, Counters, SocialSkin, SubmissionSkin, VideoSkin } from './skins';

export interface PreviewInput {
  platform: PlatformId;
  payload: DraftPayload;
  extras?: DraftExtras | undefined;
  /** Who the draft is for, if the platform said: an account name. Otherwise placeholders are drawn. */
  account?: string | null | undefined;
}

/**
 * The approximate preview of one destination, built from the adapted payload only. It offers a device width
 * (desktop or phone), the platform in light or dark, and the views that matter for that platform: in the feed or
 * opened for a post, listing or form for Hacker News, card or watch page for YouTube, inbox or opened for a newsletter.
 */
export function PlatformPreview({ input, defaultDevice = 'desktop', className }: { input: PreviewInput; defaultDevice?: Device; className?: string }) {
  const { platform, payload } = input;
  const info = PLATFORMS[platform];
  const [device, setDevice] = useState<Device>(defaultDevice);
  const [appearance, setAppearance] = useState<Appearance>('light');
  const [mode, setMode] = useState<'feed' | 'opened'>('feed');
  const [showFull, setShowFull] = useState(false);
  const [submission, setSubmission] = useState<'listing' | 'fields'>('listing');
  const [video, setVideo] = useState<'card' | 'watch'>('card');
  const [newsletter, setNewsletter] = useState<'inbox' | 'opened'>('opened');
  const account = input.account ?? null;
  const base = { platform, payload, account, device, appearance };

  const controls: FrameControl[] = [];
  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (info.kind === 'short_form') {
    controls.push({
      label: 'View',
      value: mode,
      onChange: (v) => setMode(v as 'feed' | 'opened'),
      options: [
        { value: 'feed', label: 'In the feed' },
        { value: 'opened', label: 'Opened' },
      ],
    });
    body = <SocialSkin {...base} mode={mode} showFull={showFull} />;
    footer = (
      <>
        <Counters platform={platform} payload={payload} />
        {platform === 'linkedin' && mode === 'feed' ? (
          <Button type="button" variant="outline" size="sm" aria-pressed={showFull} onClick={() => setShowFull((v) => !v)}>
            {showFull ? 'Show the cut in the feed' : 'Show full content'}
          </Button>
        ) : null}
      </>
    );
  } else if (platform === 'hackernews' || platform === 'reddit') {
    if (platform === 'hackernews') {
      controls.push({
        label: 'View',
        value: submission,
        onChange: (v) => setSubmission(v as 'listing' | 'fields'),
        options: [
          { value: 'listing', label: 'Listing' },
          { value: 'fields', label: 'Submit form' },
        ],
      });
    }
    body = <SubmissionSkin {...base} view={submission} subreddit={input.extras?.options?.subreddit} />;
    footer = (
      <p>
        Title: {[...payload.title].length} of {info.limits.title} characters.
        {platform === 'hackernews' ? ' A submission takes a link or text, not both.' : ''}
      </p>
    );
  } else if (platform === 'youtube') {
    controls.push({
      label: 'View',
      value: video,
      onChange: (v) => setVideo(v as 'card' | 'watch'),
      options: [
        { value: 'card', label: 'Card' },
        { value: 'watch', label: 'Watch page' },
      ],
    });
    body = <VideoSkin {...base} view={video} />;
    footer = (
      <p>
        Title: {[...payload.title].length} of {info.limits.title}. Description: {[...payload.bodyMarkdown].length.toLocaleString('en')} of {info.limits.body?.toLocaleString('en')} characters.
      </p>
    );
  } else {
    if (platform === 'substack') {
      controls.push({
        label: 'View',
        value: newsletter,
        onChange: (v) => setNewsletter(v as 'inbox' | 'opened'),
        options: [
          { value: 'inbox', label: 'Inbox' },
          { value: 'opened', label: 'Opened' },
        ],
      });
    }
    body = <ArticleSkin {...base} view={newsletter} />;
    footer = (
      <p>
        {[...payload.bodyMarkdown].length.toLocaleString('en')} characters
        {info.limits.body ? ` of ${info.limits.body.toLocaleString('en')}` : ''}. {payload.tags.length} {payload.tags.length === 1 ? 'tag' : 'tags'}
        {info.limits.tagsMax ? ` of ${info.limits.tagsMax}` : ''}.
      </p>
    );
  }

  return (
    <PreviewFrame name={info.name} device={device} onDevice={setDevice} appearance={appearance} onAppearance={setAppearance} controls={controls} footer={footer} {...(className ? { className } : {})}>
      {body}
    </PreviewFrame>
  );
}
