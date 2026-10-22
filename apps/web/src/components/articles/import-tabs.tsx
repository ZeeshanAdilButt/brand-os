'use client';

import { FileUp, FolderOpen, Globe } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImportFile, ImportFolder, ImportUrl, type FolderStatusDTO } from './import-panels';

type Tab = 'file' | 'url' | 'folder';

const TABS: { id: Tab; label: string; icon: typeof FileUp }[] = [
  { id: 'file', label: 'File', icon: FileUp },
  { id: 'url', label: 'Web page', icon: Globe },
  { id: 'folder', label: 'Folder', icon: FolderOpen },
];

/** One import method at a time. Each says plainly what is missing when you press Import with nothing chosen. */
export function ImportTabs({ folder }: { folder: FolderStatusDTO }) {
  const [tab, setTab] = useState<Tab>('file');
  return (
    <div className="max-w-3xl rounded-xl border bg-surface">
      <div role="tablist" aria-label="Where to import from" className="flex gap-1 border-b p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`import-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`import-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const order = TABS.map((t) => t.id);
              const at = order.indexOf(tab);
              if (event.key === 'ArrowRight') setTab(order[(at + 1) % order.length]!);
              if (event.key === 'ArrowLeft') setTab(order[(at + order.length - 1) % order.length]!);
            }}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-[120ms]',
              tab === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`import-panel-${tab}`} aria-labelledby={`import-tab-${tab}`} className="p-5">
        {tab === 'file' ? <ImportFile /> : tab === 'url' ? <ImportUrl /> : <ImportFolder initial={folder} />}
      </div>
    </div>
  );
}
