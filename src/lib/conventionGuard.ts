/**
 * Post-generation convention guard.
 *
 * Runs deterministic local checks on AI-proposed content before Apply is enabled.
 * No AI calls — pure string pattern matching only.
 */

export interface ConventionViolation {
  rule: string;
  description: string;
  matchedLines: string[];
}

export interface ConventionGuardResult {
  /** Blocking violations introduced by the proposed content (not present in current file). */
  violations: ConventionViolation[];
  hasBlockingViolations: boolean;
  /** Feedback text to include in a re-generation prompt. */
  feedbackForRegeneration: string;
}

// Patterns that match void early-return lines (single-line matching).
// Multi-line `if (...) {\n  return;\n}` is caught via the bare-return pattern.
const EARLY_RETURN_PATTERNS = [
  /^\s*return\s*;\s*$/,                          // bare return;
  /^\s*if\s*\(.*\)\s*return\s*;\s*$/,            // if (...) return;
  /^\s*if\s*\(.*\)\s*\{\s*return\s*;\s*\}\s*$/, // if (...) { return; }
];

function findEarlyReturnLines(content: string): string[] {
  return content.split('\n').filter((line) =>
    EARLY_RETURN_PATTERNS.some((p) => p.test(line))
  );
}

function countOccurrences(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Checks CRM JavaScript proposed content for newly introduced convention violations.
 *
 * @param proposedContent   AI-generated proposed file content.
 * @param currentContent    Existing file content (used to suppress pre-existing violations).
 */
export function checkCrmJavaScriptConventions(
  proposedContent: string,
  currentContent?: string,
): ConventionGuardResult {
  const proposedMatches = findEarlyReturnLines(proposedContent);
  const currentMatches = currentContent ? findEarlyReturnLines(currentContent) : [];
  const currentCounts = countOccurrences(currentMatches);

  const newViolations: string[] = [];
  const available = new Map(currentCounts);

  for (const line of proposedMatches) {
    const key = line.trim();
    const count = available.get(key) ?? 0;
    if (count > 0) {
      available.set(key, count - 1); // consume one existing occurrence
    } else {
      newViolations.push(line);
    }
  }

  if (newViolations.length === 0) {
    return { violations: [], hasBlockingViolations: false, feedbackForRegeneration: '' };
  }

  const violation: ConventionViolation = {
    rule: 'no-early-return',
    description: 'Early return / guard-clause return introduced in proposed content',
    matchedLines: newViolations,
  };

  const feedback =
    `Your previous output introduced early return(s) which violate AI Kit CRM JavaScript conventions:\n` +
    newViolations.map((l) => `  ${l.trim()}`).join('\n') +
    `\n\nRegenerate without any early return or guard-clause return. ` +
    `Use explicit positive if/else branching instead. ` +
    `If all required attributes/controls exist, execute the logic inside the if block. ` +
    `If dependencies are missing, do nothing — no return statement needed.`;

  return {
    violations: [violation],
    hasBlockingViolations: true,
    feedbackForRegeneration: feedback,
  };
}
