import { devtoTransform } from './devto.js';
import { linkedinTransform } from './linkedin.js';
import type { PlatformId } from '../ids.js';
import type { Transform } from './types.js';

/**
 * Transforms by platform. Typed over every `PlatformId` (partial), so adding a
 * platform later is one entry here and no consumer changes.
 * Payload types are per platform, hence `any` at this level.
 */
export type TransformRegistry = Partial<Record<PlatformId, Transform<any>>>;

export const transforms: TransformRegistry = {
  devto: devtoTransform,
  linkedin: linkedinTransform,
};
