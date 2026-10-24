/**
 * The id of every platform in the directory (see `lib/directory.ts`). One list, so the database column, the
 * connector registry and the directory agree, and a test fails when one of them drifts from the others.
 */
export const CONNECTOR_IDS = [
  // composer destinations
  'devto',
  'hashnode',
  'site',
  'medium',
  'substack',
  'linkedin',
  'x',
  'bluesky',
  'threads',
  'mastodon',
  'reddit',
  'hackernews',
  'youtube',
  // blogs
  'ghost',
  'wordpress',
  'beehiiv',
  'buttondown',
  // communities
  'lobsters',
  'discord',
  'slack',
  // video
  'linkedin_video',
  'video_other',
  // conferences
  'sessionize',
  'papercall',
  'kubecon',
  'srecon',
  'fosdem',
  'devopsdays',
  'platformcon',
  'gophercon',
  'postgres_conferences',
  // editorial
  'infoq',
  'cncf_blog',
  'dzone',
  'freecodecamp',
  'lf_publications',
  'newsletters',
  // launches
  'github_releases',
  'product_hunt',
  'show_hn',
  'npm',
  'pypi',
  'crates',
  // aggregators
  'buffer',
  'postiz',
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && (CONNECTOR_IDS as readonly string[]).includes(value);
}
