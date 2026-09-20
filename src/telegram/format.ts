// Central Telegram formatting helpers (UX overhaul).
//
// Admin/user-facing views that opt into Telegram HTML get a single, audited
// escaping boundary here. Rules:
// - EVERY dynamic value passes through escapeHtml() (via code()/line helpers)
//   before interpolation; no raw interpolation anywhere.
// - Static template text is authored without raw < > & characters.
// - Truncation is HTML-aware: it never cuts inside a tag (which would send a
//   malformed document to Telegram and fail the whole message).

export const MAX_PAGE_CHARS = 3800;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline code for copy-friendly technical values (ids, models, URLs, commands). */
export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

/** HTML-aware clamp: truncates, then repairs a trailing incomplete tag. */
export function clampHtml(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;
  let cut = text.slice(0, MAX_PAGE_CHARS);
  const lastTagEnd = cut.lastIndexOf('>');
  const lastTagStart = cut.lastIndexOf('<');
  if (lastTagStart > lastTagEnd) cut = cut.slice(0, lastTagStart);
  return `${cut}…`;
}

/** Plain-text clamp (no HTML views). */
export function clampText(text: string, max = 3800): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
