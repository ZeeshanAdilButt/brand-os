/** Phase 1 delivery plan. Mirrors TODO.md; the UI uses it to say honestly when a feature arrives. */
export interface RoadmapDay {
  day: number;
  title: string;
  summary: string;
  built: boolean;
}

export const ROADMAP: readonly RoadmapDay[] = [
  { day: 1, title: 'Foundation', summary: 'App shell, embedded database, health checks, design system.', built: true },
  { day: 2, title: 'Accounts and knowledge', summary: 'Local owner and sign-in, private knowledge items, full-text search, tenant isolation.', built: true },
  { day: 3, title: 'Article studio', summary: 'Markdown editor, imports, versions, previews. No AI needed.', built: false },
  { day: 4, title: 'AI and Claude MCP', summary: 'MCP server for your own Claude Code, optional local or bring-your-own-key AI.', built: false },
  { day: 5, title: 'Publishing connectors', summary: 'DEV.to first, with the approval gate. Hashnode where supported.', built: false },
  { day: 6, title: 'Publishing workflow', summary: 'One article, several destinations, each previewed and approved on its own.', built: false },
  { day: 7, title: 'Hardening', summary: 'End-to-end tests, isolation checks, backup and export.', built: false },
];

export function dayInfo(day: number): RoadmapDay {
  const found = ROADMAP.find((d) => d.day === day);
  if (!found) throw new Error(`Unknown roadmap day ${day}`);
  return found;
}
