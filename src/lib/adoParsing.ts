/**
 * Deterministic Azure DevOps notification email parser.
 *
 * Recognises two primary ADO email types with explicit rules:
 *   1. PR comment   — "Someone has commented on file.js"
 *   2. Work item    — "Someone created Task 9276"
 *
 * No AI is required. All rules are based on sender, subject, and body patterns.
 * Import this module wherever ADO email detection is needed.
 */

import type { AdoEmailContext } from '../types';
import { normalizeText, normalizeTitle as normalizeTextTitle } from './textNormalize';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdoParseResult {
  isAdoEmail: boolean;
  title: string | null;
  /** Clean text for the task's originalMessage / description field. */
  description: string | null;
  /** Short label for the inbox classification badge. */
  classificationLabel: string | undefined;
  /** Null when not an ADO email or type is 'other'. */
  adoContext: AdoEmailContext | null;
  /**
   * When true the email is a recognised ADO notification but requires no action
   * (e.g. PR approved, PR completed/merged). The caller must skip import entirely
   * — do not pass to OpenAI or create any task/review entry.
   */
  shouldSkip?: boolean;
  /** Human-readable reason accompanying shouldSkip=true. */
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Sender detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the email is from Azure DevOps.
 * Covers the canonical no-reply address and common alias patterns.
 */
export function isAdoSender(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase();
  return (
    lower === 'azuredevops@microsoft.com' ||
    lower.endsWith('@ado.microsoft.com') ||
    lower.includes('vstfs') ||
    // Azure DevOps sends from alias addresses in some orgs
    (lower.includes('azuredevops') && lower.endsWith('@microsoft.com'))
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the CRM project code from text.
 * Matches patterns like CRM_Navertica, CRM_Ptacek, CRM-Neopharma.
 * Returns the name part only, e.g. "Navertica".
 */
export function extractCrmCode(text: string): string | undefined {
  const match = /\bCRM[_\-]([A-Za-z][A-Za-z0-9]*)\b/i.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Extracts a labeled field value from the email body plain text.
 * e.g. extractField(body, 'Priority') → "2 - High"
 */
function extractField(body: string, label: string): string | undefined {
  // Match "Label: value" — colon is optional (some ADO mails use tab-separated layout)
  const pattern = new RegExp(`\\b${label}:?[ \\t]+([^\\n]{1,150})`, 'im');
  const m = pattern.exec(body);
  return m ? m[1].trim() : undefined;
}

/**
 * Tries to resolve customer ID from a CRM project code against known customers.
 * Checks customer.name, customer.folderName, customer.shortCode.
 * Returns the first confident match or undefined.
 */
export function resolveCustomerFromCrmCode(
  crmCode: string,
  customers: Array<{ id: string; name: string; shortCode: string; folderName?: string }>,
): string | undefined {
  const needle = crmCode.toLowerCase();
  for (const c of customers) {
    if (
      c.name.toLowerCase().includes(needle) ||
      needle.includes(c.name.toLowerCase()) ||
      (c.folderName && c.folderName.toLowerCase().includes(needle)) ||
      c.shortCode.toLowerCase() === needle
    ) {
      return c.id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PR non-actionable event detection (approved / completed / merged)
// ---------------------------------------------------------------------------

/**
 * Returns a skip result when the email body clearly indicates a non-actionable
 * PR status event — approved, completed, or merged.
 *
 * ADO uses the same "PR - <title> - <Project> <Number>" subject format for ALL
 * PR events. The only reliable distinction is the body wording.
 *
 * Matched body phrases (case-insensitive):
 *   Approved:  "approved the changes", "approved the pull request",
 *              "voted Approved", "approved your changes"
 *   Completed: "completed the pull request", "pull request completed",
 *              "has been completed", "was completed"
 *   Merged:    " merged ", "pull request merged", "merge into"
 */
function detectPrNonActionable(
  subject: string,
  bodyText: string,
): { shouldSkip: true; skipReason: string } | null {
  const combo = `${subject}\n${bodyText}`;

  // Approved patterns
  if (
    /approved\s+the\s+(changes|pull\s+request|PR)/i.test(combo) ||
    /voted\s+Approved/i.test(combo) ||
    /approved\s+your\s+changes/i.test(combo)
  ) {
    return { shouldSkip: true, skipReason: 'PR approved notification' };
  }

  // Completed / merged patterns
  if (
    /completed\s+the\s+pull\s+request/i.test(combo) ||
    /pull\s+request\s+(was\s+|has\s+been\s+)?completed/i.test(combo) ||
    /the\s+pull\s+request\s+has\s+been\s+(completed|merged)/i.test(combo) ||
    /pull\s+request\s+merged/i.test(combo) ||
    /\bmerged\s+into\b/i.test(combo)
  ) {
    return { shouldSkip: true, skipReason: 'PR completed/merged notification' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// PR review-request parsing ("PR - <title> - <Project> <Number> (<Reviewer>)")
// ---------------------------------------------------------------------------

/**
 * Detects and parses PR review-request notification emails.
 *
 * ADO sends these when a PR is created or a reviewer is added.
 * Subject format:
 *   "PR - VSM 9457 - Add solution change handler - CRM_Ptacek_Prod 268 (Jan Svestka)"
 *   "PR - Fix login bug - MyProject 42"
 *
 * The function is intentionally permissive: any subject starting with "PR - "
 * from an ADO sender is treated as a PR review item.
 */
function parsePrReviewRequest(
  subject: string,
  _bodyText: string,   // used for URL extraction further down
  crmProjectCode: string | undefined,
): AdoParseResult | null {
  if (!/^PR\s*-\s*/i.test(subject)) return null;

  const afterPr = subject.replace(/^PR\s*-\s*/i, '').trim();

  // Split into dash-separated segments to extract structured parts.
  // Example: ["VSM 9457", "Add solution change handler", "CRM_Ptacek_Prod 268 (Jan Svestka)"]
  const segments = afterPr.split(/\s*-\s*/);

  // Last segment usually contains "<Project> <PRNumber> (<Reviewer>)"
  const lastSeg = segments[segments.length - 1] ?? '';
  const projectNumMatch = /^([A-Za-z][A-Za-z0-9_]+)\s+(\d+)/i.exec(lastSeg);
  const project   = projectNumMatch?.[1] ?? crmProjectCode;
  const prNumber  = projectNumMatch ? parseInt(projectNumMatch[2], 10) : undefined;

  // Reviewer name from trailing parenthetical, e.g. "(Jan Svestka)"
  const reviewerMatch = /\(([^)]+)\)/.exec(lastSeg);
  const reviewerName  = reviewerMatch?.[1];

  // PR title excerpt: all segments except the trailing project/number segment.
  // Truncated to 80 chars to stay concise in the task list.
  const titleExcerpt = segments
    .slice(0, segments.length > 1 ? -1 : undefined)
    .join(' - ')
    .replace(/[…\.]{2,}$/, '')
    .trim()
    .slice(0, 80);

  // Build a deterministic "PR comment:" title — always uses this prefix so
  // the task list makes the PR origin immediately clear.
  const title =
    project && prNumber
      ? `PR comment: ${project} PR ${prNumber}`
      : titleExcerpt
        ? `PR comment: review ${titleExcerpt}`
        : `PR comment: review Pull Request`;

  const prUrl = extractAdoPrUrl(_bodyText);
  if (prUrl) {
    console.log(`[ado-link] found PR review-request link: ${prUrl}`);
  } else {
    console.log('[ado-link] no usable devops link found in PR review-request email');
  }

  const description = normalizeText(
    `PR review request${reviewerName ? ` (${reviewerName})` : ''}:\n\n${afterPr}`,
  );

  return {
    isAdoEmail:          true,
    title,
    description,
    classificationLabel: 'PR review',
    adoContext: {
      type:             'pr-comment',
      prNumber,
      reviewerName,
      crmProjectCode:   project ?? crmProjectCode,
      prUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// PR file-comment parsing ("X has commented on <file>")
// ---------------------------------------------------------------------------

/**
 * Detects and parses PR comment notification emails.
 *
 * Subject patterns detected:
 *   - "Jan Svestka has commented on nvr_opportunity_events.js"
 *   - "Someone commented on Pull Request 196"
 *   - "Re: Pull Request 196: ..."
 */
function parsePrComment(
  subject: string,
  bodyText: string,
  crmProjectCode: string | undefined,
): AdoParseResult | null {

  // Pattern A: "Someone has commented on <target>"
  const commentedOnMatch =
    /^(.+?)\s+has commented on\s+(.+)$/i.exec(subject) ??
    /^(.+?)\s+commented on\s+(.+)$/i.exec(subject);

  if (!commentedOnMatch) return null;

  const reviewerName  = commentedOnMatch[1].trim();
  const commentTarget = commentedOnMatch[2].trim();

  // Extract PR number anywhere in subject or body
  const prNumMatch = /pull\s+request\s+#?(\d+)|PR\s+#?(\d+)/i.exec(`${subject}\n${bodyText}`);
  const prNumber   = prNumMatch
    ? parseInt(prNumMatch[1] ?? prNumMatch[2] ?? '0', 10)
    : undefined;

  // Extract the file name — appears as the commentTarget when it has an extension
  const fileMatch  = /([A-Za-z0-9_\-.]+\.[a-z]{1,6})\b/i.exec(commentTarget);
  const commentedFile = fileMatch ? fileMatch[1] : undefined;

  // Build a concise action-oriented title — always starts with "PR comment:"
  // so it is visually distinct from other task types in the task list.
  const title = commentedFile
    ? `PR comment: address feedback in ${commentedFile}`
    : prNumber
      ? `PR comment: resolve review feedback (PR ${prNumber})`
      : `PR comment: resolve review feedback from ${reviewerName}`;

  const prUrl = extractAdoPrUrl(bodyText);
  if (prUrl) {
    console.log(`[ado-link] found PR comment link: ${prUrl}`);
  } else {
    console.log('[ado-link] no usable devops link found in PR comment email');
  }

  // Extract the review comment text from the body
  const reviewComment = extractReviewComment(bodyText);

  const description = reviewComment
    ? normalizeText(`Review comment by ${reviewerName}:\n\n${reviewComment}`)
    : normalizeText(`Review comment from ${reviewerName} on ${commentedFile ?? 'Pull Request'}.`);

  return {
    isAdoEmail: true,
    title,
    description,
    classificationLabel: 'PR feedback',
    adoContext: {
      type: 'pr-comment',
      prNumber,
      reviewerName,
      commentedFile,
      reviewComment,
      crmProjectCode,
      prUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Azure DevOps link extraction and ranking
// ---------------------------------------------------------------------------

/** Label / URL patterns that indicate a non-actionable notification link. */
const ADO_SKIP_PATTERNS: RegExp[] = [
  /_notifications/i,
  /unsubscribe/i,
  /optout/i,
  /opt-out/i,
  /manage.*notif/i,
  /notif.*manage/i,
];

/** Returns true for URLs / labels that should never be chosen as the PR action link. */
function isAdoNoisyLink(href: string, label: string): boolean {
  return ADO_SKIP_PATTERNS.some((p) => p.test(href) || p.test(label));
}

/**
 * Scores a candidate (href, label) pair for its suitability as a PR/comment link.
 * Higher scores win.
 *
 * Priority order (descending):
 *   1. Anchor text contains "View comment"         → 100
 *   2. URL contains /pullrequest/ + discussionId   → 90
 *   3. URL contains /pullrequest/                  → 80
 *   4. URL contains discussionId                   → 70
 *   5. Anchor text contains "View pull request"    → 65
 *   6. URL contains /_git/                         → 40
 *   7. Any other dev.azure.com URL                 → 10
 *   Noise links (notification/unsubscribe)         → -1 (excluded)
 */
function scoreAdoLink(href: string, label: string): number {
  if (isAdoNoisyLink(href, label)) return -1;
  const h = href.toLowerCase();
  const l = label.toLowerCase();
  // Reject non-ADO URLs — both modern (dev.azure.com) and legacy (.visualstudio.com) are valid.
  const isAdoDomain = h.includes('dev.azure.com') || h.includes('.visualstudio.com');
  if (!isAdoDomain) return -1;
  if (/view comment/i.test(l))                                return 100;
  if (h.includes('pullrequest') && h.includes('discussionid')) return 90;
  if (h.includes('pullrequest'))                               return 80;
  if (h.includes('discussionid'))                              return 70;
  if (/view pull request/i.test(l))                           return 65;
  if (h.includes('/_git/'))                                   return 40;
  return 10;
}

/**
 * Extracts and ranks Azure DevOps links from the email body text.
 *
 * The Rust backend appends structured markers for every ADO <a href> found in the HTML:
 *   ##ADO## <href> ||| <anchor_text>
 *
 * Falls back to plain-text URL regex for any URL not captured via markers
 * (e.g. legacy body_full without markers or bodyPreview fallback).
 *
 * Returns the best-ranked usable DevOps URL, or undefined when none exists.
 */
function extractAdoPrUrl(bodyText: string): string | undefined {
  // --- Parse structured markers from Rust ---
  const candidates: Array<{ href: string; label: string; score: number }> = [];

  const markerRegex = /^##ADO## (https?:\/\/[^\s|]+(?:\|[^\s|]+)*) \|\|\| (.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(bodyText)) !== null) {
    const href  = m[1].trim();
    const label = m[2].trim();
    const score = scoreAdoLink(href, label);
    console.log(`[ado-link] candidate: score=${score} label="${label}" href=${href.slice(0, 100)}`);
    if (score >= 0) candidates.push({ href, label, score });
  }

  // --- Plain-text URL fallback (covers bodyPreview / legacy body_full) ---
  if (candidates.length === 0) {
    // Strip the marker lines before scanning so they don't interfere
    const plainText = bodyText.replace(/^##ADO##.*$/gm, '');
    // Match both dev.azure.com and legacy <org>.visualstudio.com URLs.
    const urlRe = /https:\/\/(?:dev\.azure\.com\/[^\s"<>)]+|[A-Za-z0-9-]+\.visualstudio\.com\/[^\s"<>)]+)/gi;
    let r: RegExpExecArray | null;
    while ((r = urlRe.exec(plainText)) !== null) {
      const href  = r[0].replace(/[.)]+$/, '');
      const score = scoreAdoLink(href, '');
      if (score >= 0) candidates.push({ href, label: '', score });
    }
  }

  if (candidates.length === 0) {
    console.log('[ado-link] no usable devops link found');
    return undefined;
  }

  // Sort descending by score; ties broken by insertion order (first occurrence wins)
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  console.log(`[ado-link] selected primary url=${best.href.slice(0, 100)} score=${best.score} label="${best.label}"`);
  return best.href;
}

/**
 * Extracts the actual review comment text from the stripped email body.
 * ADO PR comment emails contain the comment as a paragraph in the body.
 * We skip header/metadata lines and find the first substantive paragraph.
 */
function extractReviewComment(bodyText: string): string | undefined {
  const lines = bodyText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Skip header / metadata lines
  const skipPatterns = [
    /^From:/i,
    /^Subject:/i,
    /^To:/i,
    /^Date:/i,
    /^State:/i,
    /^Priority:/i,
    /^Assigned/i,
    /^Area Path:/i,
    /^Iteration/i,
    /^https?:/i,
    /^Pull Request/i,
    /\bhas commented on\b/i,
    /\bcommented on\b/i,
    /View the full\b/i,
    /Reply to this\b/i,
    /You can view the\b/i,
  ];

  for (const line of lines) {
    const skip = skipPatterns.some((p) => p.test(line));
    if (!skip && line.length > 15) {
      return line.slice(0, 600);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Work item parsing
// ---------------------------------------------------------------------------

/**
 * Detects and parses work item creation notification emails.
 *
 * Subject patterns detected:
 *   - "Jan Kvicala created Task 9276"
 *   - "Someone created Bug 1234"
 *   - "Work Item: Task 9276 - Deploy UAT"
 */
function parseWorkItem(
  subject: string,
  bodyText: string,
  crmProjectCode: string | undefined,
): AdoParseResult | null {

  // Pattern A: "Someone created <Type> <Number>"
  const createdMatch =
    /^.+?\s+created\s+(Task|Bug|Story|Feature|Epic|Issue)\s+(\d+)/i.exec(subject) ??
    /\b(Task|Bug|Story|Feature|Epic|Issue)\s+#?(\d+)\b/i.exec(subject);

  if (!createdMatch) return null;

  const workItemType   = createdMatch[1]; // e.g. "Task"
  const workItemNumber = parseInt(createdMatch[2] ?? '0', 10);

  // Extract the work item title from the body
  const workItemTitle = extractWorkItemTitle(bodyText, workItemNumber);

  // Build the clean task title
  const rawTitle = workItemTitle
    ? `${workItemType} ${workItemNumber} - ${workItemTitle}`
    : `${workItemType} ${workItemNumber}`;
  const title = normalizeTextTitle(rawTitle);

  // Extract structured fields from the body
  const workItemDescription   = extractField(bodyText, 'Description');
  const workItemState         = extractField(bodyText, 'State');
  const workItemAssignedTo    = extractField(bodyText, 'Assigned To');
  const workItemPriority      = extractField(bodyText, 'Priority');
  const workItemAreaPath      = extractField(bodyText, 'Area Path');
  const workItemIterationPath = extractField(bodyText, 'Iteration Path');

  // Extract the first Azure DevOps URL from the body
  const urlMatch    = /https:\/\/dev\.azure\.com\/[^\s"<>)]+/i.exec(bodyText);
  const workItemUrl = urlMatch ? urlMatch[0].replace(/[.)]+$/, '') : undefined;

  // Build a structured description
  const descParts: string[] = [];
  if (workItemTitle)       descParts.push(`**${workItemTitle}**`);
  if (workItemDescription) descParts.push(`\nDescription: ${workItemDescription}`);
  if (workItemState)       descParts.push(`State: ${workItemState}`);
  if (workItemAssignedTo)  descParts.push(`Assigned To: ${workItemAssignedTo}`);
  if (workItemPriority)    descParts.push(`Priority: ${workItemPriority}`);
  if (workItemAreaPath)    descParts.push(`Area: ${workItemAreaPath}`);
  if (workItemIterationPath) descParts.push(`Iteration: ${workItemIterationPath}`);
  if (workItemUrl)         descParts.push(`\nDevOps: ${workItemUrl}`);

  const description = descParts.join('\n') || bodyText.slice(0, 500);

  return {
    isAdoEmail: true,
    title,
    description,
    classificationLabel: 'ADO work item',
    adoContext: {
      type: 'work-item',
      workItemNumber,
      workItemType,
      workItemTitle,
      workItemState,
      workItemAssignedTo,
      workItemPriority,
      workItemAreaPath,
      workItemIterationPath,
      workItemUrl,
      workItemDescription,
      crmProjectCode,
    },
  };
}

/**
 * Extracts the work item title from the email body.
 * ADO work item emails typically include the title as an early prominent line.
 * Lines are scanned in order and the first plausible title is returned.
 */
function extractWorkItemTitle(bodyText: string, itemNumber: number): string | undefined {
  const skipPatterns = [
    /^From:/i,
    /^Subject:/i,
    /^To:/i,
    /^Date:/i,
    /^State:/i,
    /^Priority:/i,
    /^Assigned/i,
    /^Area/i,
    /^Iteration/i,
    /^Description:/i,
    /^https?:/i,
    /^Dear\b/i,
    /^Hi\b/i,
    // Lines mentioning the work item number directly (that's the notification text)
    new RegExp(`\\b${itemNumber}\\b`),
    // Lines that contain "created" (notification header like "Jan created Task 9276")
    /\bcreated\b/i,
  ];

  const lines = bodyText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 3 || line.length > 200) continue;
    const skip = skipPatterns.some((p) => p.test(line));
    if (skip) continue;
    // Prefer lines that look like a title: mostly word chars without heavy punctuation
    if (/^[\wÁÉÍÓÚŮĚŠČŘŽÝáéíóúůěščřžý\s\-–—/:()]+$/u.test(line)) {
      return line;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parses an email and returns structured Azure DevOps context when detected.
 *
 * Call this from import handlers before falling back to generic email handling.
 * The function is pure and deterministic — no AI, no async, no side effects.
 *
 * @param subject   Email subject line
 * @param fromEmail Sender email address
 * @param bodyText  Full body text (HTML-stripped). Pass bodyFull when available;
 *                  falls back gracefully to bodyPreview (truncated at 255 chars).
 */
export function parseAdoEmail(
  subject: string,
  fromEmail: string,
  bodyText: string,
): AdoParseResult {
  const nullResult: AdoParseResult = {
    isAdoEmail:          false,
    title:               null,
    description:         null,
    classificationLabel: undefined,
    adoContext:          null,
  };

  if (!isAdoSender(fromEmail)) return nullResult;

  const combo = `${subject}\n${bodyText}`;
  const crmProjectCode = extractCrmCode(combo);

  // 1a. For any "PR - " subject, check the body for non-actionable status events
  //     (approved, completed, merged) BEFORE issuing a task/review entry.
  //     These must be skipped deterministically — no OpenAI call.
  if (/^PR\s*-\s*/i.test(subject)) {
    const nonActionable = detectPrNonActionable(subject, bodyText);
    if (nonActionable) {
      console.log(
        `[ado-pr] subject="${subject.slice(0, 70)}"`,
        `detected subtype=${nonActionable.skipReason.includes('approved') ? 'ado_pr_approved' : 'ado_pr_completed'}`,
        `final outcome=skip`,
        `reason=${nonActionable.skipReason}`,
      );
      return {
        isAdoEmail:          true,
        title:               null,
        description:         null,
        classificationLabel: nonActionable.skipReason,
        adoContext:          { type: 'other', crmProjectCode },
        shouldSkip:          true,
        skipReason:          nonActionable.skipReason,
      };
    }
  }

  // 1b. PR review-request: "PR - <title> - <Project> <Number> (<Reviewer>)"
  //    Must be tried BEFORE the file-comment parser — the "PR - " prefix is
  //    unambiguous and covers the most common ADO PR notification format.
  const prReviewResult = parsePrReviewRequest(subject, bodyText, crmProjectCode);
  if (prReviewResult) {
    console.log(
      `[ado-pr] subject="${subject.slice(0, 70)}"`,
      `detected subtype=ado_pr_review_request`,
      `final outcome=task`,
      `reason=actionable review request`,
    );
    console.log(
      `[title-route] subject="${subject.slice(0, 70)}"`,
      `detectedType=ado_pr_review_request`,
      `source=deterministic_pr`,
      `finalTitle="${prReviewResult.title}"`,
    );
    return prReviewResult;
  }

  // 2. PR file-comment: "X has commented on <file>"
  const prResult = parsePrComment(subject, bodyText, crmProjectCode);
  if (prResult) {
    console.log(
      `[ado-pr] subject="${subject.slice(0, 70)}"`,
      `detected subtype=ado_pr_comment`,
      `final outcome=task`,
      `reason=actionable file comment`,
    );
    console.log(
      `[title-route] subject="${subject.slice(0, 70)}"`,
      `detectedType=ado_pr_comment`,
      `source=deterministic_pr`,
      `finalTitle="${prResult.title}"`,
    );
    return prResult;
  }

  // 3. Work item: "X created Task/Bug/Story <Number>"
  const wiResult = parseWorkItem(subject, bodyText, crmProjectCode);
  if (wiResult) {
    console.log(
      `[title-route] subject="${subject.slice(0, 70)}"`,
      `detectedType=ado_work_item`,
      `source=deterministic_wi`,
      `finalTitle="${wiResult.title}"`,
    );
    return wiResult;
  }

  // 4. Recognised ADO sender but no specific type matched — return as generic ADO item
  console.log(
    `[title-route] subject="${subject.slice(0, 70)}"`,
    `detectedType=ado_other`,
    `source=generic_fallback`,
    `finalTitle="${subject.trim().slice(0, 70)}"`,
  );
  return {
    isAdoEmail:          true,
    title:               subject.trim() || null,
    description:         bodyText.slice(0, 500),
    classificationLabel: 'ADO notification',
    adoContext:          { type: 'other', crmProjectCode },
  };
}
