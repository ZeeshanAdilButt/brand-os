import type { DraftKind, PlatformId } from '../ids.js';
import type { ContentItem, LintResult } from '../model.js';

/**
 * Platform-specific rendering and lint (spec 2.5). Pure: no I/O, no clock.
 * `skeleton` builds the deterministic defaults; `lint` validates a payload,
 * including one that Claude has adapted, against the source item.
 */
export interface Transform<P> {
  platform: PlatformId;
  kind: DraftKind;
  skeleton(item: ContentItem): P;
  lint(p: P, item: ContentItem): LintResult[];
}
