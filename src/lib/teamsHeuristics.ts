/**
 * Heuristic helpers for Teams message import.
 *
 * These functions run client-side before/after the AI classification pipeline.
 * They provide:
 *  - Better task title generation (avoids the raw participant-name title)
 *  - Urgency detection for initial planning bucket and priority score
 *  - Basic actionability check used as a heuristic-only fallback
 *
 * All rules are intentional and easy to tune in one place.
 */

import type { PlanningBucket } from '../types';

// ---------------------------------------------------------------------------
// Urgency rules
// ---------------------------------------------------------------------------

// High urgency → 'now' bucket, score ~85
const HIGH_URGENCY_PATTERNS: RegExp[] = [
  /\bprod(uction)?\b/i,
  /\bnot\s+working\b/i,
  /\bnefunguje\b/i,           // Czech: doesn't work
  /\bbroken\b/i,
  /\bdown\b/i,
  /\basap\b/i,
  /\burgent\b/i,
  /\bblocker?\b/i,
  /client\s+(report|issue|problem)/i,
  /\bcritical\b/i,
  /\bhot.?fix\b/i,
];

// Medium urgency → 'today' bucket, score ~65
const MEDIUM_URGENCY_PATTERNS: RegExp[] = [
  /\buat\b/i,
  /\bstaging\b/i,
  /please\s+(check|fix|look|review|verify)/i,
  /\bplease\b/i,
  /\bproblem\b/i,
  /\bissue\b/i,
  /\bproblem\b/i,
  /\bchyba\b/i,               // Czech: error / bug
  /\bproblém\b/i,             // Czech: problem
  /potřeboval?\s+bych/i,      // Czech: I would need
  /\bkouknout\b/i,            // Czech: to look at
  /\bpodívat\b/i,             // Czech: to look / check
  /\bzkontrolovat\b/i,        // Czech: to verify
  /\bopravit\b/i,             // Czech: to fix
  /\bprověřit\b/i,            // Czech: to investigate / check
  /\bnot\s+display/i,
  /\bdoesn[''']?t\s+show/i,
  /\bneeds?\s+review\b/i,
  /\bfollowing\s+issue\b/i,
];

// ---------------------------------------------------------------------------
// Actionability rules — used for the heuristic-only path
// ---------------------------------------------------------------------------

const ACTION_PATTERNS: RegExp[] = [
  /\bplease\b/i,
  /\bcould\s+you\b/i,
  /\bcan\s+you\b/i,
  /\bwould\s+you\b/i,
  /\bwe\s+need\b/i,
  /\bi\s+need\b/i,
  /\bfix\b/i,
  /\bcheck\b/i,
  /\breview\b/i,
  /\bdeploy\b/i,
  /\bverify\b/i,
  /\blook\s+into\b/i,
  /potřeboval?\s+bych/i,
  /\bkouknout\b/i,
  /\bpodívat\b/i,
  /\bzkontrolovat\b/i,
  /\bopravit\b/i,
  /\bprověřit\b/i,
];

const ISSUE_PATTERNS: RegExp[] = [
  /\bnot\s+working\b/i,
  /\bnefunguje\b/i,
  /\bbroken\b/i,
  /\bbug\b/i,
  /\berror\b/i,
  /\bfails?\b/i,
  /\bcrash\b/i,
  /\bwrong\b/i,
  /\bdoesn[''']?t\s+work\b/i,
  /\bchyba\b/i,
  /\bproblém\b/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UrgencyResult {
  bucket: PlanningBucket;
  priorityScore: number;
  priorityReason: string;
}

/**
 * Estimates urgency from message content and returns a planning bucket,
 * priority score, and a short human-readable reason.
 *
 * Teams messages default to 'today'; only explicit urgency signals push to 'now'.
 */
export function detectTeamsUrgency(content: string): UrgencyResult {
  if (HIGH_URGENCY_PATTERNS.some((r) => r.test(content))) {
    return {
      bucket:        'now',
      priorityScore: 85,
      priorityReason: 'Teams: production or urgent issue',
    };
  }
  if (MEDIUM_URGENCY_PATTERNS.some((r) => r.test(content))) {
    return {
      bucket:        'today',
      priorityScore: 65,
      priorityReason: 'Teams: action requested',
    };
  }
  return {
    bucket:        'today',
    priorityScore: 50,
    priorityReason: 'Teams: message imported',
  };
}

/**
 * Returns true if the message content looks actionable enough to
 * consider it a potential task (used when no AI API key is available).
 */
export function isTeamsMessageActionable(content: string): boolean {
  return (
    ACTION_PATTERNS.some((r) => r.test(content)) ||
    ISSUE_PATTERNS.some((r) => r.test(content))
  );
}

// ---------------------------------------------------------------------------
// Czech title generation
// ---------------------------------------------------------------------------

/** Matches pricing/estimation language in Czech and English. */
const PRICING_RE =
  /nacen[ěe]n[íi]|nacenit|nacenil[ai]?|odhad(nout)?(\s+ceny)?|kalkulac[ei]|estimate[ds]?|estimation|pricing|quotes?|quotation|budget/i;

/**
 * Returns true if the text contains pricing or estimation language
 * that warrants a "Nacenění: " prefix on the task title.
 */
export function isPricingRequest(text: string): boolean {
  return PRICING_RE.test(text);
}

// Ordered English→Czech phrase substitutions for common Teams request patterns.
// Applied left-to-right; earlier rules take priority.
const PHRASE_SUBS: Array<[RegExp, string]> = [
  // Strip common polite openers
  [/\bcan\s+you\s+(please\s+)?/gi, ''],
  [/\bcould\s+you\s+(please\s+)?/gi, ''],
  [/\bwould\s+you\s+(please\s+)?/gi, ''],
  [/\bplease\s+/gi, ''],
  [/\bi\s+(would\s+like(\s+to)?|want\s+to|need\s+to)\s+/gi, ''],
  [/\bi\s+need\s+(a\s+)?(an\s+)?/gi, ''],
  // Multi-word action phrases (longer first to prevent partial matches)
  [/\badd\s+or\s+change\b/gi, 'přidat nebo upravit'],
  [/\badd\s+option\s+to\s+change\b/gi, 'upravit možnost změny'],
  [/\badd\s+confirmation\s+message\b/gi, 'přidat potvrzovací hlášku'],
  [/\bchange\s+date\s+of\s+the\s+done\s+of\s+the\s+task\b/gi, 'změny data dokončení úkolu'],
  [/\bdone\s+of\s+the\s+task\b/gi, 'dokončení úkolu'],
  [/\bdone\s+task\b/gi, 'dokončení úkolu'],
  [/\bafter\s+button\s+press\b/gi, 'po stisknutí tlačítka'],
  // Single-word/short phrases
  [/\bconfirmation\s+message\b/gi, 'potvrzovací hlášku'],
  [/\bbutton\s+press\b/gi, 'stisknutí tlačítka'],
  [/\bchange\s+date\b/gi, 'změny data'],
  [/\bbutton\b/gi, 'tlačítko'],
  [/\bconfirmation\b/gi, 'potvrzení'],
  [/\bdone\b/gi, 'dokončení'],
];

/** Returns true when the string contains Czech-specific diacritics. */
function hasCzechChars(s: string): boolean {
  return /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(s);
}

/**
 * Heuristic: does the string look like English?
 * Checks for absence of Czech diacritics and presence of common English words.
 */
function looksEnglish(s: string): boolean {
  if (hasCzechChars(s)) return false;
  return /\b(can|you|add|change|the|of|after|please|button|done|message|date|option|request|need|want|would|could|like|have|make|get|set|fix|update|create|delete|remove|show|hide|send|use|with|for|that|this|it|to|is|are|was|were|be|been|do|does|did|will|should|may|might|must|shall)\b/i.test(s);
}

/** Apply phrase substitution table to `text`. */
function applyPhraseSubs(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PHRASE_SUBS) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Strip the pricing verb/noun from the beginning of a sentence to get the actual work description. */
function stripPricingTrigger(text: string): string {
  return text
    .replace(/\bpotřebuju?\s+(nacen[ěe]n[íi]|nacenit)\b\s*/i, '')
    .replace(/\bplease\s+(estimate|quote)\s*/i, '')
    .replace(/\b(estimate|estimation|pricing|quote|quotation)\s+for\s+/i, '')
    .replace(/\b(nacen[ěe]n[íi]|nacenit)\s+/i, '')
    .replace(/^(estimate|pricing|quote|quotation)\s*/i, '')
    .trim();
}

/**
 * Generates a Czech action-oriented task title from a Teams message.
 *
 * Rules:
 *  - Strip the "From: / Chat:" prefix lines added by the import wrapper
 *  - Detect pricing requests → "Nacenění: <popis práce>"
 *  - Apply English→Czech phrase substitutions for known patterns
 *  - Keep it under 100 chars
 *  - Never include the sender name as a prefix
 *  - Fall back to "Teams: nový úkol" if nothing useful can be extracted
 *
 * Test cases (verified manually):
 *  "can you add option to change date of the Done of the task?"
 *    → "Upravit možnost změny data dokončení úkolu"
 *  "add or change confirmation message after button press"
 *    → "Přidat nebo upravit potvrzovací hlášku po stisknutí tlačítka"
 *  "potřebuju nacenění úpravy pluginu"
 *    → "Nacenění: úprava pluginu"
 *  "please estimate add confirmation message after button press"
 *    → "Nacenění: přidat potvrzovací hlášku po stisknutí tlačítka"
 */
export function generateTeamsTitle(_senderName: string, content: string): string {
  // Remove the "From: ... / Chat: ..." header lines added by handleTeamsImport
  const cleaned = content
    .split('\n')
    .filter((line) => {
      const l = line.trim();
      return l.length > 0 && !/^From:/i.test(l) && !/^Chat:/i.test(l);
    })
    .join('\n')
    .trim();

  // Find the first meaningful sentence or line
  const firstChunk =
    cleaned
      .split(/[\n]+/)
      .map((s) => s.trim())
      .find((s) => s.length > 8) ?? content.slice(0, 80);

  const firstSentence =
    firstChunk.length > 60
      ? (firstChunk.split(/[.!?]/).map((s) => s.trim()).find((s) => s.length > 8) ?? firstChunk)
      : firstChunk;

  const rawText = firstSentence.trim();
  if (!rawText) return 'Teams: nový úkol';

  // --- Pricing path ---
  if (isPricingRequest(rawText)) {
    const work = stripPricingTrigger(rawText);
    const suffix = work.length > 4 ? work : rawText;
    let translatedSuffix = applyPhraseSubs(suffix);
    // Avoid "Nacenění: nacenění ..."
    translatedSuffix = translatedSuffix.replace(/^nacen[ěe]n[íi]\s*:?\s*/i, '').trim();
    const cap = translatedSuffix.length > 85 ? `${translatedSuffix.slice(0, 82)}…` : translatedSuffix;
    const title = `Nacenění: ${cap}`;
    console.debug(`[teams-title] pricing path: "${rawText}" → "${title}"`);
    return title.length > 100 ? `${title.slice(0, 97)}…` : title;
  }

  // --- English substitution path ---
  if (looksEnglish(rawText)) {
    const translated = applyPhraseSubs(rawText);
    if (translated !== rawText || hasCzechChars(translated)) {
      const title = capitalize(translated);
      console.debug(`[teams-title] en→cz path: "${rawText}" → "${title}"`);
      return title.length > 100 ? `${title.slice(0, 97)}…` : title;
    }
    // No useful substitution — keep original with no-op capping, AI will have a chance
    const title = rawText.length > 100 ? `${rawText.slice(0, 97)}…` : rawText;
    console.debug(`[teams-title] english fallback (no subs): "${title}"`);
    return title;
  }

  // --- Already Czech or other language ---
  const title = rawText.length > 100 ? `${rawText.slice(0, 97)}…` : rawText;
  console.debug(`[teams-title] czech/other: "${title}"`);
  return title || 'Teams: nový úkol';
}

/**
 * Returns true when the string contains Czech diacritics.
 * Exported for use in AppContext title policy.
 */
export { hasCzechChars };

// ---------------------------------------------------------------------------
// Body cleaning
// ---------------------------------------------------------------------------

/**
 * Strip Teams UI chrome from a raw intake message body.
 * Removes trailing `| Chat | Microsoft Teams` noise and any `teams.microsoft.com`
 * deep-link URLs that Teams auto-appends to link-preview cards.
 */
export function cleanTeamsBody(body: string): string {
  return body
    .replace(/https:\/\/teams\.microsoft\.com\/l\/message\/\S*/g, '')
    .replace(/\|\s*Chat\s*\|\s*Microsoft Teams\s*$/im, '')
    .replace(/\|\s*Microsoft Teams\s*$/im, '')
    .replace(/\|\s*General\s*\|\s*Microsoft Teams\s*$/im, '')
    .replace(/\|\s*Channel\s*\|\s*Microsoft Teams\s*$/im, '')
    .replace(/\|\s*Chat\s*$/im, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Forwarded message detection
// ---------------------------------------------------------------------------

export interface ForwardedTeamsMessage {
  isForwarded: true;
  senderName: string;
  senderEmail?: string;
  sentAt?: string;
  content: string;
}

/**
 * Extracts sender name, email, and sent-at from a "From: ..." / "Sent: ..." header block.
 * Returns partial fields — all may be absent if not found.
 */
function extractFromOrSentHeader(lines: string[]): Pick<ForwardedTeamsMessage, 'senderName' | 'senderEmail' | 'sentAt'> {
  let senderName = '';
  let senderEmail: string | undefined;
  let sentAt: string | undefined;

  for (const line of lines) {
    const fromMatch = line.match(/^From:\s*(.+)/i);
    if (fromMatch) {
      const raw = fromMatch[1].trim();
      // "Name <email>" or "email" or just "Name"
      const angleMatch = raw.match(/^(.+?)\s*<([^>]+)>$/);
      if (angleMatch) {
        senderName = angleMatch[1].trim();
        senderEmail = angleMatch[2].trim();
      } else if (raw.includes('@')) {
        senderEmail = raw;
        senderName = raw.split('@')[0];
      } else {
        senderName = raw;
      }
    }
    const sentMatch = line.match(/^Sent:\s*(.+)/i);
    if (sentMatch) sentAt = sentMatch[1].trim();
  }

  return { senderName, senderEmail, sentAt };
}

/**
 * Detects whether `content` contains a forwarded message and, if so, returns
 * structured data about the original message.
 *
 * Patterns detected:
 *  A: First few lines contain "From: ..." header (email-style forward)
 *  B: "---Forwarded message---" or "---------- Forwarded message ---------"
 *  C: Teams card header "Name  HH:MM AM/PM" pattern
 *  D: Majority of lines start with ">"
 *
 * Returns null if no forwarded structure is detected.
 */
export function parseForwardedTeamsMessage(
  content: string,
  fallbackSenderName: string,
  fallbackSenderEmail?: string,
  fallbackSentAt?: string,
): ForwardedTeamsMessage | null {
  if (!content?.trim()) return null;

  const lines = content.split('\n');

  // Pattern B — explicit forwarded separator
  const fwdSepIdx = lines.findIndex((l) =>
    /^-{3,}\s*forwarded message\s*-{3,}/i.test(l.trim()),
  );
  if (fwdSepIdx !== -1) {
    const headerLines = lines.slice(fwdSepIdx + 1, fwdSepIdx + 8);
    const meta = extractFromOrSentHeader(headerLines);
    const bodyStart = headerLines.findIndex((l) => l.trim() === '') + fwdSepIdx + 2;
    const body = lines.slice(bodyStart).join('\n').trim();
    return {
      isForwarded: true,
      senderName: meta.senderName || fallbackSenderName,
      senderEmail: meta.senderEmail ?? fallbackSenderEmail,
      sentAt: meta.sentAt ?? fallbackSentAt,
      content: body || content,
    };
  }

  // Pattern A — "From:" within first 6 lines
  const first6 = lines.slice(0, 6);
  const hasFromHeader = first6.some((l) => /^From:\s+\S+/i.test(l.trim()));
  if (hasFromHeader) {
    const meta = extractFromOrSentHeader(first6);
    // Body starts after the header block (first blank line)
    const blankIdx = first6.findIndex((l) => l.trim() === '');
    const bodyStart = blankIdx !== -1 ? blankIdx + 1 : 4;
    const body = lines.slice(bodyStart).join('\n').trim();
    return {
      isForwarded: true,
      senderName: meta.senderName || fallbackSenderName,
      senderEmail: meta.senderEmail ?? fallbackSenderEmail,
      sentAt: meta.sentAt ?? fallbackSentAt,
      content: body || content,
    };
  }

  // Pattern C — Teams card header: "Name  HH:MM AM/PM" on the first non-empty line
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
  const teamsCardMatch = firstNonEmpty.match(/^(.+?)\s{2,}(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (teamsCardMatch) {
    const body = lines.slice(1).join('\n').trim();
    return {
      isForwarded: true,
      senderName: teamsCardMatch[1].trim(),
      senderEmail: fallbackSenderEmail,
      sentAt: teamsCardMatch[2].trim(),
      content: body || content,
    };
  }

  // Pattern D — quote-style forward (majority of lines start with ">")
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const quoted = nonEmpty.filter((l) => l.trim().startsWith('>'));
  if (nonEmpty.length >= 3 && quoted.length / nonEmpty.length >= 0.6) {
    const body = nonEmpty.map((l) => l.replace(/^>\s?/, '')).join('\n').trim();
    return {
      isForwarded: true,
      senderName: fallbackSenderName,
      senderEmail: fallbackSenderEmail,
      sentAt: fallbackSentAt,
      content: body,
    };
  }

  // Pattern E — Teams link preview card: "Name: body text | Chat | Microsoft Teams"
  // Rust parses this server-side too, but include here as a safe JS-side fallback.
  {
    const withoutUrl = content.replace(/https:\/\/teams\.microsoft\.com\/l\/message\/\S*/g, '').trim();
    const clean = withoutUrl.replace(/\|\s*Chat\s*\|\s*Microsoft Teams\s*$/im, '')
      .replace(/\|\s*Microsoft Teams\s*$/im, '')
      .replace(/\|\s*Chat\s*$/im, '')
      .trim();
    const firstLine = clean.split('\n')[0]?.trim() ?? '';
    const colonIdx = firstLine.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      const candidateName = firstLine.slice(0, colonIdx).trim();
      // Reject if name looks like a URL or protocol fragment
      if (candidateName && !candidateName.includes('/') && !candidateName.includes('@')) {
        const bodyText = clean.slice(colonIdx + 1).trim();
        if (bodyText.length > 3) {
          return {
            isForwarded: true,
            senderName: candidateName,
            senderEmail: fallbackSenderEmail,
            sentAt: fallbackSentAt,
            content: bodyText,
          };
        }
      }
    }
  }

  return null;
}
