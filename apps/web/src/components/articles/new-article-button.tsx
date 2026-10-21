'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ArticleDTO } from '@/lib/articles';
import { api } from '@/lib/api-client';

/** Creates an empty draft and opens it in the studio. */
export function NewArticleButton({ label = 'New article', variant = 'default' }: { label?: string; variant?: 'default' | 'outline' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await api<ArticleDTO>('/api/articles', { method: 'POST', json: {} });
    if (result.ok) {
      router.push(`/articles/${result.data.id}`);
      return;
    }
    setBusy(false);
    setError(result.network ? 'Could not reach the server.' : result.error);
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" variant={variant} onClick={create} disabled={busy}>
        <Plus aria-hidden />
        {busy ? 'Creating' : label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
