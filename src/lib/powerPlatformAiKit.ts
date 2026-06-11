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
  /** Content of known-pr-review-comments.md (review actions only). */
  reviewRules?: string;
  /** Content of crm-code-review-checklist.md (review actions only). */
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
 * @param kitPath     Absolute path to the AI Kit repository root.
 * @param taskKind    Detected task kind (determines which rules file to load).
 * @param forReview   When true, also loads known-pr-review-comments and checklist.
 * @param includePrompts  When true, also loads prompt templates.
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

  let reviewRules: string | undefined;
  let checklist: string | undefined;
  if (forReview) {
    reviewRules = await load('ai-rules/known-pr-review-comments.md');
    checklist   = await load('ai-rules/crm-code-review-checklist.md');
  }

  let implementPromptTemplate: string | undefined;
  let reviewPromptTemplate: string | undefined;
  if (includePrompts) {
    implementPromptTemplate = await load('prompts/pp-implement-crm-task.md');
    reviewPromptTemplate    = await load('prompts/pp-review-diff.md');
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
// Prompt builders
// ---------------------------------------------------------------------------

export function buildImplementInstructions(
  ctx: PowerPlatformAiKitContext,
  options?: { createMode?: boolean },
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
  parts.push('- Do NOT add placeholder methods, TODO comments ("// TODO", "// Placeholder", "// Implement"), or stub implementations. If a section cannot be implemented without missing metadata, set clarificationNeeded instead.');
  parts.push('- In PreOperation Create/Update plugins, prefer setting attributes on context.InputParameters["Target"] directly rather than calling service.Update() on the primary entity, unless the plan explicitly specifies Update.');
  parts.push('- Use the exact field names, entity names, and business logic specified in the task assignment and technical plan — no approximations.');
  if (createMode) {
    parts.push('- Create mode: current file content may be empty or missing; generate the complete initial file content for the resolved artifact path.');
    parts.push('- Do NOT switch to a different file path even if task text mentions alternatives.');
  }
  parts.push('');

  if (ctx.agentInstructions) {
    parts.push('## AGENT INSTRUCTIONS (from AGENTS.md)');
    parts.push(ctx.agentInstructions.slice(0, 3000));
    parts.push('');
  }

  if (ctx.taskRules) {
    parts.push(`## CRM DEVELOPMENT RULES (${RULES_MAP[ctx.taskKind]})`);
    parts.push(ctx.taskRules.slice(0, 4000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS (avoid these issues)');
    parts.push(ctx.reviewRules.slice(0, 2000));
    parts.push('');
  }

  if (ctx.checklist) {
    parts.push('## CRM CODE REVIEW CHECKLIST (satisfy all applicable items)');
    parts.push(ctx.checklist.slice(0, 2000));
    parts.push('');
  }

  if (ctx.implementPromptTemplate) {
    parts.push('## IMPLEMENTATION PROMPT TEMPLATE');
    parts.push(ctx.implementPromptTemplate.slice(0, 2000));
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
  "clarificationNeeded": "<set to a non-empty string listing the exact missing Dataverse metadata or business logic that prevents implementation; omit or leave empty string if not needed>"
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
    parts.push(ctx.agentInstructions.slice(0, 2000));
    parts.push('');
  }

  if (ctx.taskRules) {
    parts.push('## CRM DEVELOPMENT RULES (Power Platform AI Kit)');
    parts.push(ctx.taskRules.slice(0, 3000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS (check diff for these patterns)');
    parts.push(ctx.reviewRules.slice(0, 2000));
    parts.push('');
  }

  if (ctx.checklist) {
    parts.push('## CRM CODE REVIEW CHECKLIST (verify applicable items)');
    parts.push(ctx.checklist.slice(0, 2000));
    parts.push('');
  }

  if (ctx.reviewPromptTemplate) {
    parts.push('## REVIEW PROMPT TEMPLATE');
    parts.push(ctx.reviewPromptTemplate.slice(0, 2000));
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
    parts.push(ctx.taskRules.slice(0, 2000));
    parts.push('');
  }

  if (ctx.reviewRules) {
    parts.push('## KNOWN PR REVIEW COMMENTS');
    parts.push(ctx.reviewRules.slice(0, 1500));
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
