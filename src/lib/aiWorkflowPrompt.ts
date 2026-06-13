import type { Task, Customer } from '../types';
import { getDeveloperReadiness, getCustomerDefaultRepoRoot, type DeveloperReadiness, type ReadinessBlocker } from './developerReadiness';

export type { DeveloperReadiness };

function buildCustomerDevDefaultsLines(customer: Customer | undefined): string[] {
  if (!customer) return [];
  const repoRoot     = getCustomerDefaultRepoRoot(customer);
  const scriptDir    = customer.scriptFolder;
  const pluginDir    = customer.pluginFolder;
  const jsSrc        = customer.jsConventionsSource;
  const pluginSrc    = customer.pluginConventionsSource;

  const hasAny = repoRoot || scriptDir || pluginDir || jsSrc || pluginSrc;
  if (!hasAny) return [];

  const lines: string[] = ['', `Customer developer defaults (${customer.name ?? customer.id}):`];
  if (repoRoot)  lines.push(`* Default repository root: ${repoRoot}`);
  if (scriptDir) lines.push(`* Default script directory: ${scriptDir}`);
  if (pluginDir) lines.push(`* Default plugin project path: ${pluginDir}`);
  if (jsSrc)     lines.push(`* JS conventions reference: ${jsSrc}`);
  if (pluginSrc) lines.push(`* Plugin conventions reference: ${pluginSrc}`);
  return lines;
}

function buildScriptContextLines(task: Task, customer?: Customer): string[] | null {
  const workKind      = task.crmDeveloperWorkflow?.detectedWorkKind;
  const devTargetKind = task.workflowSetup?.devTargetKind;
  const isScriptTask  = devTargetKind === 'script' || workKind === 'script' || workKind === 'ribbon';
  if (!isScriptTask) return null;

  const setup  = task.workflowSetup;
  const target = task.crmDeveloperWorkflow?.technicalPlan?.target;

  const lines: string[] = ['', 'Script target context:'];

  if (setup?.actionType) lines.push(`* Action type: ${setup.actionType}`);

  const targetFile = setup?.artifactPath ?? setup?.scriptPath ?? target?.scriptPath;
  if (targetFile)  lines.push(`* Target file: ${targetFile}`);
  else             lines.push('* Target file: NOT SET — do not guess or create a file path');

  if (setup?.actionType === 'create-new-script' && setup.desiredScriptFile) {
    lines.push(`* Desired file name: ${setup.desiredScriptFile}`);
  }

  const entity = setup?.primaryEntityLogicalName ?? target?.entityLogicalName;
  if (entity) lines.push(`* Table (logical name): ${entity}`);

  if (target?.webResourceName) lines.push(`* Web resource name: ${target.webResourceName}`);
  if (target?.formName)        lines.push(`* Form name: ${target.formName}`);

  const eventName      = target?.eventName      ?? setup?.eventName;
  const eventFieldName = target?.eventFieldName ?? setup?.eventFieldName;
  if (eventName)       lines.push(`* Event: ${eventName}`);
  if (eventFieldName)  lines.push(`* Event field (onChange): ${eventFieldName}`);

  if (target?.functionName)    lines.push(`* Function name: ${target.functionName}`);

  const conventionsSource = setup?.conventionsSource ?? customer?.jsConventionsSource;
  if (conventionsSource) lines.push(`* Conventions reference: ${conventionsSource}`);
  if (setup?.relatedExistingFiles?.length) {
    lines.push(`* Related files: ${setup.relatedExistingFiles.join(', ')}`);
  }

  if (setup?.scriptFormRegistration === 'manual-later') {
    lines.push('* Form/event registration: will be done manually (not part of this implementation)');
  }

  return lines;
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
      const tool = b.mcpTool ? ` → call \`${b.mcpTool}\`` : '';
      lines.push(`* ${b.message}${tool}`);
    }
  }

  if (workflowActions.length > 0) {
    lines.push('', 'Read-only workflow actions (run the tool, record findings, reload, continue):');
    for (const b of workflowActions) {
      const tool = b.mcpTool ? ` → call \`${b.mcpTool}\`` : '';
      lines.push(`* ${b.message}${tool}`);
    }
  }

  if (proposals.length > 0) {
    lines.push('', 'Proposal/draft actions (create draft via MCP tool, then pause for approval before file edits):');
    for (const b of proposals) {
      const tool = b.mcpTool ? ` → call \`${b.mcpTool}\`` : '';
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
  const currentStep   = task.crmDeveloperWorkflow?.currentStep;
  const workKind      = task.crmDeveloperWorkflow?.detectedWorkKind;
  const mode          = task.taskMode;
  const customerId = task.customerId ?? task.workflowSetup?.customerId;

  const readiness = getDeveloperReadiness(task, customer);

  const lines: string[] = [
    'You are working on a CRM development task managed by Task Workbench.',
    '',
    'Use Task Workbench MCP tools for task context and workflow updates.',
    'Start by loading the full current context for this task using the Task Workbench MCP tool `get_task_full_context`.',
    `Then immediately call \`get_task_templates\` with taskId "${task.id}" to check for a matching built-in template.`,
    'If a matchedTemplate is returned, apply its values (workKind, actionType, targetEntity, scriptTarget, pluginTarget) via the appropriate MCP tools BEFORE evaluating which metadata fields are missing.',
    '',
    `Task ID: ${task.id}`,
    '',
    `Task title: ${task.title}`,
    '',
    'Current known task metadata:',
    `* Status: ${task.status}`,
  ];

  if (currentStep) lines.push(`* Phase: ${currentStep}`);
  if (mode)        lines.push(`* Mode: ${mode}`);
  if (workKind)    lines.push(`* Work classification: ${workKind}`);
  if (customerId)  lines.push(`* Customer/environment: ${customerId}`);

  const customerDefaultsLines = buildCustomerDevDefaultsLines(customer);
  if (customerDefaultsLines.length) lines.push(...customerDefaultsLines);

  const scriptContext = buildScriptContextLines(task, customer);
  if (scriptContext) lines.push(...scriptContext);

  if (!readiness.isReady) {
    lines.push(
      '',
      'IMPORTANT: This task is NOT implementation-ready. Do not implement code or modify files until all blockers below are resolved.',
      '',
      'Do not perform external writes (Dataverse writes, plugin registration, web resource upload, GitHub/ADO actions) during this setup/readiness run. External writes are allowed only later through explicit approved workflow actions.',
      '',
      'The following issues must be addressed before implementation can begin:',
    );

    lines.push(...buildSetupBlockerSections(readiness.categorizedBlockers));

    if (readiness.warnings.length > 0) {
      lines.push('', 'Warnings (review after resolving blockers):');
      for (const w of readiness.warnings) lines.push(`* ${w}`);
    }

    lines.push(
      '',
      `Recommended next step: ${readiness.recommendedNextStep}`,
      '',
      'Auto-setup orchestration loop:',
      'Perform up to 8 safe Task Workbench-only setup actions in sequence. After each action, reload `get_task_full_context` and re-evaluate readiness. Continue until you reach an approval gate, a hard blocker, or all issues are resolved. Stop only on hard blockers, approval gates, MCP failure, file writes, external writes, or if the same blocker repeats twice.',
      '',
      'Safe auto-setup loop:',
      'When a readiness issue can be resolved by updating Task Workbench metadata only, and the correct value is explicit from the task title, original message, or current setup — resolve it immediately using the appropriate Task Workbench MCP write tool. After each update, reload the task with `get_task_full_context` and continue evaluating readiness. You may perform up to 8 safe Task Workbench-only setup updates in this run. Stop if the same blocker repeats twice.',
      '',
      'Safe Task Workbench-only updates (no user input needed when the value is explicit):',
      '* setting task mode to Developer when the task is clearly a development task',
      '* setting work classification to script/plugin when explicit from the task text',
      ...(customerDefaultsLines.length
        ? ['* applying customer/environment developer defaults (repositoryRoot, scriptFolder, pluginFolder) via set_task_developer_target when listed in the Customer developer defaults section above']
        : []),
      '* updating next step',
      '* saving analysis or summary when it does not require guessing',
      '* saving a technical plan draft when enough context exists — do not begin implementation before plan approval',
      '',
      'Retry behavior for transient failures:',
      'Retry required MCP read calls up to 3 times before treating a failure as a hard stop. Do not continue outside Task Workbench.',
      '',
      'Setup rules:',
      '',
      `1. Load the full task context using \`get_task_full_context\` with id "${task.id}". The response includes a \`customerDevDefaults\` section when the customer has configured developer defaults.`,
      `2. Call \`get_task_templates\` with taskId "${task.id}". If matchedTemplate is returned, apply its workKind, actionType, targetEntity, and scriptTarget/pluginTarget values via \`set_task_work_classification\`, \`set_task_developer_target\`, or \`save_technical_plan\` BEFORE treating those fields as missing blockers. Reload \`get_task_full_context\` after applying template values.`,
      '3. If repository root is not set but \`customerDevDefaults.repositoryRoot\` is present in the \`get_task_full_context\` response — call \`set_task_developer_target\` with that value immediately, reload \`get_task_full_context\`, and continue. Do NOT ask the user for repository root when a customer default is available.',
      '4. Do not create or modify any files until the task is implementation-ready and the workflow phase allows it.',
      '5. If work kind is missing, "unknown", or inconsistent with the task assignment — save it via `set_task_work_classification`, reload `get_task_full_context`, and continue.',
      '6. If target artifact path is missing for update-existing-script — do not guess a file name or directory. Update next step via `set_task_next_step` and stop until the user provides the correct path.',
      '7. If target artifact path is missing for create-new-script and repo root is known — propose a path based on conventions, save via `set_task_developer_target`, and continue. If repo root is also missing, stop and ask only for that.',
      '8. If technical plan is missing — create a draft via `save_technical_plan` when enough context exists. Mark it ready for approval via `mark_technical_plan_ready_for_approval`. Stop at the approval gate before any file edits.',
      '9. If Dataverse metadata verification is required but not completed — run `run_dataverse_check_for_task` (Primarch integration). Record all findings locally. Reload `get_task_full_context` and continue. Stop only if the check itself fails or findings contradict the assignment.',
      '10. If target entity logical name is missing and explicit from the assignment or template — save via `save_technical_plan` or `set_task_developer_target` and continue.',
      '11. Confirm setup via `confirm_task_setup` only after all hard blockers and proposal blockers are resolved and no hard setup issues remain.',
      '12. If Task Workbench MCP becomes unavailable or any required MCP read/write fails after 3 retries — stop immediately. Do not continue outside Task Workbench workflow.',
      '13. Only ask the user to regenerate this prompt if MCP context cannot be reloaded or the workflow cannot be refreshed through Task Workbench MCP after exhausting safe auto-setup updates.',
    );
    return lines.join('\n');
  }

  if (readiness.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of readiness.warnings) lines.push(`* ${w}`);
  }

  lines.push(
    '',
    'Implementation rules:',
    '',
    `1. Load the full task context using \`get_task_full_context\` with id "${task.id}".`,
    '2. Do not create or modify files unless all of these are confirmed from Task Workbench: work kind, repository root, target artifact path, customer/environment, technical plan, and implementation readiness state.',
    '3. If Task Workbench MCP becomes unavailable or any required MCP read/write fails — stop immediately. Do not continue implementation outside Task Workbench workflow.',
    '4. If work kind is missing, "unknown", or inconsistent with the task assignment — do not implement. Save/update next step via `set_task_next_step` and stop.',
    '5. If target artifact path is missing or unclear — do not create a new file by guessing a path or name. For script tasks use only the target file shown in Script target context above. Save/update next step via `set_task_next_step` and stop.',
    '6. If technical plan is missing or cannot be saved through Task Workbench MCP — do not implement. Stop.',
    '7. If Dataverse metadata verification is required but not completed — run `run_dataverse_check_for_task` (Primarch integration) first. If verification cannot be recorded in Task Workbench, stop.',
    '8. For JavaScript/form script tasks — inspect existing repository conventions and similar scripts before writing code. Use conventionsSource and related files listed in Script target context if provided.',
    '9. For plugin tasks — inspect existing plugin conventions and similar plugin classes before writing code.',
    '10. Do not perform external writes (Dataverse writes, plugin registration, web resource upload, GitHub/ADO actions, deployments) unless explicitly approved by the user.',
    '11. Record local test results, build results, consultant testing, PR review findings and next step back into Task Workbench.',
    '12. At the end, summarize what was done and what should happen next.',
  );

  return lines.join('\n');
}
