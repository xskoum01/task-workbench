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

/**
 * Generates an action-oriented task title from a Teams message.
 *
 * Format: "{SenderName}: {first meaningful sentence}"
 *
 * Rules:
 *  - Strip the "From: / Chat:" prefix lines added by the import wrapper
 *  - Take the first non-trivial sentence or line
 *  - Keep it under ~100 chars
 *  - Include sender name when available
 */
export function generateTeamsTitle(senderName: string, content: string): string {
  // Remove the "From: ... / Chat: ..." header lines added by handleTeamsImport
  const stripped = content
    .split('\n')
    .filter((line) => {
      const l = line.trim();
      return l.length > 0 && !/^From:/i.test(l) && !/^Chat:/i.test(l);
    })
    .join('\n')
    .trim();

  // Find the first meaningful sentence or line
  const firstChunk = stripped
    .split(/[\n]+/)
    .map((s) => s.trim())
    .find((s) => s.length > 8)
    ?? content.slice(0, 80);

  // Further split by sentence-ending punctuation if the line is long
  const firstSentence =
    firstChunk.length > 60
      ? (firstChunk.split(/[.!?]/).map((s) => s.trim()).find((s) => s.length > 8) ?? firstChunk)
      : firstChunk;

  const capped =
    firstSentence.length > 95
      ? `${firstSentence.slice(0, 92)}…`
      : firstSentence;

  const prefix = senderName?.trim() ? `${senderName.trim()}: ` : '';
  return `${prefix}${capped}`;
}
