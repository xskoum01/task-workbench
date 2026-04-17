/**
 * Text normalization utilities for imported email and Teams message content.
 *
 * Handles the three common corruption sources:
 *   1. Mojibake -- UTF-8 bytes interpreted as Latin-1 (e.g. "A " from non-breaking space)
 *   2. HTML entities leaked from partial HTML-stripping
 *   3. Whitespace and control-character noise
 */

// ---------------------------------------------------------------------------
// Known mojibake sequences -> correct replacement
// All strings use \uXXXX escapes to avoid source-file encoding ambiguity.
// ---------------------------------------------------------------------------
const MOJIBAKE_MAP: [string, string][] = [
  // Non-breaking space (U+00A0) -- two common encodings
  ['\u00c2\u00a0', ' '],
  // Em dash (U+2014)
  ['\u00e2\u0080\u0094', '\u2014'],
  // En dash (U+2013)
  ['\u00e2\u0080\u0093', '\u2013'],
  // Left double quote (U+201C)
  ['\u00e2\u0080\u009c', '\u201c'],
  // Right double quote (U+201D)
  ['\u00e2\u0080\u009d', '\u201d'],
  // Left single quote (U+2018)
  ['\u00e2\u0080\u0098', '\u2018'],
  // Right single quote / apostrophe (U+2019)
  ['\u00e2\u0080\u0099', '\u2019'],
  // Ellipsis (U+2026)
  ['\u00e2\u0080\u00a6', '\u2026'],
  // Bullet (U+2022)
  ['\u00e2\u0080\u00a2', '\u2022'],
  // Degree sign (U+00B0)
  ['\u00c2\u00b0', '\u00b0'],
  // Copyright (U+00A9)
  ['\u00c2\u00a9', '\u00a9'],
  // Registered trademark (U+00AE)
  ['\u00c2\u00ae', '\u00ae'],
  // Czech ch (U+010D)
  ['\u00c4\u008d', '\u010d'],
  // Czech z-caron (U+017E)
  ['\u00c5\u00be', '\u017e'],
  // Czech s-caron (U+0161)
  ['\u00c5\u00a1', '\u0161'],
  // Czech r-caron (U+0159)
  ['\u00c5\u0099', '\u0159'],
  // "A " artifact from non-breaking space (the Â char followed by space)
  ['\u00c2 ', ' '],
];

// ---------------------------------------------------------------------------
// HTML entities -> text
// ---------------------------------------------------------------------------
const ENTITY_MAP: [RegExp, string][] = [
  [/&nbsp;/g,   ' '],
  [/&amp;/g,    '&'],
  [/&lt;/g,     '<'],
  [/&gt;/g,     '>'],
  [/&quot;/g,   '"'],
  [/&#39;/g,    "'"],
  [/&apos;/g,   "'"],
  [/&#x27;/g,   "'"],
  // Right single quote numeric refs
  [/&#x2019;/g, '\u2019'],
  [/&#8217;/g,  '\u2019'],
  [/&#8216;/g,  '\u2018'],
  [/&lsquo;/g,  '\u2018'],
  [/&rsquo;/g,  '\u2019'],
  // Dash entities
  [/&mdash;/g,  '\u2014'],
  [/&ndash;/g,  '\u2013'],
  [/&#8211;/g,  '\u2013'],
  [/&#8212;/g,  '\u2014'],
  // Double quote entities
  [/&ldquo;/g,  '\u201c'],
  [/&rdquo;/g,  '\u201d'],
  [/&#8220;/g,  '\u201c'],
  [/&#8221;/g,  '\u201d'],
  // Ellipsis
  [/&hellip;/g, '\u2026'],
  [/&#8230;/g,  '\u2026'],
  // Bullet
  [/&bull;/g,   '\u2022'],
];

// Residual HTML tags that survive plain stripping
const RESIDUAL_TAG_RE = /<[a-zA-Z/][^>]{0,200}>/g;

/**
 * Main normalization function.
 * Apply this to any imported message body / preview / extracted text.
 *
 * Steps:
 *   1. Fix known mojibake sequences
 *   2. Remove residual HTML tags
 *   3. Decode HTML entities
 *   4. Collapse excessive whitespace
 */
export function normalizeText(raw: string): string {
  if (!raw) return '';

  let text = raw;

  // 1. Mojibake replacements (split/join avoids regex special char issues)
  for (const [bad, good] of MOJIBAKE_MAP) {
    text = text.split(bad).join(good);
  }

  // 2. Remove residual HTML tags
  text = text.replace(RESIDUAL_TAG_RE, ' ');

  // 3. HTML entity decoding
  for (const [pattern, replacement] of ENTITY_MAP) {
    text = text.replace(pattern, replacement);
  }

  // 4. Collapse excessive whitespace (preserve single newlines)
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * Lightweight version for titles -- strips newlines and hard-limits length.
 */
export function normalizeTitle(raw: string, maxLength = 150): string {
  const cleaned = normalizeText(raw).replace(/\n+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}\u2026` : cleaned;
}
