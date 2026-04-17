/**
 * Pure-heuristic message classification.
 *
 * Used as:
 *   1. Primary classifier when no OpenAI API key is configured.
 *   2. Source of heuristicPriority fed into the import pipeline so the AI
 *      fallback path produces a meaningful confidence instead of defaulting to 0.
 *
 * Design:
 *   - Email base=45; Teams base=20.
 *     A Teams message with zero positive signals scores 20 — safely below the
 *     MIN_CONFIDENCE_ANALYZE threshold (50), so it is silently skipped.
 *     An email with zero signals scores 45 — also below threshold.
 *   - Positive signals must be strong and concrete (request verb + artifact or issue).
 *   - Each source has its own anti-noise layer.
 */

import type { PlanningBucket, TaskType } from '../types';

export interface HeuristicResult {
  /** Confidence 0-100. Same scale as IMPORT_CONFIG thresholds. */
  confidence: number;
  /** Short human-readable reason (shown as priorityReason in UI). */
  reason: string;
  taskType: TaskType;
  bucket: PlanningBucket;
}

interface Signal {
  pattern:   RegExp;
  score:     number;
  label:     string;
  taskType?: TaskType;
  bucket?:   PlanningBucket;
}

// ---------------------------------------------------------------------------
// Shared positive signals (apply to both email and Teams).
// Only patterns that genuinely indicate actionable work.
// ---------------------------------------------------------------------------

const POSITIVE_SIGNALS: Signal[] = [
  // Czech imperative request verbs — direct personal requests get bucket 'now'.
  // These indicate the sender is directly asking the developer to act immediately.
  { pattern: /\bkoukni\b|\bmrkni\b/i,                                            score: 35, label: 'koukni/mrkni (Czech request)', bucket: 'now' },
  { pattern: /\boprav(te)?\b|\bopravit\b/i,                                      score: 40, label: 'oprav (fix, Czech)',           taskType: 'bug-fix', bucket: 'now' },
  { pattern: /\bprover(te)?\b|\bproverit\b|\bzkontroluj(te)?\b/i,               score: 35, label: 'prover/zkontroluj (Czech)',    taskType: 'bug-fix', bucket: 'now' },
  { pattern: /\bvyres(te)?\b|\bvyresit\b|\budelej(te)?\b|\budelejte\b/i,        score: 30, label: 'vyres/udelej (Czech)',          bucket: 'now' },
  { pattern: /\bnasad(te)?\b|\bnasadit\b/i,                                      score: 35, label: 'nasad (deploy, Czech)',         taskType: 'deployment', bucket: 'today' },
  { pattern: /\bpodivej(\s+se)?\b|\bpodivejte(\s+se)?\b/i,                       score: 30, label: 'podivej se (Czech request)',   bucket: 'now' },
  { pattern: /\bzkus(te)?\b.*\b(opravit|nasadit|spustit)\b/i,                    score: 25, label: 'zkus + action (Czech)' },

  // Czech problem wording
  { pattern: /\bnechodi\b|\bnefunguje\b|\bspadlo\b|\bspadl\b/i,                  score: 40, label: 'nefunguje/nechodi (Czech)',  taskType: 'bug-fix' },
  { pattern: /\bchyba\b|\bchybka\b/i,                                             score: 25, label: 'chyba (Czech bug/error)',   taskType: 'bug-fix' },

  // English imperative — direct requests with action verbs get bucket 'now'.
  // "Please fix/check/investigate" means the sender expects immediate action.
  { pattern: /\bplease\s+(fix|check|review|look\s+into|investigate|resolve|update|verify)\b/i, score: 30, label: 'polite request (EN)', bucket: 'now' },
  { pattern: /\b(fix|resolve|investigate|look\s+into|check\s+this)\b/i,          score: 20, label: 'action verb (EN)' },
  { pattern: /\bcan\s+you\s+(fix|check|look|help|resolve|review)\b/i,            score: 25, label: 'request (EN)', bucket: 'now' },
  { pattern: /\bwe\s+need\s+(to|you|someone)\b|\bi\s+need\s+(you|help|this)\b/i, score: 20, label: 'need statement' },

  // Bug / broken wording
  { pattern: /\bbug\b|\bdefect\b|\bregression\b/i,                               score: 30, label: 'bug',         taskType: 'bug-fix' },
  { pattern: /\bbroken\b|\bbreaking\b|\bbroke\b/i,                               score: 30, label: 'broken',      taskType: 'bug-fix' },
  { pattern: /\bnot\s+working\b|\bdoesn.?t\s+work\b|\bfail(s|ing)?\b/i,         score: 25, label: 'not working',  taskType: 'bug-fix' },
  { pattern: /\berror\b|\bexception\b|\bcrash(ed|ing)?\b/i,                      score: 20, label: 'error/exception' },
  { pattern: /\bhardcoded?\b/i,                                                   score: 25, label: 'hardcoded',   taskType: 'bug-fix' },

  // File/artifact reference — strong developer-context signal
  { pattern: /\b[\w.-]+\.(js|ts|cs|aspx|json|xml|sql|css|scss|py|ps1|csproj)\b/i, score: 30, label: 'file reference' },

  // PR / ADO / ticket number
  { pattern: /\bpr\s*#?\d+\b|\bpull\s+request\b/i,                              score: 40, label: 'PR reference',  taskType: 'review' },
  { pattern: /\bcode\s+review\b|\breview\s+comment\b/i,                          score: 35, label: 'code review',   taskType: 'review' },
  { pattern: /\b(task|ticket|issue|bug)\s*#?\d{3,}\b/i,                          score: 40, label: 'ticket/task ID' },

  // Deployment
  { pattern: /\bdeploy(ment)?\b|\bhotfix\b/i,                                    score: 25, label: 'deployment',   taskType: 'deployment', bucket: 'today' },

  // Production/UAT issue (compound: env + problem word)
  { pattern: /\bprod(uction)?\b.{0,60}\b(nefunguje|chyba|bug|broken|error|down|fail)\b|\b(nefunguje|chyba|bug|broken|error|down|fail)\b.{0,60}\bprod(uction)?\b/is, score: 45, label: 'production issue', bucket: 'now' },
  { pattern: /\buat\b.{0,60}\b(nefunguje|chyba|bug|broken|error|fail)\b|\b(nefunguje|chyba|bug|broken|error|fail)\b.{0,60}\buat\b/is, score: 35, label: 'UAT issue' },

  // Urgency
  { pattern: /\burgent(ly)?\b|\basap\b|\bcritical\b/i,                           score: 20, label: 'urgent', bucket: 'now' },
  { pattern: /\bdeadline\b|\bby\s+(friday|monday|tomorrow|eod)\b/i,              score: 15, label: 'deadline',     bucket: 'today' },

  // CRM combined with problem (alone too weak; compound required)
  { pattern: /\b(dataverse|dynamics|d365|plugin|solution)\b.{0,60}\b(nefunguje|chyba|bug|broken|error)\b|\b(nefunguje|chyba|bug|broken|error)\b.{0,60}\b(dataverse|dynamics|d365|plugin|solution)\b/is, score: 35, label: 'CRM issue' },
];

// ---------------------------------------------------------------------------
// Teams-specific anti-noise.
// Czech developer chat is full of short conversational messages that look
// like filler but fire on generic keywords. These patterns suppress them.
// Applied only when source='teams'.
// ---------------------------------------------------------------------------

const TEAMS_ANTI_NOISE: Array<{ pattern: RegExp; score: number; label: string }> = [
  // Single-line acknowledgements — must be full or nearly full message
  { pattern: /^(ok|okay|diky|díky|thx|thanks?|jo|jj|jasne|jasně|super|dobre|dobře|np|ack|noted|sure|ano|jojo|yep|yup)\s*[!.]*\s*$/i, score: -70, label: 'trivial ack' },

  // "Prislo to / přišlo to" — confirming receipt, informational
  { pattern: /\b(prislo|prishlo|doslo|dorazilo)\s+(to|mi|nam|email|zprava|mail)\b/i, score: -50, label: 'arrival confirmation' },

  // "Vyzkusam / zkusim" — I'll try it (no request directed at others)
  { pattern: /\b(vyzkusam|vyzkousam|vyzkousim|zkusim)\b/i,                        score: -50, label: 'informational: I will try' },

  // "Premyslim" — thinking, no action
  { pattern: /\b(premyslim|premyslel)\b/i,                                         score: -40, label: 'informational: thinking' },

  // "Nebudu to resit/delat" — declining action
  { pattern: /\bnebudu\b.{0,30}\b(resit|delat|resis|delas)\b/i,                   score: -40, label: 'declining action' },

  // "Jsou pristupy" / access-related status (no request)
  { pattern: /\bjsou\s+(pristupy|hotove|udelane|v poradku|ok|splnene)\b/i,         score: -40, label: 'status: done/access' },
  { pattern: /\b(pristupy|prestupy)\b/i,                                            score: -20, label: 'access-info word' },

  // "Poslal/zaslal jsem" — I sent (informational, not a request)
  { pattern: /\b(poslal|zaslal|posilam|zasilam)\s+jsem\b/i,                        score: -30, label: 'informational: I sent' },

  // "Prisel vam email/zprava" — did it arrive (informational question)
  { pattern: /\b(prisel|prisla|prishel)\s+(vam|ti|mi)\b/i,                         score: -30, label: 'informational: did it arrive' },

  // Very short combined text (title+content) — no context for action
  { pattern: /^.{1,60}$/s,                                                          score: -15, label: 'very short' },
];

// ---------------------------------------------------------------------------
// Shared noise (both sources)
// ---------------------------------------------------------------------------

const SHARED_NOISE: Array<{ pattern: RegExp; score: number; label: string }> = [
  { pattern: /\bfyi\b|\bfor\s+your\s+info(rmation)?\b/i,                          score: -20, label: 'FYI' },
  { pattern: /\bjust\s+(letting|to\s+let)\s+you\s+know\b/i,                       score: -20, label: 'informational only' },
  { pattern: /^(hi|hello|hey|ahoj|cau|nazdar)\s*[,!.]?\s*$/i,                     score: -60, label: 'greeting only' },
];

// ---------------------------------------------------------------------------
// Source base scores
// ---------------------------------------------------------------------------

const SOURCE_BASE: Record<'email' | 'teams', number> = {
  // Email: human-written, generally has context. Needs signals to reach 50 (review) or 80 (auto-task).
  email: 45,
  // Teams: very noisy. Zero positive signals -> 20 -> silently skipped (< MIN_CONFIDENCE_ANALYZE=50).
  // One strong signal (+35) -> 55 -> review item.
  teams: 20,
};

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function heuristicClassify(
  title:   string,
  content: string,
  source:  'email' | 'teams',
): HeuristicResult {
  const combined = `${title} ${content}`.slice(0, 3000).toLowerCase();

  const base   = SOURCE_BASE[source];
  let delta    = 0;
  let taskType: TaskType       = 'other';
  let bucket:   PlanningBucket = 'this_week';
  const matched: string[]      = [];

  // Positive signals
  for (const sig of POSITIVE_SIGNALS) {
    if (sig.pattern.test(combined)) {
      delta += sig.score;
      matched.push(`+${sig.label}`);
      if (sig.taskType && taskType === 'other')     taskType = sig.taskType;
      if (sig.bucket   && bucket   === 'this_week') bucket   = sig.bucket;
    }
  }

  // Source-specific anti-noise
  if (source === 'teams') {
    for (const sig of TEAMS_ANTI_NOISE) {
      if (sig.pattern.test(combined)) {
        delta += sig.score;
        matched.push(`-${sig.label}`);
      }
    }
  }

  // Shared noise
  for (const sig of SHARED_NOISE) {
    if (sig.pattern.test(combined)) {
      delta += sig.score;
      matched.push(`-${sig.label}`);
    }
  }

  const confidence = Math.max(0, Math.min(100, base + delta));

  const positives = matched.filter((m) => m.startsWith('+'));
  const reason =
    positives.length === 0
      ? 'No strong work signals'
      : positives.length === 1
        ? positives[0].slice(1)
        : `${positives[0].slice(1)} +${positives.length - 1} more`;

  const allSignalsSummary = matched.length ? matched.slice(0, 6).join(', ') : 'none';
  console.debug(
    `[heuristic] ${source} "${title.slice(0, 60)}"` +
    ` base=${base} delta=${delta >= 0 ? '+' : ''}${delta} conf=${confidence}` +
    ` [${allSignalsSummary}]`,
  );

  return { confidence, reason, taskType, bucket };
}
