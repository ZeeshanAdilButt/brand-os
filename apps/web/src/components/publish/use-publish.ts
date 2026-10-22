'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import type { DestinationDTO, PayloadField, PlatformDraftDTO, PlatformId } from '@/lib/publishing';

export interface Notice {
  tone: 'error' | 'success' | 'info';
  text: string;
}

/** What an edit did, as the server reports it. */
export interface EditResult {
  draft: PlatformDraftDTO;
  changed: boolean;
  fields: string[];
  voidedApproval: boolean;
  message: string;
}

export interface EditPatch {
  title?: string;
  description?: string;
  tags?: string[];
  canonicalUrl?: string | null;
  coverImageUrl?: string | null;
  series?: string | null;
  bodyMarkdown?: string;
  options?: { subreddit?: string; instance?: string };
  site?: { updateExisting?: boolean; path?: string };
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Everything the publishing screens do to destinations, in one place so the guided steps and the composer agree.
 * Each call updates the one destination it touched; nothing here changes another. Calls return an outcome and also
 * leave a plain-language notice on the destination, so a failure is never silent.
 */
export function usePublish(articleId: string, initial: DestinationDTO[]) {
  const [destinations, setDestinations] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Partial<Record<PlatformId, Notice>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setNotice = useCallback((platform: PlatformId, notice: Notice | undefined) => setNotices((current) => ({ ...current, [platform]: notice })), []);

  const reload = useCallback(async () => {
    const result = await api<{ destinations: DestinationDTO[] }>(`/api/articles/${articleId}/destinations`);
    if (!alive.current) return;
    if (result.ok) {
      setDestinations(result.data.destinations);
      setLoadError(null);
    } else setLoadError(result.network ? 'Could not load the destinations while offline.' : result.error);
  }, [articleId]);

  const putDraft = useCallback((draft: PlatformDraftDTO) => {
    setDestinations((current) => current.map((d) => (d.platform === draft.platform ? { ...d, draft, added: true } : d)));
  }, []);

  async function run<T>(platform: PlatformId, name: string, call: () => Promise<ApiResult<T>>, done: (data: T) => Notice | undefined): Promise<Outcome<T>> {
    setBusy(`${platform}:${name}`);
    setNotice(platform, undefined);
    const result = await call();
    setBusy(null);
    if (result.ok) {
      setNotice(platform, done(result.data));
      return { ok: true, data: result.data };
    }
    const error = result.network ? 'Could not reach the app server. If you were publishing, check on the platform before trying again.' : result.error;
    setNotice(platform, { tone: 'error', text: error });
    return { ok: false, error };
  }

  const draftOf = (platform: PlatformId) => destinations.find((d) => d.platform === platform)?.draft ?? null;

  return {
    destinations,
    busy,
    notices,
    loadError,
    reload,
    putDraft,
    setNotice,
    draftOf,
    isBusy: (platform: PlatformId, name?: string) => (busy ? (name ? busy === `${platform}:${name}` : busy.startsWith(`${platform}:`)) : false),
    anyBusy: busy !== null,

    async add(platform: PlatformId) {
      setBusy(`${platform}:add`);
      const result = await api(`/api/articles/${articleId}/destinations`, { method: 'POST', json: { platform } });
      setBusy(null);
      if (result.ok) {
        setDestinations((current) => current.map((d) => (d.platform === platform ? { ...d, added: true } : d)));
        return true;
      }
      setNotice(platform, { tone: 'error', text: result.error });
      return false;
    },

    async remove(platform: PlatformId) {
      return run(platform, 'remove', () => api(`/api/articles/${articleId}/destinations/${platform}`, { method: 'DELETE' }), () => {
        setDestinations((current) => current.map((d) => (d.platform === platform ? { ...d, added: false, draft: null } : d)));
        return undefined;
      });
    },

    prepare(platform: PlatformId, options: { discardEdits?: boolean; coverImageUrl?: string | null; series?: string | null } = {}) {
      return run(
        platform,
        'prepare',
        () => api<PlatformDraftDTO>('/api/platform-drafts', { json: { articleId, platform, ...options } }),
        (draft) => {
          putDraft(draft);
          const errors = draft.lint.filter((i) => i.severity === 'error').length;
          return { tone: errors > 0 ? 'error' : 'success', text: errors > 0 ? `Prepared. Fix ${errors} ${errors === 1 ? 'problem' : 'problems'} before it can go further.` : 'Prepared from your article. Nothing was sent.' };
        },
      );
    },

    edit(platform: PlatformId, draftId: string, expectedHash: string, patch: EditPatch) {
      return run(
        platform,
        'edit',
        () => api<EditResult>(`/api/platform-drafts/${draftId}`, { method: 'PATCH', json: { expectedHash, ...patch } }),
        (result) => {
          putDraft(result.draft);
          return { tone: result.voidedApproval ? 'info' : 'success', text: result.message };
        },
      );
    },

    reset(platform: PlatformId, draftId: string, fields?: PayloadField[]) {
      return run(
        platform,
        'reset',
        () => api<EditResult>(`/api/platform-drafts/${draftId}/reset`, { method: 'POST', json: fields ? { fields } : {} }),
        (result) => {
          putDraft(result.draft);
          return { tone: 'success', text: result.changed ? 'Back to what was generated from your article.' : 'It already matches what was generated.' };
        },
      );
    },

    stage(platform: PlatformId, draftId: string) {
      return run(
        platform,
        'stage',
        () => api<{ ok: boolean; message: string; draft: PlatformDraftDTO }>(`/api/platform-drafts/${draftId}/stage`, { method: 'POST', json: {} }),
        (result) => {
          putDraft(result.draft);
          return { tone: result.ok ? 'success' : 'error', text: result.message };
        },
      );
    },

    ask(platform: PlatformId, draftId: string, mode: 'publish' | 'manual' = 'publish') {
      return run(
        platform,
        'ask',
        () => api<{ draft: PlatformDraftDTO; link: string }>(`/api/platform-drafts/${draftId}/request-approval`, { method: 'POST', json: { mode } }),
        (result) => {
          putDraft(result.draft);
          return { tone: 'info', text: 'Review the exact post below. This request expires in 30 minutes and works once.' };
        },
      );
    },

    approve(platform: PlatformId, approvalId: string, checked: string[]) {
      return run(
        platform,
        'approve',
        () => api<{ outcome: 'published' | 'failed' | 'unknown'; message: string; draft: PlatformDraftDTO }>(`/api/approvals/${approvalId}/approve`, { method: 'POST', json: { checked } }),
        (result) => {
          putDraft(result.draft);
          return { tone: result.outcome === 'published' ? 'success' : 'error', text: result.message };
        },
      );
    },

    decline(platform: PlatformId, approvalId: string) {
      return run(
        platform,
        'decline',
        () => api<PlatformDraftDTO>(`/api/approvals/${approvalId}/decline`, { method: 'POST', json: {} }),
        (draft) => {
          putDraft(draft);
          return { tone: 'success', text: 'Declined. Nothing was sent.' };
        },
      );
    },

    check(platform: PlatformId, draftId: string) {
      return run(
        platform,
        'check',
        () => api<{ remote: string; message: string; draft: PlatformDraftDTO }>(`/api/platform-drafts/${draftId}/check`, { method: 'POST', json: {} }),
        (result) => {
          putDraft(result.draft);
          return { tone: result.remote === 'published' || result.remote === 'private' ? 'success' : 'error', text: result.message };
        },
      );
    },

    mark(platform: PlatformId, draftId: string, body: { outcome: 'posted' | 'not_posted'; remoteUrl?: string }) {
      return run(
        platform,
        'mark',
        () => api<PlatformDraftDTO>(`/api/platform-drafts/${draftId}/mark`, { method: 'POST', json: { ...body, confirm: true } }),
        (draft) => {
          putDraft(draft);
          return { tone: 'success', text: body.outcome === 'posted' ? 'Recorded as posted by hand.' : 'Recorded as not posted. You can ask for approval again.' };
        },
      );
    },

    record(platform: PlatformId, approvalId: string, body: { checked: string[]; url: string }) {
      return run(
        platform,
        'record',
        () => api<{ outcome: 'recorded'; message: string; draft: PlatformDraftDTO }>(`/api/approvals/${approvalId}/record`, { method: 'POST', json: body }),
        (result) => {
          putDraft(result.draft);
          return { tone: 'success', text: result.message };
        },
      );
    },

    async exportFile(draftId: string) {
      const result = await api<{ filename: string; mime: string; content: string }>(`/api/platform-drafts/${draftId}/export`);
      return result.ok ? result.data : null;
    },

    async checkCanonical() {
      const result = await api<{ check: unknown; reason: string | null }>(`/api/articles/${articleId}/canonical-check`, { method: 'POST', json: {} });
      if (result.ok) await reload();
      return result;
    },

  };
}

export type PublishApi = ReturnType<typeof usePublish>;
