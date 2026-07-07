import type { Task, Customer } from '../types';
import { getDeveloperReadiness, getCustomerDefaultRepoRoot, type DeveloperReadiness, type ReadinessBlocker } from './developerReadiness';

export type { DeveloperReadiness };

// ---------------------------------------------------------------------------
// This module generates a short workflow/task CONTRACT, not a coding-standards
// document. Stable CRM/JS/plugin coding rules and Power Platform AI Kit context
// live in the Claude Project Instructions — do not duplicate them here. This
// file only encodes: task identity, which MCP tool to call next, and the
// gates/loops that are specific to this task's current state.
// ---------------------------------------------------------------------------

function buildCustomerDevDefaultsLines(customer: Customer | undefined): string[] {
  if (!customer) return [];
  const repoRoot  = getCustomerDefaultRepoRoot(customer);
  const scriptDir = customer.scriptFolder;
  const pluginDir = customer.pluginFolder;

  if (!repoRoot && !scriptDir && !pluginDir) return [];

  const lines: string[] = ['', `Customer developer defaults (${customer.name ?? customer.id}):`];
  if (repoRoot)  lines.push(`* Repository root: ${repoRoot}`);
  if (scriptDir) lines.push(`* Script directory: ${scriptDir}`);
  if (pluginDir) lines.push(`* Plugin project path: ${pluginDir}`);
  return lines;
}

// Prompt-time template preview (used only to derive a short target-file preview
// for script tasks that have no persisted target yet).

interface PromptTemplate {
  id: string;
  titlePattern: string;
  workKind: 'script' | 'plugin';
  actionType?: 'create-new-script' | 'update-existing-script';
  scriptTarget?: {
    entityLogicalName: string;
    eventName?: string;
    eventFieldName?: string;
  };
  scriptNaming?: {
    scriptsFolderRelative: string;
    desiredScriptFile: string;
  };
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'nvr-training-sh-script-prefill',
    titlePattern: 'Script: Predvyplneni servisniho pozadavku',
    workKind: 'script',
    actionType: 'create-new-script',
    scriptTarget: {
      entityLogicalName: 'nvr_servicecase',
      eventName: 'onChange',
      eventFieldName: 'nvr_assetid',
    },
    scriptNaming: {
      scriptsFolderRelative: 'Scripts',
      desiredScriptFile: 'nvr_servicecase_events.js',
    },
  },
  {
    id: 'nvr-training-sh-plugin-service-order',
    titlePattern: 'Plugin: Vypocet castek',
    workKind: 'plugin',
  },
];

function matchPromptTemplate(title: string, originalMessage?: string): PromptTemplate | null {
  if (!title) return null;
  const haystack = (title + ' ' + (originalMessage ?? '')).toLowerCase();
  const exactMatch = PROMPT_TEMPLATES.find(t => haystack.includes(t.titlePattern.toLowerCase()));
  if (exactMatch) return exactMatch;

  if (
    haystack.includes('[test]') &&
    haystack.includes('script') &&
    haystack.includes('servis') &&
    (haystack.includes('pozadavku') || haystack.includes('poa') || haystack.includes('po')) &&
    (haystack.includes('zarizeni') || haystack.includes('zaa') || haystack.includes('za'))
  ) {
    return PROMPT_TEMPLATES.find(t => t.id === 'nvr-training-sh-script-prefill') ?? null;
  }

  return null;
}

function normalizeToSep(p: string, sep: '\\' | '/'): string {
  return sep === '\\' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/');
}

function isWindowsPath(p: string | undefined): boolean {
  if (!p) return false;
  return p.includes('\\') || /^[A-Za-z]:/.test(p);
}

interface TargetPreview {
  targetFile: string | null;
  targetFileIsSaved: boolean;
  entity: string | null;
  eventName: string | null;
  eventFieldName: string | null;
}

/** Derives a short, best-effort preview of the script target — never a write instruction. */
function deriveScriptTargetPreview(task: Task, customer?: Customer, templatePreview?: PromptTemplate | null): TargetPreview | null {
  const setup  = task.workflowSetup;
  const target = task.crmDeveloperWorkflow?.technicalPlan?.target;

  const entity = setup?.primaryEntityLogicalName
    ?? target?.entityLogicalName
    ?? templatePreview?.scriptTarget?.entityLogicalName
    ?? null;
  const eventName      = target?.eventName      ?? setup?.eventName      ?? templatePreview?.scriptTarget?.eventName      ?? null;
  const eventFieldName = target?.eventFieldName ?? setup?.eventFieldName ?? templatePreview?.scriptTarget?.eventFieldName ?? null;

  const savedTargetFile = setup?.artifactPath ?? setup?.scriptPath ?? target?.scriptPath ?? null;
  if (savedTargetFile) {
    return { targetFile: savedTargetFile, targetFileIsSaved: true, entity, eventName, eventFieldName };
  }

  // No saved target yet — derive a preview path when the entity and a naming
  // template/customer script folder are known. This is a preview only.
  if (!entity) return { targetFile: null, targetFileIsSaved: false, entity, eventName, eventFieldName };

  const desiredScriptFile = setup?.desiredScriptFile ?? templatePreview?.scriptNaming?.desiredScriptFile ?? `${entity}_events.js`;
  const rawRepoRoot = setup?.repositoryRoot ?? getCustomerDefaultRepoRoot(customer) ?? undefined;
  const sep: '\\' | '/' = (isWindowsPath(customer?.scriptFolder) || isWindowsPath(rawRepoRoot)) ? '\\' : '/';
  const scriptsFolderRelative = templatePreview?.scriptNaming?.scriptsFolderRelative ?? null;
  // Prefer an explicit customer scriptFolder; otherwise derive <repoRoot>/<templateRelativeFolder>
  // (covers the common case where only repositoryRoot/resolvedRepositoryPath is known); otherwise
  // fall back to the bare relative folder from the template.
  const scriptsFolderAbsolute = customer?.scriptFolder
    ? normalizeToSep(customer.scriptFolder, sep)
    : (rawRepoRoot && scriptsFolderRelative ? `${normalizeToSep(rawRepoRoot, sep)}${sep}${normalizeToSep(scriptsFolderRelative, sep)}` : null);
  const previewPath = scriptsFolderAbsolute
    ? `${scriptsFolderAbsolute}${sep}${desiredScriptFile}`
    : (scriptsFolderRelative ? `${normalizeToSep(scriptsFolderRelative, sep)}${sep}${desiredScriptFile}` : null);

  return { targetFile: previewPath, targetFileIsSaved: false, entity, eventName, eventFieldName };
}

const KNOWN_PREVIEW_DISCLAIMER = 'Known preview only; file writes require workPacket.canWriteCode === true.';

function buildTargetPreviewLines(task: Task, customer?: Customer, templatePreview?: PromptTemplate | null): string[] | null {
  const workKind      = task.crmDeveloperWorkflow?.detectedWorkKind ?? templatePreview?.workKind;
  const devTargetKind = task.workflowSetup?.devTargetKind ?? templatePreview?.workKind;
  const isScriptTask  = devTargetKind === 'script' || workKind === 'script' || workKind === 'ribbon';
  if (!isScriptTask) return null;

  const preview = deriveScriptTargetPreview(task, customer, templatePreview);
  if (!preview) return null;

  const lines: string[] = ['', KNOWN_PREVIEW_DISCLAIMER];
  if (preview.targetFile) {
    lines.push(preview.targetFileIsSaved
      ? `* Target file: ${preview.targetFile}`
      : `* Target file preview: ${preview.targetFile} (not yet saved to task setup)`);
  } else {
    lines.push('* Target file: not yet set — resolve via get_developer_work_packet, do not guess.');
  }
  if (preview.entity) lines.push(`* Entity: ${preview.entity}`);
  if (preview.eventName || preview.eventFieldName) {
    lines.push(`* Event / field: ${preview.eventName ?? '(unset)'} / ${preview.eventFieldName ?? '(unset)'}`);
  }
  return lines;
}

/**
 * Rewords a known "self-contained" readiness warning for the copied prompt only — the prompt must
 * point back to get_developer_work_packet as the source of truth rather than imply the warning
 * preview text itself is sufficient context. Leaves every other warning, and developerReadiness.ts's
 * own UI-facing text (shown directly in Task Workbench, not through this prompt), unchanged.
 */
function presentWarningForPrompt(warning: string): string {
  if (warning === 'Dataverse verification completed with warnings. Review before implementing.') {
    return 'Dataverse verification has warnings. Read the warning details from get_developer_work_packet before implementing.';
  }
  return warning;
}

function buildSetupBlockerSections(categorizedBlockers: ReadinessBlocker[]): string[] {
  const lines: string[] = [];

  const autoResolvable = categorizedBlockers.filter(b => b.category === 'auto-resolvable');
  const workflowActions = categorizedBlockers.filter(b => b.category === 'workflow-action');
  const proposals = categorizedBlockers.filter(b => b.category === 'proposal');
  const approvalGates = categorizedBlockers.filter(b => b.category === 'approval-gate');
  const hardBlockers = categorizedBlockers.filter(b => b.category === 'hard');

  if (autoResolvable.length > 0) {
    lines.push('', 'Auto-resolvable (call the MCP tool immediately and reload, do not stop):');
    for (const b of autoResolvable) {
      const tool = b.mcpTool ? ` -> call \`${b.mcpTool}\`` : '';
      lines.push(`* ${b.message}${tool}`);
    }
  }

  if (workflowActions.length > 0) {
    lines.push('', 'Read-only workflow actions (run the tool, record findings, reload, continue):');
    for (const b of workflowActions) {
      const tool = b.mcpTool ? ` -> call \`${b.mcpTool}\`` : '';
      lines.push(`* ${b.message}${tool}`);
    }
  }

  if (proposals.length > 0) {
    lines.push('', 'Proposal/draft actions (call the MCP tool immediately; user approval is required only before code file edits, not before saving task setup metadata):');
    for (const b of proposals) {
      const tool = b.mcpTool ? ` -> call \`${b.mcpTool}\`` : '';
      lines.push(`* ${b.message}${tool}`);
    }
  }

  if (approvalGates.length > 0) {
    lines.push('', 'Approval gates (stop and wait for user action):');
    for (const b of approvalGates) {
      lines.push(`* ${b.message}`);
    }
  }

  if (hardBlockers.length > 0) {
    lines.push('', 'Hard blockers (stop immediately and ask the user for the missing input):');
    for (const b of hardBlockers) {
      lines.push(`* ${b.message}`);
    }
  }

  return lines;
}

export function buildAiWorkflowPrompt(task: Task, customer?: Customer): string {
  const currentStep = task.crmDeveloperWorkflow?.currentStep;
  const workKind     = task.crmDeveloperWorkflow?.detectedWorkKind;
  const mode         = task.taskMode;
  const customerId   = task.customerId ?? task.workflowSetup?.customerId;

  const readiness = getDeveloperReadiness(task, customer);
  const templatePreview = matchPromptTemplate(task.title ?? '', task.originalMessage);

  const lines: string[] = [
    'You are working on a CRM development task managed by Task Workbench.',
    'Use the Claude Project Instructions and Power Platform AI Kit rules for coding style. This prompt is a workflow/task contract, not a coding-standards document.',
    '',
    'Task:',
    `* ID: ${task.id}`,
    `* Title: ${task.title}`,
    `* Status: ${task.status}`,
  ];
  if (currentStep && !readiness.isReady) lines.push(`* Phase: ${currentStep}`);
  if (mode)       lines.push(`* Mode: ${mode}`);
  if (workKind)   lines.push(`* Work classification: ${workKind}`);
  if (customerId) lines.push(`* Customer/environment: ${customerId}`);

  lines.push(
    '',
    'Required MCP environment:',
    '* This workflow requires the Task Workbench MCP tools to be connected in the current Claude session.',
    '* If `get_developer_work_packet` is not available at all, stop immediately and report: "Task Workbench MCP tools are not connected to this Claude session."',
    '* Do not inspect files or implement anything without the Task Workbench MCP tools.',
    '* Ask the user to connect/reload the Task Workbench MCP server for this Claude session.',
  );

  lines.push(
    '',
    `First MCP call: \`get_developer_work_packet\` with { "taskId": "${task.id}" }.`,
    'Use the returned work packet as the source of truth for whether code may be written, where to write, what to implement, conventions, verification, and review/test/commit guidance. Do not reason over internal workflow phase/currentStep/approval state unless get_developer_work_packet returns an error or missing context.',
    'Use this task ID for all Task Workbench MCP read/write calls. Do not ask the user for it again.',
    'After get_developer_work_packet succeeds, call `get_task_workbench_mcp_capabilities` before relying on automated verification or AI Kit review — this checks a different condition than the MCP-connection check above: whether the app/bridge is reachable and the toolset is current. If it reports bridgeMode="offline", a non-empty missingRequiredTools, canRunImplementationVerification=false, or canRecordAiKitReview=false, stop and report the exact missingRequiredTools/recommendedAction to the user.',
  );

  const customerDefaultsLines = buildCustomerDevDefaultsLines(customer);
  if (customerDefaultsLines.length) lines.push(...customerDefaultsLines);

  const targetPreviewLines = buildTargetPreviewLines(task, customer, templatePreview);
  if (targetPreviewLines) lines.push(...targetPreviewLines);

  if (!readiness.isReady) {
    lines.push(
      '',
      'This task is NOT implementation-ready. Do not implement code or modify files, and do not perform external writes (Dataverse, plugin registration, web resource upload, GitHub/ADO), until the blockers below are resolved.',
      '',
      'Resolve in this order:',
    );
    lines.push(...buildSetupBlockerSections(readiness.categorizedBlockers));

    if (readiness.warnings.length > 0) {
      lines.push('', 'Warnings (review after resolving blockers):');
      for (const w of readiness.warnings) lines.push(`* ${presentWarningForPrompt(w)}`);
    }

    lines.push(
      '',
      `Recommended next step: ${readiness.recommendedNextStep}`,
      '',
      'After resolving blockers, call `get_developer_work_packet` again with the same task ID.',
      '* If canWriteCode is false: do not implement or modify files. If blockingUserAction is about plan approval, call `approve_technical_plan_if_safe` first (see below); otherwise report decisionReason/blockingUserAction and stop unless the packet recommends `prepare_developer_task`.',
      '* Do not call get_task_full_context, get_implementation_readiness, or get_task_templates before get_developer_work_packet.',
      '* If Task Workbench MCP becomes unavailable or a required call fails after 3 retries, stop immediately.',
    );
    return lines.join('\n');
  }

  if (readiness.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of readiness.warnings) lines.push(`* ${presentWarningForPrompt(w)}`);
  }

  lines.push(
    '',
    'If workPacket.canWriteCode is false:',
    `* Do not create or modify files. If blockingUserAction is about plan approval, call \`approve_technical_plan_if_safe\` with { "taskId": "${task.id}" }: if canApprove=true, call get_developer_work_packet again and proceed with the refreshed packet; if canApprove=false, stop and report the reasons to the user.`,
    '* For all other blockers, report decisionReason/blockingUserAction and stop, unless the packet recommends `prepare_developer_task`.',
    '',
    'If workPacket.canWriteCode is true:',
    '* Implement only files in workPacket.writeTarget/targetFiles, using only workPacket.implementation.fieldMappings — do not add, infer, or substitute fields or paths. If requiresFieldMappings is true and fieldMappings is empty, stop and report missingRequiredMappings; do not write scaffold/TODO code as a substitute.',
    '* workPacket.implementation.validationFields are read-only source context — never write them to target fields.',
    '* No TODO/FIXME/placeholder/scaffold code in the final file. Replace it using packet data, or stop and report the blocker if the packet does not provide enough information.',
    '* Do not perform external writes (Dataverse, web resource upload, plugin registration, GitHub/ADO actions, deployments) without explicit user approval.',
  );

  lines.push(
    '',
    'After every file write:',
    '1. Re-read the file. Verify it against workPacket.implementation.fieldMappings, validationFields, businessRules, and acceptanceCriteria. Fix any violation before continuing.',
    '2. Call `record_ai_implementation_completed` (taskId, filesChanged, one-sentence summary). Do not call record_local_test for script/ribbon tasks.',
    '3. Call `continue_developer_workflow`.',
    '4. After any "tool not found" or "bridge is not running" error, call `get_task_workbench_mcp_capabilities` again if it is available. If it is not available at all, report that the Task Workbench MCP toolset itself is not connected — do not fall back to old manual-modal instructions and do not fabricate calling record_ai_kit_review_result. Retry only after the user confirms the app is running and the MCP server has been reloaded.',
    '5. If continue_developer_workflow returns nextAction=run_implementation_verification, call it.',
    '6. If continue_developer_workflow or run_implementation_verification returns nextAction=run_ai_kit_review (run_implementation_verification may also report status=pending_ai_kit_review): review the target file yourself against fieldMappings, validationFields, businessRules, acceptanceCriteria, Claude Project Instructions, and Power Platform AI Kit rules. Then call `record_ai_kit_review_result` with your verdict. Label it as an AI/Claude review, not an independent human review. Then call `run_implementation_verification` again.',
    '7. If run_implementation_verification or the AI Kit review result returns fixableFindings, fix the code and repeat from step 2.',
    '8. If run_implementation_verification or continue_developer_workflow returns status=tooling_error or nextAction=reload_mcp_or_start_app, stop. Report missingRequiredTools/recommendedAction and ask the user to start Task Workbench and reload the MCP server — this is a tooling problem, not a manual-review requirement.',
    '9. Stop only on nextAction=wait_for_user (manual web resource upload/form registration/browser Local Test), needs_configuration, tooling_error/reload_mcp_or_start_app, or any requiresUserApproval=true action (ask the user for explicit confirmation first).',
    '',
    'If Task Workbench MCP becomes unavailable or a required call fails after 3 retries, stop immediately.',
    '',
    'Final output: a compact summary only — files changed, verification status, and any remaining manual step. Do not repeat the work packet or restate these rules.',
  );

  return lines.join('\n');
}
