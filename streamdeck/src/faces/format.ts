/** Text helpers for key faces: compact numbers, safe truncation and XML escaping. */

/**
 * A count short enough for a 72 px key. Exact up to 9,999, then abbreviated
 * — always rounded *down*, so a key never claims more encounters than happened:
 *
 *   9999 -> "9999", 12_345 -> "12.3k", 99_999 -> "99.9k", 123_456 -> "123k",
 *   1_234_567 -> "1.2M", 12_345_678 -> "12M"
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const n = Math.floor(value);
  if (n < 10_000) return String(n);
  if (n < 100_000) return `${trimZero(Math.floor(n / 100) / 10)}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1_000)}k`;
  if (n < 10_000_000) return `${trimZero(Math.floor(n / 100_000) / 10)}M`;
  if (n < 1_000_000_000) return `${Math.floor(n / 1_000_000)}M`;
  return `${Math.floor(n / 1_000_000_000)}B`;
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/** At most `max` code points; longer text ends in an ellipsis (counted within `max`). */
export function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points
    .slice(0, Math.max(1, max - 1))
    .join('')
    .trimEnd()}…`;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escapes text for use in SVG element content and attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}
