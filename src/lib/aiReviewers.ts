/**
 * Default AI reviewer configurations and reviewer selection logic.
 *
 * Reviewers are matched by file extension and optional dev target kind.
 * The first enabled matching reviewer is selected automatically.
 */
import type { AiReviewerConfig, AiReviewSource } from '../types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_AI_REVIEWERS: AiReviewerConfig[] = [
  {
    id: 'csharp-plugin-crm',
    name: 'C# Plugin CRM Reviewer',
    description: 'Reviews Dynamics 365 / Dataverse plugin code for correctness, CRM patterns, and common pitfalls.',
    enabled: true,
    model: '',
    temperature: 0.2,
    quickPrompts: [
      'Check for missing null checks on context InputParameters.',
      'Verify the plugin is registered with the correct execution stage.',
      'Look for synchronous callouts or long-running operations that should be async.',
      'Check that TracingService.Trace is used for all non-trivial branches.',
      'Identify any hardcoded GUIDs or strings that should be configuration.',
    ],
    instructions: `You are a senior Dynamics 365 / Dataverse plugin developer.
Review the provided C# plugin code and return a structured Markdown report.

Focus on:
- Correct use of IPluginExecutionContext, IOrganizationService, ITracingService
- Null checks on InputParameters["Target"] and other context values
- Missing or incorrect plugin registration stage (Pre/Post, Sync/Async)
- Hardcoded GUIDs, entity names, or attribute names
- Use of deprecated SDK classes (early-bound vs late-bound usage consistency)
- Any synchronous web service calls or long-running logic (should be avoided in sync plugins)
- Exception handling — catching only expected exceptions, not all Exception
- TracingService.Trace usage for debugging key branching points
- IOrganizationService being created with InitiatingUserId vs null (system vs user context)
- Any obvious logic bugs or missing edge cases

Return your review in this Markdown format:

## Summary
One paragraph describing the overall code quality.

## Issues
- **[Severity: High/Medium/Low]** Description of issue and location.

## Suggestions
- Description of improvement.

## Verdict
PASS or NEEDS WORK — one sentence explanation.`,
    appliesTo: {
      fileExtensions: ['cs'],
      devTargetKinds: ['plugin'],
    },
  },
  {
    id: 'javascript-powerapps-script',
    name: 'JavaScript Power Apps Script Reviewer',
    description: 'Reviews Power Apps / Model-driven app JavaScript code for correctness, Xrm API usage, and best practices.',
    enabled: true,
    model: '',
    temperature: 0.2,
    quickPrompts: [
      'Check for deprecated Xrm.Page usage — should use formContext instead.',
      'Verify that all asynchronous calls use Promises or async/await.',
      'Look for global variable declarations that could pollute the namespace.',
      'Check that onChange handlers guard against null field values.',
      'Verify that any Xrm.WebApi calls handle errors with .catch().',
    ],
    instructions: `You are a senior Microsoft Power Apps / Model-driven app JavaScript developer.
Review the provided JavaScript or TypeScript code and return a structured Markdown report.

Focus on:
- Use of deprecated Xrm.Page — should be replaced with formContext (received as parameter)
- Proper use of Xrm.WebApi, Xrm.Navigation, Xrm.Utility
- Correct async/await or Promise chaining — no fire-and-forget calls
- Global namespace pollution — all functions should be in a module/namespace object
- Null guards before accessing field values (getValue() can return null)
- Error handling on all WebApi calls and async operations
- Correct form event handler signatures (executionContext as first parameter)
- Any hardcoded record IDs or environment-specific values
- Field name typos or incorrect entity logical names
- Any code that may run on unsupported browsers or Power Apps environments

Return your review in this Markdown format:

## Summary
One paragraph describing the overall code quality.

## Issues
- **[Severity: High/Medium/Low]** Description of issue and location.

## Suggestions
- Description of improvement.

## Verdict
PASS or NEEDS WORK — one sentence explanation.`,
    appliesTo: {
      fileExtensions: ['js', 'ts'],
      devTargetKinds: ['script'],
    },
  },
];

// ---------------------------------------------------------------------------
// Reviewer selection
// ---------------------------------------------------------------------------

/**
 * Returns a merged list of reviewer configs: defaults + user-overrides.
 * User configs with a matching id override the default; new user configs are appended.
 * The order preserves defaults first, then any new user-only entries.
 */
export function mergeWithDefaults(userConfigs: AiReviewerConfig[] | undefined): AiReviewerConfig[] {
  if (!userConfigs || userConfigs.length === 0) return DEFAULT_AI_REVIEWERS;
  const defaults = DEFAULT_AI_REVIEWERS.map((d) => {
    const override = userConfigs.find((u) => u.id === d.id);
    return override ?? d;
  });
  const extras = userConfigs.filter((u) => !DEFAULT_AI_REVIEWERS.some((d) => d.id === u.id));
  return [...defaults, ...extras];
}

/**
 * Returns the file extension (without dot, lowercase) of the given path.
 * Returns '' when no extension is found.
 */
function fileExt(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

/**
 * Selects the best matching enabled reviewer for the given file and dev mode.
 *
 * Matching rules (first match wins):
 *   1. fileExtension match AND devTargetKind match (when devTargetKinds is set)
 *   2. fileExtension match only (when devTargetKinds is absent/empty)
 *
 * Returns undefined when no enabled reviewer matches.
 */
export function selectReviewer(
  configs: AiReviewerConfig[],
  filePath: string,
  devMode?: 'plugin' | 'script',
): AiReviewerConfig | undefined {
  const ext = fileExt(filePath);

  // Priority 0: no file extension — fall back to devMode-only match.
  // This handles cases where the path is a directory or the file hasn't been resolved yet.
  if (!ext) {
    if (devMode === undefined) return undefined;
    return configs.find(
      (r) =>
        r.enabled &&
        r.appliesTo.devTargetKinds &&
        r.appliesTo.devTargetKinds.includes(devMode),
    );
  }

  // Priority 1: extension + devTargetKind both match
  const strictMatch = configs.find(
    (r) =>
      r.enabled &&
      r.appliesTo.fileExtensions.includes(ext) &&
      r.appliesTo.devTargetKinds &&
      r.appliesTo.devTargetKinds.length > 0 &&
      devMode !== undefined &&
      r.appliesTo.devTargetKinds.includes(devMode),
  );
  if (strictMatch) return strictMatch;

  // Priority 2: extension match only — but still respect devTargetKinds when devMode is known.
  // A reviewer that declares devTargetKinds should not fire for a mismatched mode.
  return configs.find(
    (r) =>
      r.enabled &&
      r.appliesTo.fileExtensions.includes(ext) &&
      (
        !r.appliesTo.devTargetKinds ||
        r.appliesTo.devTargetKinds.length === 0 ||
        devMode === undefined ||
        r.appliesTo.devTargetKinds.includes(devMode)
      ),
  );
}

/**
 * Infers the review source for display/badge purposes.
 *
 * Priority:
 *   1. Explicit `reviewSource` field on the entry.
 *   2. Reviewer name contains "AI Kit" → 'ai-kit'.
 *   3. Otherwise → 'legacy' (old entry or unknown origin).
 */
export function inferReviewSource(
  review: { reviewSource?: string; reviewerName?: string },
): AiReviewSource {
  if (review.reviewSource === 'ai-kit')   return 'ai-kit';
  if (review.reviewSource === 'settings') return 'settings';
  if (review.reviewerName?.includes('AI Kit')) return 'ai-kit';
  return 'legacy';
}
