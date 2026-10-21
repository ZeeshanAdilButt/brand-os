const MASK = '[REDACTED]';

/**
 * Masks anything shaped like a secret, for logs and error text. Best effort and deliberately
 * conservative about plain words: the rules, in order, are
 *
 * 0. This system's own API tokens, `cph_<scope>_<43 base64url chars>` (always masked, any content).
 * 1. `Authorization: [<scheme>] <value>` headers, any scheme (Bearer, Basic, Bot, OAuth, ...): the
 *    scheme word stays, everything after it to the end of the line (or the closing quote) is masked.
 * 2. A bare `Bearer <token>` (6+ token characters).
 * 3. `name: value` / `name=value` / JSON `"name":"value"` pairs where the name ends in api-key,
 *    secret, token or password (`x-api-key`, `client_secret`, `refresh_token`, ...).
 * 4. Padded standard base64 of 32+ characters (a 32-byte key encodes to 43 characters plus `=`).
 * 5. Runs of 32+ base64url or hex characters (`A-Za-z0-9_-`) that look random: a run with no
 *    `-` or `_` and a digit; a run with them, a digit and an upper-case letter; or a digit-free run
 *    whose letter case flips often (random mixed case flips about half the time, camelCase about
 *    one letter in five). So `prometheus-cardinality-explained` and
 *    `createSomeVeryLongIdentifierName` survive, while tokens, JWT segments and hex digests do not.
 *
 * Known false positives: a 40-char git SHA or any lone hex digest of 32+ characters is masked.
 * Known gaps: an unpadded standard-base64 secret that contains `+` or `/` and is not labelled by
 * rule 3 is split at those characters and may survive; labelled ones are caught by rule 3.
 */
export function redact(input: string): string {
  return input
    .replace(OWN_TOKEN, MASK)
    .replace(AUTHORIZATION, maskAuthorization)
    .replace(BEARER, (_m, head: string) => `${head}${MASK}`)
    .replace(LABELLED, (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
    .replace(PADDED_BASE64, MASK)
    .replace(TOKEN_RUN, (run) => (looksRandom(run) ? MASK : run));
}

const OWN_TOKEN = /(?<![A-Za-z0-9_])cph_[a-z]+_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const AUTHORIZATION =
  /\b(authorization["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n]*))/gi;
const BEARER =/\b(bearer\s+)[A-Za-z0-9._~+/=_-]{6,}/gi;
const LABELLED =
  /\b([\w-]*?(?:api[-_]?key|secret(?:[-_]?access)?[-_]?key|secret|token|password|passwd))(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const PADDED_BASE64 = /[A-Za-z0-9+/]{32,}={1,2}/g;
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskAuthorization(
  _m: string,
  head: string,
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  bare: string | undefined,
): string {
  const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
  const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
  const scheme = /^([A-Za-z][\w.-]*)\s+\S/.exec(value)?.[1];
  return `${head}${quote}${scheme ? `${scheme} ` : ''}${MASK}${quote}`;
}

function looksRandom(run: string): boolean {
  if (UUID.test(run)) return false;
  if (/\d/.test(run)) return !/[-_]/.test(run) || /[A-Z]/.test(run);
  return caseFlipRatio(run) >= 0.3;
}

/** Share of adjacent letter pairs whose case differs (0 for single-case text). */
function caseFlipRatio(run: string): number {
  let pairs = 0;
  let flips = 0;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1] as string;
    const b = run[i] as string;
    if (!/[A-Za-z]/.test(a) || !/[A-Za-z]/.test(b)) continue;
    pairs++;
    if ((a === a.toUpperCase()) !== (b === b.toUpperCase())) flips++;
  }
  return pairs === 0 ? 0 : flips / pairs;
}
