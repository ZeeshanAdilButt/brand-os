import { MAX_IMAGE_BYTES } from '../../lib/articles';
import type { StorageExtension } from '../storage';

/** Largest accepted upload. The editor knows the same number (lib/articles) and refuses a bigger file up front. */
export const MAX_ASSET_BYTES = MAX_IMAGE_BYTES;

export const ALLOWED_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
} as const satisfies Record<string, StorageExtension>;

export type AssetMime = keyof typeof ALLOWED_IMAGE_TYPES;

export interface InspectedImage {
  mime: AssetMime;
  extension: StorageExtension;
}

export class AssetRejectedError extends Error {
  constructor(
    readonly reason: 'empty' | 'too_large' | 'unsupported' | 'unsafe_svg',
    message: string,
  ) {
    super(message);
    this.name = 'AssetRejectedError';
  }
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, i) => bytes[offset + i] === value);
}

/**
 * Decide what a file is from its bytes. The name and the type the browser claimed are ignored:
 * both are chosen by the sender. Anything that is not a PNG, JPEG, GIF, WebP or a clean SVG throws.
 */
export function inspectImage(bytes: Uint8Array): InspectedImage {
  if (bytes.length === 0) throw new AssetRejectedError('empty', 'The file is empty.');
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AssetRejectedError('too_large', `The file is larger than ${MAX_ASSET_BYTES / (1024 * 1024)} MB.`);
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', extension: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', extension: 'jpg' };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { mime: 'image/gif', extension: 'gif' };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', extension: 'webp' };
  }
  const svg = looksLikeSvg(bytes);
  if (svg !== null) {
    const problem = findSvgProblem(svg);
    if (problem) throw new AssetRejectedError('unsafe_svg', problem);
    return { mime: 'image/svg+xml', extension: 'svg' };
  }
  throw new AssetRejectedError('unsupported', 'Only PNG, JPEG, GIF, WebP and SVG images can be uploaded.');
}

/** The SVG text when the bytes are an XML document whose root element is <svg>, otherwise null. */
function looksLikeSvg(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '');
  // Skip an XML declaration, comments, a plain DOCTYPE and whitespace, then expect the root element.
  const head = text.replace(/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>[]*>)*/i, '');
  return /^<svg[\s>/]/i.test(head) ? text : null;
}

/**
 * SVG can carry script, event handlers and references to other files. It is refused (not edited:
 * a changed file would be a surprise) when it contains anything that can run or fetch. Serving adds
 * a Content-Security-Policy on top, so this is a second layer, not the only one.
 */
export function findSvgProblem(svg: string): string | null {
  const lower = svg.toLowerCase();
  const checks: [RegExp, string][] = [
    [/<\s*script\b/, 'it contains a script element'],
    [/<\s*foreignobject\b/, 'it contains a foreignObject element'],
    [/<\s*(iframe|embed|object|audio|video|canvas)\b/, 'it embeds other content'],
    [/<!entity\b/, 'it declares entities'],
    [/<!doctype[^>]*\[/, 'its DOCTYPE has an internal subset'],
    [/\son[a-z]+\s*=/, 'it has an event handler attribute'],
    [/javascript\s*:/, 'it contains a javascript: link'],
    [/data\s*:\s*text\/html/, 'it contains an HTML data URL'],
    [/@import\b/, 'it imports a stylesheet'],
    [/<\s*(set|animate|animatetransform|animatemotion)\b[^>]*\battributename\s*=\s*["']?(href|xlink:href)/, 'it animates a link target'],
  ];
  for (const [pattern, why] of checks) {
    if (pattern.test(lower)) return `This SVG was not accepted because ${why}. Export it as PNG, or remove that part.`;
  }
  // Any link or url() must stay inside the file (#fragment) or be an embedded image.
  for (const match of lower.matchAll(/(?:xlink:href|\bhref)\s*=\s*["']\s*([^"']*)["']/g)) {
    const target = (match[1] ?? '').trim();
    if (target !== '' && !target.startsWith('#') && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(target)) {
      return 'This SVG was not accepted because it links to something outside the file. Export it as PNG, or remove the link.';
    }
  }
  for (const match of lower.matchAll(/url\(\s*["']?\s*([^)"']*)/g)) {
    const target = (match[1] ?? '').trim();
    if (target !== '' && !target.startsWith('#') && !target.startsWith('data:image/')) {
      return 'This SVG was not accepted because it loads something from outside the file. Export it as PNG, or remove the reference.';
    }
  }
  return null;
}

/** A name safe to show and to put in a download header: no path parts, no control characters. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned.replace(/^\.+/, '') || 'image';
}
