/**
 * The dashboard's only way to build HTML: a tagged template that escapes every interpolated value.
 *
 *   html`<p>${draft.payload.text}</p>`        // text is escaped
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   // nested fragments stay as built
 *   raw(TRUSTED_CONSTANT)                       // only for markup this code wrote itself
 *
 * Nothing user-, platform- or Claude-supplied may ever go through `raw`.
 */

/** Markup that is already safe: built by `html` or wrapped by `raw`. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes text for an element body or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] as string);
}

/** Marks a trusted fragment (a constant written in this code base) as safe. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === undefined || value === null || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

/** The tagged template. Every `${value}` is escaped unless it is a `SafeHtml`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}
