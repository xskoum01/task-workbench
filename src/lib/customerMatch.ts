import type { Customer } from '../types';

interface MatchInput {
  senderEmail?: string;
  senderName?: string;
  title?: string;
  content?: string;
  aiCustomerName?: string;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Strips diacritics/accents from a string and lowercases it.
 * "Ptáček" → "ptacek", "CRM_Neopharma" → "crm_neopharma"
 * Used so that e.g. "ptáček" in email text matches a stored customer named "Ptacek".
 */
function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')               // decompose diacritics ("á" → "a" + combining acute)
    .replace(/\p{M}/gu, '')         // strip combining marks
    .toLowerCase();
}

/**
 * Builds a set of normalised name variants for a customer.
 * Includes the raw name, shortCode, folderName, and the stripped-CRM_ form.
 * Each variant is at least 3 chars to avoid spurious single-char matches.
 */
function customerVariants(c: Customer): string[] {
  const variants = new Set<string>();

  const addVariant = (raw: string) => {
    const n = normalizeForMatch(raw);
    if (n.length > 2) variants.add(n);
    // Strip CRM_ / CRM- prefix and underscores — "CRM_Ptacek_Prod" → "ptacek prod"
    const stripped = n
      .replace(/^crm[_\-]/i, '')
      .replace(/[_\-]+/g, ' ')
      .trim();
    if (stripped.length > 2) variants.add(stripped);
    // Also add the first token only ("ptacek" from "ptacek prod") for partial matches
    const firstToken = stripped.split(/\s+/)[0] ?? '';
    if (firstToken.length > 2) variants.add(firstToken);
  };

  addVariant(c.name);
  addVariant(c.shortCode);
  if (c.folderName) addVariant(c.folderName);

  return Array.from(variants);
}

/**
 * Tries to deterministically match a Customer from import metadata.
 * Returns the best match or null when no confident match is found.
 *
 * Priority order:
 *   1. Sender email domain root matches customer name, shortCode, or folder name
 *   2. Customer name / shortCode / folder name appears in message text
 *      (both sides normalised: diacritics stripped, case-folded, CRM_ prefix removed)
 *      Also handles Czech inflection: "Ptáčkovi" (locative) matches "Ptáček"/"Ptacek"
 *      by checking whether any word token in the text starts with a stem of the variant.
 *   3. AI-derived customer name partially matches a known customer
 *
 * Normalization ensures "Ptáček" in text matches "Ptacek" in storage and vice versa.
 */
export function matchCustomer(customers: Customer[], opts: MatchInput): Customer | null {
  if (!customers.length) return null;

  const email      = (opts.senderEmail ?? '').toLowerCase();
  const domain     = email.includes('@') ? email.split('@')[1] ?? '' : '';
  // e.g. "contoso" from "contoso.com" or "mail.contoso.co.uk"
  const domainRoot = domain.split('.').find((part) => part.length > 2) ?? '';

  // Normalise all search text in one pass (diacritics stripped + lowercased).
  // Include title, full content, and sender name so customer mentions anywhere match.
  const rawText = `${opts.title ?? ''} ${opts.content ?? ''} ${opts.senderName ?? ''}`;
  const normText = normalizeForMatch(rawText);

  // Pre-split the normalised text into word tokens for stem matching.
  // Keeps only tokens ≥ 3 chars; punctuation stripped from boundaries.
  const textTokens = normText
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  /**
   * Returns true when a customer name variant is found in the normalised text.
   *
   * Two checks, in order:
   *   1. Substring: normText.includes(v)  — handles full-form matches in English text.
   *   2. Stem prefix (Czech inflection): for variants ≥ 5 chars, build a stem by removing
   *      the last 2 characters. If any text token starts with that stem, it is a sufficient
   *      match. This handles cases like "ptacek" (stem "ptac") matching "ptackovi" (locative).
   *      Minimum stem length is 4 to avoid spurious matches from very short names.
   */
  function textMatchesVariant(v: string): boolean {
    if (normText.includes(v)) return true;
    // Stem-prefix matching for inflected languages (Czech)
    if (v.length >= 5) {
      const stem = v.slice(0, v.length - 2); // e.g. "ptacek" → "ptac"
      if (stem.length >= 4) {
        const matchedTok = textTokens.find((tok) => tok.startsWith(stem));
        if (matchedTok) {
          console.log(`[customer-match] stem match: variant="${v}" stem="${stem}" token="${matchedTok}"`);
          return true;
        }
      }
    }
    return false;
  }

  // Priority 1: domain root matches customer attributes (email-based match)
  if (domainRoot.length > 2) {
    const normDomain = normalizeForMatch(domainRoot);
    for (const c of customers) {
      for (const v of customerVariants(c)) {
        if (v.includes(normDomain) || normDomain.includes(v)) {
          console.debug(`[customer-match] domain match: "${domainRoot}" → "${c.name}"`);
          return c;
        }
      }
    }
  }

  // Priority 1: domain root matches customer attributes (email-based match)
  if (domainRoot.length > 2) {
    const normDomain = normalizeForMatch(domainRoot);
    for (const c of customers) {
      for (const v of customerVariants(c)) {
        if (v.includes(normDomain) || normDomain.includes(v)) {
          console.log(`[customer-match] domain match: "${domainRoot}" → "${c.name}"`);
          return c;
        }
      }
    }
  }

  // Priority 2: customer variant appears in message text (normalised both sides)
  const allVariants = customers.map((c) => ({ c, variants: customerVariants(c) }));
  console.log(
    `[customer-match] title="${opts.title?.slice(0, 60) ?? ''}"`,
    `candidates=[${allVariants.map(({ c, variants }) => `${c.name}:(${variants.join('|')})`).join(', ')}]`,
  );
  console.log(`[customer-match] normText tokens=[${textTokens.slice(0, 12).join(', ')}]`);

  for (const { c, variants } of allVariants) {
    for (const v of variants) {
      if (textMatchesVariant(v)) {
        console.log(`[customer-match] text match: variant="${v}" → "${c.name}"`);
        return c;
      }
    }
  }

  // Priority 3: AI-derived name loosely matches a known customer
  if (opts.aiCustomerName) {
    const aiName = normalizeForMatch(opts.aiCustomerName.trim());
    if (aiName.length > 2) {
      for (const c of customers) {
        const normName = normalizeForMatch(c.name);
        if (normName.includes(aiName) || aiName.includes(normName.split(' ')[0] ?? '')) {
          console.log(`[customer-match] AI name match: "${opts.aiCustomerName}" → "${c.name}"`);
          return c;
        }
      }
    }
  }

  console.log(
    `[customer-match] NO MATCH for title="${opts.title?.slice(0, 60)}"`,
    `(${customers.length} customers checked)`,
  );
  return null;
}
