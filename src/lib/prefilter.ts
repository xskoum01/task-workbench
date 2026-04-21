export interface PrefilterResult {
  pass: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// HARD SKIP patterns — rejected unconditionally, no relevance-keyword override.
//
// Use this for patterns that are unambiguously non-actionable regardless of
// what other words appear in the email. Helpdesk acceptance/testing/closure
// notifications are the primary case: they contain words like "ticket",
// "task", and "customer" which would otherwise fire the relevance override
// and slip through to the AI.
// ---------------------------------------------------------------------------

/**
 * Subject patterns that unconditionally indicate a non-actionable helpdesk
 * notification. Matched against the lowercased subject only.
 */
const HARD_SKIP_SUBJECT: RegExp[] = [
  // "Ticket #N (Requested acceptance for a custom service)"
  // Customer acceptance/testing notification — implementation is done, nothing to do.
  /requested\s+acceptance\s+for/i,
  // Generic acceptance notice subjects
  /\(acceptance\s+(request|notice|confirmation)\)/i,

  // Helpdesk "New task:" notification emails.
  // Pattern: "New task: Analysis of request (pending); Ticket: #<N>; ..."
  // These are notifications that a helpdesk ticket was created, not a developer actions.
  // The developer is not assigned work — the system is just logging the creation.
  // Hard-skipped unconditionally because the email contains words like "task", "ticket",
  // "pending", and a customer name, which would all fire the relevance override.
  /^new\s+task:\s/i,
];

/**
 * Body-content phrases associated with acceptance/testing/closure notifications.
 * At least one must match for the body-aware hard skips below to fire.
 * Matched against the lowercased full body.
 */
const ACCEPTANCE_BODY_PHRASES: RegExp[] = [
  // Czech: "nyní u Vás na otestování" = "now with you for testing"
  /na\s+otestov/i,
  // Czech: "prosím o informaci, zda je vše v pořádku" = "please advise if OK"
  /zda\s+je\s+v[sš]e\s+v\s+po[řr][áa]dku/i,
  // Czech: "můžeme uzavřít" = "we can close"
  /m[uů][žz]eme\s+uzav[řr][íi]t/i,
  // Czech: "zákazník potvrdí / zákazník otestuje"
  /z[áa]kazn[íi]k\s+(potvrd[íi]|otestuje|akceptuje|ov[eě][řr][íi])/i,
  // Czech: "implementace je hotova / dokončena / připravena"
  /implementace\s+je\s+(hotov|dokon[cč]en|p[řr]ipraven)/i,
  // English acceptance phrases
  /please\s+confirm\s+(acceptance|that\s+everything\s+is\s+ok)/i,
  /can\s+we\s+(close|finalize)\s+the\s+(ticket|request|task|case)/i,
  /customer\s+(should|needs?\s+to)\s+(test|verify|confirm|accept)/i,
  /waiting\s+for\s+(customer\s+)?(acceptance|confirmation|approval|testing)/i,
  /implementation\s+(is\s+)?(complete|done|finished|ready\s+for\s+testing)/i,
  /delivered\s+(to\s+)?(customer|client|testing)/i,
  // "requested acceptance" in body reinforces subject
  /requested\s+acceptance/i,
];

// ---------------------------------------------------------------------------
// Noise patterns — matched against `${subject} ${body}` combined.
// A match → reject, UNLESS a relevance keyword also matches (see below).
// ---------------------------------------------------------------------------
const NOISE_PATTERNS: RegExp[] = [
  // CI/CD automated results
  /build\s+(succeeded|passed|failed|completed)/i,
  /pipeline\s+(succeeded|passed|failed|completed|triggered)/i,
  /deployment\s+(succeeded|completed|finished|triggered)/i,
  /release\s+(succeeded|completed|triggered|published)/i,
  /\d+\s+test[s]?\s+(passed|failed|skipped)/i,

  // Helpdesk change task — completed/finished state
  // "Change task: Some description (finished); Ticket: #..." — no action needed
  // "Change task: Some description (completed); ..." — same
  /change\s+task:[^;\n]*\(finished\)/i,
  /change\s+task:[^;\n]*\(completed\)/i,
  /change\s+task:[^;\n]*\(done\)/i,

  // Generic automation signals
  /automated\s+(notification|message|alert|email)/i,
  /this\s+is\s+an\s+automated\s+message/i,
  /do\s+not\s+(reply|respond)\s+to\s+this/i, // narrowed: "do not reply TO THIS" not just "do not reply"
  /notification\s+service/i,
  /system\s+(notification|alert)/i,            // removed "message" — too broad

  // Out-of-office and mail-server auto-replies
  /out\s+of\s+office/i,
  /automatic\s+reply:/i,                        // common OOO subject prefix
  /delivery\s+status\s+notification/i,
  /mail\s+delivery\s+(failed|failure|error)/i,
  /undeliverable:/i,

  // Subscriptions / newsletters
  /unsubscribe\s+from/i,
  /newsletter/i,
  /you\s+have\s+been\s+(added|removed)\s+to/i, // removed "invited" — could be real work
  /subscription\s+(confirmed|cancelled|activated|deactivated)/i,

  // Recurring digests with no individual action
  /daily\s+(digest|summary|standup)/i,
  /weekly\s+(digest|summary|standup)/i,

  // Calendar noise — invitations and responses are handled by the calendar, not the inbox
  /meeting\s+recording\s+available/i,
  /^invitation:\s/i,                          // Outlook calendar invite subject prefix
  /^accepted:\s/i,                            // calendar acceptance response
  /^declined:\s/i,                            // calendar decline response
  /^tentative:\s/i,                           // tentative acceptance
  /^cancelled:\s/i,                           // meeting cancellation
  /\btraining\s+invitation\b/i,
  /\bwebinar\s+invitation\b/i,
  /join\s+(?:microsoft\s+)?teams\s+meeting/i, // body link in calendar invite emails

  // Account lifecycle (Microsoft/Azure auto-mails, not client work)
  /your\s+account\s+(has\s+been|was)\s+(created|locked|disabled|deleted)/i,
  /password\s+(reset|changed|expir)/i,
];

// ---------------------------------------------------------------------------
// EXPLICIT-CAPTURE hard rejects:
// Items that should be rejected even when the user explicitly selected/imported them.
// Keep this list very narrow — only deterministic, zero-actionability signals.
// Calendar response emails (accepted/declined/tentative/cancelled) are the canonical case:
// the calendar handles them; importing them as tasks adds no value regardless of intent.
// ---------------------------------------------------------------------------
const EXPLICIT_CAPTURE_HARD_REJECTS: RegExp[] = [
  /^accepted:\s/i,         // calendar acceptance response
  /^declined:\s/i,         // calendar decline
  /^tentative:\s/i,        // tentative acceptance
  /^cancelled:\s/i,        // meeting cancellation
  /^automatic\s+reply:/i,  // out-of-office auto-replies
  /^out\s+of\s+office\b/i, // OOO subject line variant
];

// ---------------------------------------------------------------------------
// Sender-address patterns that reliably indicate automated senders.
// Keep this list tight: only match addresses that are never used by humans.
// ---------------------------------------------------------------------------
const AUTOMATED_SENDER_PATTERNS: RegExp[] = [
  /no[‑\-]?reply@/i,
  /noreply@/i,
  /do[‑\-]?not[‑\-]?reply@/i,
  /notifications?@/i,
  /alerts?@/i,
  /mailer[‑\-]?daemon@/i,
  /postmaster@/i,
  // "builds@" as a standalone prefix (ci-cd automation), not "devops@" (used by real teams)
  /^builds?@/i,
  /^ci[‑\-]?cd@/i,
  // NOTE: azure-devops@ is intentionally NOT blocked here.
  // ADO sends PR comments and work-item assignments from that domain — these are actionable.
  // CI/CD pipeline results from ADO are rejected by NOISE_PATTERNS instead.
];

// ---------------------------------------------------------------------------
// Relevance keywords — if any match the combined text, a noisy subject does
// not automatically disqualify the message; AI gets to decide instead.
// Use specific terms relevant to Dynamics 365 / CRM developer work.
// ---------------------------------------------------------------------------
const RELEVANCE_KEYWORDS: string[] = [
  // Issue / bug language
  'bug', 'error', 'issue', 'problem', 'fix', 'broken', 'crash',

  // Work request language
  'feature', 'request', 'implement', 'change', 'update',
  'ticket', 'task', 'please', 'can you', 'could you', 'we need', 'i need', 'help with',

  // Deployment / environment terms
  'deploy', 'deployment', 'production', 'prod', 'uat', 'staging', 'environment',
  'release candidate', 'hotfix',

  // D365 / CRM domain terms
  'portal', 'dataverse', 'crm', 'dynamics', 'plugin', 'solution',
  'integration', 'api', 'script', 'workflow', 'configuration',

  // Timing / urgency
  'deadline', 'urgent', 'asap', 'by friday', 'by monday', 'by tomorrow',

  // Azure DevOps / code collaboration
  'pull request', 'pr comment', 'code review', 'work item', 'assigned to you',
  'mentioned you', 'reviewer', 'commented on',

  // Review / approval terms (a build result email saying "review" is still likely noise,
  // but a message that opens with these terms alongside other work language is worth passing)
  'review', 'approve', 'sign off',

  // Client / commercial terms
  'customer', 'client', 'contract',
];

export function prefilter(item: {
  title: string;
  content: string;
  senderEmail?: string;
  /** When 'explicit', apply conservative filtering: only hard-known noise is rejected. */
  captureMode?: 'explicit';
}): PrefilterResult {
  const subject     = item.title.toLowerCase();
  const content     = item.content.toLowerCase();
  const combined    = `${subject} ${content}`;
  const senderEmail = (item.senderEmail ?? '').toLowerCase();

  // ---------------------------------------------------------------------------
  // EXPLICIT-CAPTURE conservative path:
  // The user explicitly selected/imported this item — trust their intent.
  // Sender-based and short-content checks are skipped entirely.
  // Only truly-empty content and deterministic non-actionable subjects are rejected.
  // ---------------------------------------------------------------------------
  if (item.captureMode === 'explicit') {
    // Reject only truly empty content (whitespace-only). Short messages are fine.
    if (content.trim().length === 0) {
      return { pass: false, reason: 'Content is empty' };
    }
    // Reject deterministic non-actionable subjects (calendar responses, OOO).
    for (const pattern of EXPLICIT_CAPTURE_HARD_REJECTS) {
      if (pattern.test(subject)) {
        return { pass: false, reason: `Explicit-capture hard reject (calendar/OOO noise): ${subject.slice(0, 60)}` };
      }
    }
    // All other explicit-capture items pass — AI enriches from here.
    return { pass: true, reason: 'Explicit capture — passed conservative prefilter' };
  }

  // Hard reject: known automated sender address (non-explicit only)
  for (const pattern of AUTOMATED_SENDER_PATTERNS) {
    if (pattern.test(senderEmail)) {
      return { pass: false, reason: `Automated sender: ${senderEmail}` };
    }
  }

  // Hard reject: trivially short body (non-explicit only)
  if (content.trim().length < 15) {
    return { pass: false, reason: 'Content too short to be actionable' };
  }

  // ---------------------------------------------------------------------------
  // HARD SKIP — acceptance / testing / closure notifications.
  //
  // These are checked BEFORE the relevance-keyword override because helpdesk
  // emails naturally contain words like "ticket", "task", "customer", "portal"
  // which would otherwise defeat the noise filter and route to OpenAI.
  //
  // Rule 1: Subject says "requested acceptance" → always skip.
  // Rule 2: Subject has "Change task: ... (pending)" AND body has acceptance
  //         language → skip. "pending" can mean "waiting on customer", not
  //         "new developer work".
  // ---------------------------------------------------------------------------

  for (const pattern of HARD_SKIP_SUBJECT) {
    if (pattern.test(subject)) {
      return { pass: false, reason: 'Helpdesk acceptance/testing notification (hard skip)' };
    }
  }

  const isChangeTaskPending = /change\s+task:[^;\n]*\(pending\)/i.test(subject);
  if (isChangeTaskPending) {
    const hasAcceptanceBody = ACCEPTANCE_BODY_PHRASES.some((p) => p.test(content));
    if (hasAcceptanceBody) {
      return {
        pass:   false,
        reason: 'Helpdesk: change task (pending) with acceptance/testing semantics',
      };
    }
  }

  // Also skip when the body alone strongly implies acceptance without developer action
  // (catches cases where the subject doesn't match the specific patterns above)
  const acceptanceBodyMatches = ACCEPTANCE_BODY_PHRASES.filter((p) => p.test(content));
  if (acceptanceBodyMatches.length >= 2) {
    // Two or more acceptance signals in the body = almost certainly a closure/testing notice
    return {
      pass:   false,
      reason: 'Helpdesk: multiple acceptance/closure signals in body (hard skip)',
    };
  }

  // If any relevance keyword is present, pass to AI even if the subject looks noisy.
  // This handles cases like a build-failure email that includes "the deploy broke prod".
  const isRelevant = RELEVANCE_KEYWORDS.some((kw) => combined.includes(kw));

  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(combined)) {
      if (isRelevant) {
        return { pass: true, reason: 'Relevance keyword overrides noise pattern — passing to AI' };
      }
      return { pass: false, reason: 'Noise pattern matched' };
    }
  }

  return { pass: true, reason: 'Passed prefilter' };
}
