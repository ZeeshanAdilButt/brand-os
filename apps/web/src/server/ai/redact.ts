/**
 * Keep keys out of anything a person or a log could see. Every error message that mentions a provider
 * passes through here with the key it was using, so even a server that echoes the key back in an error
 * page cannot leak it.
 */

const MASK = '[redacted]';

/** Header-like and key-shaped text, whatever the exact key is. */
const PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(x-api-key|api-key|apikey|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi,
  /\b(sk|pk|rk|bos|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g,
];

/**
 * Replace every occurrence of the given secrets, and anything shaped like a key or an auth header,
 * with a mask. Secrets shorter than 6 characters are ignored so a short value cannot wreck the text.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join(MASK);
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, name: unknown, sep: unknown) =>
      typeof name === 'string' && typeof sep === 'string' && /^(x-api-key|api-key|apikey|authorization)$/i.test(name) ? `${name}${sep}${MASK}` : MASK,
    );
  }
  return out;
}
