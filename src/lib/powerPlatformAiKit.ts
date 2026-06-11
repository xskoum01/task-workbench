/**
 * Power Platform AI Kit context loader.
 *
 * Validates the kit path, detects task kind, and loads only the relevant rule
 * files so they can be included in AI implementation / review prompts.
 *
 * No AI is called here — this module only reads files and assembles context.
 */
import type { Task } from '../types';
import { checkPathExists, readFileContent } from './tauriCommands';
export { isPathInsideDir } from './pathUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiKitTaskKind = 'plugin' | 'script' | 'ribbon' | 'crm-other';

export interface PowerPlatformAiKitContext {
  kitPath: string;
  taskKind: AiKitTaskKind;
  /** Content of AGENTS.md. */
  agentInstructions: string;
  /** Content of the task-kind-specific rules file. */
  taskRules: string;
  /** Content of known-pr-review-comments.md — always loaded (needed for both implementation and review). */
  reviewRules?: string;
  /** Content of crm-code-review-checklist.md — always loaded. */
  checklist?: string;
  /** Content of prompts/pp-implement-crm-task.md. */
  implementPromptTemplate?: string;
  /** Content of prompts/pp-review-diff.md. */
  reviewPromptTemplate?: string;
  /** Relative paths of successfully loaded files. */
  loadedFiles: string[];
}

export interface AiKitValidationResult {
  valid: boolean;
  kitPath: string;
  missingFiles: string[];
  /** Human-readable status string. */
  statusMessage: string;
}

// ---------------------------------------------------------------------------
// Required file list
// ---------------------------------------------------------------------------

const REQUIRED_FILES = [
  'AGENTS.md',
  'ai-rules/crm-plugin-rules.md',
  'ai-rules/crm-javascript-rules.md',
  'ai-rules/crm-ribbon-rules.md',
  'ai-rules/crm-other-rules.md',
  'ai-rules/known-pr-review-comments.md',
  'ai-rules/crm-code-review-checklist.md',
  'prompts/pp-implement-crm-task.md',
  'prompts/pp-review-diff.md',
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function joinPath(base: string, rel: string): string {
  const normalised = base.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return `${normalised}/${rel}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateAiKitPath(kitPath: string): Promise<AiKitValidationResult> {
  const normalised = (kitPath ?? '').trim();
  if (!normalised) {
    return { valid: false, kitPath: normalised, missingFiles: REQUIRED_FILES, statusMessage: 'Path is not configured.' };
  }

  const missing: string[] = [];
  for (const rel of REQUIRED_FILES) {
    const full = joinPath(normalised, rel);
    const exists = await checkPathExists(full).catch(() => false);
    if (!exists) missing.push(rel);
  }

  if (missing.length === 0) {
    return { valid: true, kitPath: normalised, missingFiles: [], statusMessage: 'Valid kit — all required files found.' };
  }

  let statusMessage: string;
  if (missing.includes('AGENTS.md')) {
    statusMessage = 'Invalid kit: missing AGENTS.md';
  } else if (missing.some((f) => f.startsWith('ai-rules/'))) {
    statusMessage = `Invalid kit: missing ${missing.filter((f) => f.startsWith('ai-rules/')).join(', ')}`;
  } else if (missing.some((f) => f.startsWith('prompts/'))) {
    statusMessage = `Invalid kit: missing ${missing.filter((f) => f.startsWith('prompts/')).join(', ')}`;
  } else {
    statusMessage = `Invalid kit: missing ${missing.join(', ')}`;
  }

  return { valid: false, kitPath: normalised, missingFiles: missing, statusMessage };
}

// ---------------------------------------------------------------------------
// Task kind detection
// ---------------------------------------------------------------------------

/**
 * Detects the task kind based on workflowSetup.devTargetKind, scriptPath,
 * artifactPath file extension, and task title / original message keywords.
 */
export function detectTaskKindFromTask(task: Task): AiKitTaskKind {
  const setup = task.workflowSetup;

  // 1. Explicit devTargetKind from workflow setup
  if (setup?.devTargetKind === 'plugin') return 'plugin';
  if (setup?.devTargetKind === 'script') return 'script';

  // 2. Artifact path extension
  const artifact = setup?.artifactPath ?? setup?.scriptPath ?? '';
  if (/\.cs$/i.test(artifact)) return 'plugin';
  if (/\.[jt]s$/i.test(artifact)) return 'script';

  // 3. Script path without artifactPath
  if (setup?.scriptPath) return 'script';

  // 4. CRM developer work kind from workflow state
  const workKind = task.crmDeveloperWorkflow?.detectedWorkKind;
  if (workKind === 'plugin') return 'plugin';
  if (workKind === 'script') return 'script';
  if (workKind === 'ribbon') return 'ribbon';

  // 5. Keyword heuristics on title + description
  const text = `${task.title} ${task.originalMessage ?? ''}`.toLowerCase();
  if (/\bribbon\b|\bpanel\b|\bcommand bar\b/.test(text)) return 'ribbon';
  if (/\bplugin\b|\bplug-in\b|\bc#\b|\b\.cs\b/.test(text)) return 'plugin';
  if (/\bscript\b|\bjavascript\b|\bjs\b|\bform event\b/.test(text)) return 'script';

  return 'crm-other';
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

const RULES_MAP: Record<AiKitTaskKind, string> = {
  plugin:    'ai-rules/crm-plugin-rules.md',
  script:    'ai-rules/crm-javascript-rules.md',
  ribbon:    'ai-rules/crm-ribbon-rules.md',
  'crm-other': 'ai-rules/crm-other-rules.md',
};

async function tryRead(kitPath: string, rel: string): Promise<string | null> {
  try {
    return await readFileContent(joinPath(kitPath, rel));
  } catch {
    return null;
  }
}

/**
 * Loads the AI Kit context for the given task kind.
 *
 * known-pr-review-comments.md and crm-code-review-checklist.md are always
 * loaded — they apply to both implementation and review to prevent common
 * PR issues from being introduced during generation.
 *
 * @param kitPath         Absolute path to the AI Kit repository root.
 * @param taskKind        Detected task kind (determines which rules file to load).
 * @param forReview       When true, also loads the review prompt template (pp-review-diff.md).
 * @param includePrompts  When true, also loads both prompt templates.
 */
export async function loadAiKitContext(
  kitPath: string,
  taskKind: AiKitTaskKind,
  forReview: boolean,
  includePrompts = false,
): Promise<PowerPlatformAiKitContext> {
  const validation = await validateAiKitPath(kitPath);
  if (!validation.valid) {
    throw new Error(`AI Kit is not valid: ${validation.statusMessage}`);
  }

  const loadedFiles: string[] = [];

  async function load(rel: string): Promise<string> {
    const content = await tryRead(kitPath, rel);
    if (content != null) loadedFiles.push(rel);
    return content ?? '';
  }

  const agentInstructions = await load('AGENTS.md');
  const rulesFile = RULES_MAP[taskKind];
  const taskRules = await load(rulesFile);

  // Always load PR review comments and checklist — they prevent common issues
  // during implementation as well as review.
  const reviewRules = await load('ai-rules/known-pr-review-comments.md');
  const checklist   = await load('ai-rules/crm-code-review-checklist.md');

  let implementPromptTemplate: string | undefined;
  let reviewPromptTemplate: string | undefined;
  if (includePrompts) {
    implementPromptTemplate = await load('prompts/pp-implement-crm-task.md');
    reviewPromptTemplate    = await load('prompts/pp-review-diff.md');
  } else if (forReview) {
    reviewPromptTemplate = await load('prompts/pp-review-diff.md');
  }

  return {
    kitPath,
    taskKind,
    agentInstructions,
    taskRules,
    reviewRules,
    checklist,
    implementPromptTemplate,
    reviewPromptTemplate,
    loadedFiles,
  };
}

// ---------------------------------------------------------------------------
// Section-aware markdown assembly
// ---------------------------------------------------------------------------

const CRITICAL_HEADING_KEYWORDS = [
  'early return',
  'single return',
  'guard clause',
  'guard-clause',
  'mandatory',
  'do not',
  'must not',
  'forbidden',
  'never use',
  'required',
  'pr-005',
];

function isHeadingCritical(heading: string): boolean {
  const lower = heading.toLowerCase();
  return CRITICAL_HEADING_KEYWORDS.some((kw) => lower.includes(kw));
}

interface MarkdownSection {
  heading: string;
  body: string;
  isCritical: boolean;
}

function splitMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = content.split('\n');
  let heading = '';
  let bodyLines: string[] = [];

  function flush(): void {
    const body = bodyLines.join('\n');
    if (heading || body.trim()) {
      sections.push({ heading, body, isCritical: isHeadingCritical(heading) });
    }
  }

  for (const line of lines) {
    if (/^#{1,4} /.test(line)) {
      flush();
      heading = line;
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Assembles markdown content for inclusion in an AI prompt.
 *
 * Strategy:
 * - If content fits within maxChars, return it unchanged.
 * - Otherwise include sections in file order until budget runs out.
 * - Any critical sections (early return, single return, mandatory, etc.) that
 *   were cut from the middle of the file are appended at the end so they are
 *   never silently dropped.
 *
 * This guarantees critical rules survive even when they appear late in large files.
 */
export function assembleMarkdownForPrompt(content: string, maxChars: number): string {
  if (!content) return '';
  if (content.length <= maxChars) return content;

  const sections = splitMarkdownSections(content);
  const included: string[] = [];
  const deferredCritical: MarkdownSection[] = [];
  let budget = maxChars;

  for (const s of sections) {
    const text = s.heading ? `${s.heading}\n${s.body}` : s.body;
    if (text.length + 2 <= budget) {
      included.push(text);
      budget -= text.length + 2;
    } else if (s.isCritical) {
      deferredCritical.push(s);
    }
    // Non-critical sections beyond budget are dropped silently.
  }

  // Append critical sections that didn't fit in their original position.
  for (const s of deferredCritical) {
    const text = `${s.heading}\n${s.body}`;
    included.push(text);
  }

  const truncNote = deferredCritical.length > 0
    ? `\n[AI Kit assembler: non-critical sections truncated; ${deferredCritical.length} critical section(s) preserved from later in file]`
    : `\n[AI Kit assembler: content truncated at ${maxChars} chars]`;

  return included.join('\n\n') + truncNote;
}

// ---------------------------------------------------------------------------
// Critical AI Kit rules block
// ---------------------------------------------------------------------------

/**
 * Builds an explicit "CRITICAL AI KIT RULES" block for the given task kind.
 * These rules must appear before the full file content to reinforce key conventions.
 */
export function buildCriticalAiKitRules(taskKind: AiKitTaskKind): string {
  const lines: string[] = [];
  lines.push('## CRITICAL AI KIT RULES');
  lines.push('These rules are non-negotiable. They must be followed even when not explicitly repeated in the rules files below.');
  lines.push('');

  if (taskKind === 'script') {
    lines.push('**No early returns / guard-clause returns:**');
    lines.push('- Do NOT write `return;` as a guard at the start or middle of a function.');
    lines.push('- Do NOT write `if (!x) return;` or `if (!x) { return; }` patterns.');
    lines.push('- Use positive if/else: `if (allDepsExist) { ... logic ... }` — no return needed when deps are absent.');
    lines.push('');
    lines.push('**Single return per function (where reasonably possible):**');
    lines.push('- Structure logic so all branches exit naturally at the function end.');
    lines.push('- Nested positive conditions are preferred over guard-clause returns.');
    lines.push('');
    lines.push('**Do not silently return when CRM attributes/controls are missing:**');
    lines.push('- If `getAttribute(...)` or `getControl(...)` may be null, wrap the entire logic in a positive check.');
    lines.push('- If a field/attribute name comes from the task assignment but was not confirmed by Dataverse verification, still use the exact name from the task. Add "Metadata not confirmed: [field_name]" to risks or testScenarios — do NOT set clarificationNeeded for this.');
    lines.push('- Only set clarificationNeeded when the task does not specify what field names or entity names to use at all.');
    lines.push('');
    lines.push('**Preserve existing file style:**');
    lines.push('- Match indentation, naming, and function declaration style of the existing file exactly.');
    lines.push('- Do NOT introduce namespace / IIFE / class / module / "use strict" unless the existing file uses it.');
    lines.push('');
    lines.push('**Use exact names from the task:**');
    lines.push('- Use attribute logical names, control names, and option set values exactly as stated in the task or technical plan.');
  } else if (taskKind === 'plugin') {
    lines.push('**No early returns as default flow style:**');
    lines.push('- Avoid `return;` as primary flow control. Use positive conditions.');
    lines.push('- Reserve early returns only for exceptional error conditions explicitly required by the plan.');
    lines.push('');
    lines.push('**No over-guarding:**');
    lines.push('- Do not add defensive null-checks or guard-clause returns unless the approved plan requires them.');
    lines.push('');
    lines.push('**No invented metadata:**');
    lines.push('- Do not invent entity names, attribute names, option set values, or relationship names.');
    lines.push('- Use only what is explicitly stated in the task and technical plan.');
    lines.push('');
    lines.push('**No placeholders or TODOs:**');
    lines.push('- Do not write `// TODO`, `// Placeholder`, or stub implementations.');
    lines.push('- If field/attribute names from the task were not confirmed by Dataverse verification, still use the exact names stated in the task. Add "Metadata not confirmed: [field_name]" to risks or testScenarios — do NOT set clarificationNeeded for unconfirmed metadata.');
    lines.push('');
    lines.push('**Preserve existing project/class style:**');
    lines.push('- Match the namespace, class structure, and patterns of the existing plugin project.');
  } else {
    lines.push('- No early returns as default flow style. Use positive conditions.');
    lines.push('- Preserve existing file style exactly.');
    lines.push('- Use exact names from the task — no invented metadata.');
    lines.push('- No placeholder/TODO code.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildImplementInstructions(
  ctx: PowerPlatformAiKitContext,
  options?: { createMode?: boolean; violationFeedback?: string },
): string {
  const parts: string[] = [];
  const createMode = !!options?.createMode;

  parts.push('You are an expert Navertica CRM developer implementing a task according to Power Platform AI Kit rules.');
  parts.push('');
  parts.push('## MANDATORY CONSTRAINTS');
  parts.push('- Make minimal changes — modify only what the task requires.');
  parts.push('- Do NOT do out-of-scope refactoring or cleanup.');
  parts.push('- Do NOT invent Dataverse entity logical names, attribute logical names, or option set values. Use only names explicitly stated in the task or technical plan.');
  parts.push('- Respect existing code style (indentation, naming conventions, patterns).');
  parts.push('- Do NOT commit, push, create PR, or modify Git state.');
  parts.push('- Do NOT write to Dataverse, Azure DevOps, GitHub, or any external system.');
  parts.push('- Only change the single target file provided.');
  parts.push('- Do NOT use DateTime.UtcNow, Guid.NewGuid(), random number generators, or timestamp values as business identifiers or sequence numbers unless the task explicitly requires it.');
  parts.push('- Do NOT add placeholder methods, TODO comments ("// TODO", "// Placeholder", "// Implement"), or stub implementations.');
  parts.push('- In PreOperation Create/Update plugins, prefer setting attributes on context.InputParameters["Target"] directly rather than calling service.Update() on the primary entity, unless the plan explicitly specifies Update.');
  parts.push('- Use the exact field names, entity names, and business logic specified in the task assignment and technical plan — no approximations.');
  if (createMode) {
    parts.push('- Create mode: current file content may be empty or missing; generate the complete initial file content for the resolved artifact path.');
    parts.push('- Do NOT switch to a different file path even if task text mentions alternatives.');
  }
  parts.push('');

  parts.push('## CLARIFICATION POLICY');
  parts.push('Set clarificationNeeded ONLY when the task assignment itself is ambiguous or impossible:');
  parts.push('- Target file/artifact path cannot be determined from the task');
  parts.push('- Requirement is directly contradictory or physically impossible');
  parts.push('- Required attribute/entity/field names are NOT stated anywhere in the task text at all');
  parts.push('- Business logic cannot be inferred without additional clarification from the requester');
  parts.push('');
  parts.push('Do NOT set clarificationNeeded for:');
  parts.push('- Failed or missing Dataverse metadata verification');
  parts.push('- Primarch MCP unavailable or metadata not yet verified');
  parts.push('- Field names from the task assignment that were not confirmed in Dataverse schema');
  parts.push('- Any verification check result — Dataverse checks happen in Verify Implementation, not here');
  parts.push('When field names from the task were not confirmed by Dataverse verification, use them as-is and list "Metadata not confirmed: [field_name]" in risks or testScenarios.');
  parts.push('');

  parts.push(buildCriticalAiKitRules(ctx.taskKind));
  parts.push('');

  if (options?.violationFeedback) {
    parts.push('## VIOLATION FEEDBACK FROM PREVIOUS GENERATION');
    parts.push('Your previous output violated AI Kit conventions. Correct these issues before generating again:');
    parts.push(options.violationFeedback);
    parts.push('');
  }

  if (ctx.agentInstructions) {
    parts.push('## AGENT INSTRUCTIONS (AGENTS.md)');
    parts.push(assembleMarkdownForPrompt(ctx.agentInstructions, 3000));
    parts.push('');
  }

  if (ctx.taskRules) {
    parts.push(`## TASK-KIND RULES (${RULES_MAP[ctx.taskKind]})`);
    parts.push(assembleMarkdownForPrompt(ctx.taskRules, 5000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS (ai-rules/known-pr-review-comments.md)');
    parts.push('Avoid introducing any of the following patterns during implementation:');
    parts.push(assembleMarkdownForPrompt(ctx.reviewRules, 3000));
    parts.push('');
  }

  if (ctx.checklist) {
    parts.push('## CRM CODE REVIEW CHECKLIST (ai-rules/crm-code-review-checklist.md)');
    parts.push('Satisfy all applicable checklist items:');
    parts.push(assembleMarkdownForPrompt(ctx.checklist, 3000));
    parts.push('');
  }

  if (ctx.implementPromptTemplate) {
    parts.push('## IMPLEMENTATION PROMPT TEMPLATE (prompts/pp-implement-crm-task.md)');
    parts.push(assembleMarkdownForPrompt(ctx.implementPromptTemplate, 3000));
    parts.push('');
  }

  parts.push('## OUTPUT FORMAT');
  parts.push('Return ONLY valid JSON with the following schema (no prose, no markdown fences):');
  parts.push(`{
  "proposedContent": "<complete new file content — leave empty string only when clarificationNeeded is set>",
  "summary": "<brief description of what was changed and why, or 'Clarification needed' if blocked>",
  "changedSections": ["<description of each changed section>"],
  "risks": ["<risk1>", "<risk2>"],
  "testScenarios": ["<test scenario 1>", "<test scenario 2>"],
  "clarificationNeeded": "<set ONLY when the task assignment itself is ambiguous or impossible — e.g., no artifact path resolvable, contradictory requirement, or required field names not stated in task text at all. Do NOT set for failed/missing Dataverse verification — use exact field names from task and note any unconfirmed fields in risks or testScenarios instead>"
}`);

  return parts.join('\n');
}

/**
 * Builds the system instructions string for "Review Diff with AI Kit".
 *
 * Note: the JSON output schema is appended by the Rust run_ai_change_review command.
 * This function provides the CRM-specific context and rules only.
 */
export function buildDiffReviewInstructions(ctx: PowerPlatformAiKitContext): string {
  const parts: string[] = [];

  parts.push('You are a Navertica CRM code reviewer performing a diff review according to Power Platform AI Kit rules.');
  parts.push('Review ONLY the changes shown in the diff — do not comment on code not visible in the diff.');
  parts.push('This is a READ-ONLY review. Do NOT commit, push, modify files, or perform any write action.');
  parts.push('');

  if (ctx.agentInstructions) {
    parts.push('## AGENT INSTRUCTIONS');
    parts.push(assembleMarkdownForPrompt(ctx.agentInstructions, 2000));
    parts.push('');
  }

  if (ctx.taskRules) {
    parts.push('## CRM DEVELOPMENT RULES (Power Platform AI Kit)');
    parts.push(assembleMarkdownForPrompt(ctx.taskRules, 3000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS (check diff for these patterns)');
    parts.push(assembleMarkdownForPrompt(ctx.reviewRules, 2000));
    parts.push('');
  }

  if (ctx.checklist) {
    parts.push('## CRM CODE REVIEW CHECKLIST (verify applicable items)');
    parts.push(assembleMarkdownForPrompt(ctx.checklist, 2000));
    parts.push('');
  }

  if (ctx.reviewPromptTemplate) {
    parts.push('## REVIEW PROMPT TEMPLATE');
    parts.push(assembleMarkdownForPrompt(ctx.reviewPromptTemplate, 2000));
    parts.push('');
  }

  parts.push('Map severity as follows: "critical"/"major" = blocking issues; "minor"/"suggestion" = non-blocking.');
  parts.push('Use verdict "needs_changes" for FAIL (blockers present), "comment" for WARN (warnings only), "pass" for PASS (no issues).');

  return parts.join('\n');
}

/**
 * Builds the system instructions string for "Apply AI Review Fixes".
 */
export function buildApplyFixesInstructions(ctx: PowerPlatformAiKitContext, reviewText: string): string {
  const parts: string[] = [];

  parts.push('You are a Navertica CRM developer applying fixes from an AI code review.');
  parts.push('');
  parts.push('## MANDATORY CONSTRAINTS');
  parts.push('- Fix ONLY the blockers and warnings listed in the review below.');
  parts.push('- Do NOT add new functionality or features.');
  parts.push('- Do NOT refactor code that is not related to the review comments.');
  parts.push('- Do NOT touch files not mentioned in the reviewed diff unless strictly necessary.');
  parts.push('- If a comment requires business clarification or Dataverse metadata, stop and output a clarification request instead of guessing.');
  parts.push('- Do NOT commit, push, or modify Git state.');
  parts.push('- Do NOT write to Dataverse or any external system.');
  parts.push('');

  if (ctx.taskRules) {
    parts.push('## CRM DEVELOPMENT RULES');
    parts.push(assembleMarkdownForPrompt(ctx.taskRules, 2000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS');
    parts.push(assembleMarkdownForPrompt(ctx.reviewRules, 1500));
    parts.push('');
  }

  parts.push('## REVIEW TO FIX');
  parts.push(reviewText.slice(0, 4000));
  parts.push('');

  parts.push('## OUTPUT FORMAT');
  parts.push('Return ONLY valid JSON (no prose, no markdown fences):');
  parts.push(`{
  "proposedContent": "<complete new file content as a single string>",
  "summary": "<what was fixed and why>",
  "fixedIssues": ["<issue 1>", "<issue 2>"],
  "skippedIssues": ["<issue that required clarification — explain why skipped>"],
  "risks": ["<risk 1>"]
}`);

  return parts.join('\n');
}
