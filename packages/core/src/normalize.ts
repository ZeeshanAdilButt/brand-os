/** Strip a leading BOM and normalise CRLF/CR to LF, so a file parses the same on any checkout. */
export function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
