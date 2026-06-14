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

// ── Prompt-time template preview ────────────────────────────────────────────

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
    namingSource: string;
    scriptsFolderRelative: string;
    desiredScriptFile: string;
    onLoadFunctionName: string;
    onChangeFunctionName?: string;
    mainHelperSuggestion?: string;
  };
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'nvr-training-sh-script-prefill',
    titlePattern: 'Script: Předvyplnění servisního požadavku',
    workKind: 'script',
    actionType: 'create-new-script',
    scriptTarget: {
      entityLogicalName: 'nvr_servicecase',
      eventName: 'onChange',
      eventFieldName: 'nvr_assetid',
    },
    scriptNaming: {
      namingSource: 'Scripts_Naming',
      scriptsFolderRelative: 'Scripts',
      desiredScriptFile: 'nvr_servicecase_events.js',
      onLoadFunctionName: 'nvr_servicecase_OnLoad',
      onChangeFunctionName: 'nvr_assetid_OnChange',
      mainHelperSuggestion: 'prefillServiceCaseFromAsset',
    },
  },
  {
    id: 'nvr-training-sh-plugin-service-order',
    titlePattern: 'Plugin: Výpočet částek',
    workKind: 'plugin',
  },
];

function matchPromptTemplate(title: string, originalMessage?: string): PromptTemplate | null {
  if (!title) return null;
  const haystack = (title + ' ' + (originalMessage ?? '')).toLowerCase();
  return PROMPT_TEMPLATES.find(t => haystack.includes(t.titlePattern.toLowerCase())) ?? null;
}

// ── Script naming contract ────────────────────────────────────────────────────

interface ScriptNamingContract {
  namingSource: string;
  scriptsFolderAbsolute: string | null;
  scriptsFolderRelative: string | null;
  entityLogicalName: string;
  desiredScriptFile: string;
  scriptPath: string | null;
  absoluteScriptPath: string | null;
  repositoryRoot: string | null;
  actionType: string | null;
  eventName: string | null;
  eventFieldName: string | null;
  onLoadFunctionName: string;
  onChangeFunctionName: string | null;
  helperNamingRule: string;
  mainHelperSuggestion: string | null;
}

function deriveRelativeFolder(absoluteFolder: string, repositoryRoot?: string): string | null {
  if (repositoryRoot) {
    const normRepo = repositoryRoot.replace(/[/\\]+$/, '');
    if (absoluteFolder.toLowerCase().startsWith(normRepo.toLowerCase())) {
      const rel = absoluteFolder.slice(normRepo.length).replace(/^[/\\]+/, '');
      if (rel) return rel;
    }
  }
  return absoluteFolder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null;
}

function normalizeToSep(p: string, sep: '\\' | '/'): string {
  return sep === '\\' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/');
}

function isWindowsPath(p: string | undefined): boolean {
  if (!p) return false;
  return p.includes('\\') || /^[A-Za-z]:/.test(p);
}

function computeScriptNamingContract(
  task: Task,
  customer?: Customer,
  templatePreview?: PromptTemplate | null,
): ScriptNamingContract | null {
  const setup      = task.workflowSetup;
  const planTarget = task.crmDeveloperWorkflow?.technicalPlan?.target;

  const entityName = setup?.primaryEntityLogicalName
    ?? planTarget?.entityLogicalName
    ?? templatePreview?.scriptTarget?.entityLogicalName;
  if (!entityName) return null;

  const eventFieldName = setup?.eventFieldName
    ?? planTarget?.eventFieldName
    ?? templatePreview?.scriptTarget?.eventFieldName;

  const rawRepoRoot = setup?.repositoryRoot ?? getCustomerDefaultRepoRoot(customer) ?? undefined;
  const sep: '\\' | '/' = (isWindowsPath(customer?.scriptFolder) || isWindowsPath(rawRepoRoot)) ? '\\' : '/';

  const normCustomerScriptFolder = customer?.scriptFolder ? normalizeToSep(customer.scriptFolder, sep) : null;
  const normRepoRoot             = rawRepoRoot ? normalizeToSep(rawRepoRoot, sep) : undefined;

  const scriptsFolderRelativeFromTemplate = templatePreview?.scriptNaming?.scriptsFolderRelative ?? null;

  const scriptsFolderAbsolute: string | null = normCustomerScriptFolder
    ?? (normRepoRoot && scriptsFolderRelativeFromTemplate
      ? `${normRepoRoot}${sep}${scriptsFolderRelativeFromTemplate}`
      : null);

  const scriptsFolderRelative: string | null = scriptsFolderAbsolute
    ? deriveRelativeFolder(scriptsFolderAbsolute, normRepoRoot)
    : scriptsFolderRelativeFromTemplate;

  const desiredScriptFile = setup?.desiredScriptFile
    ?? templatePreview?.scriptNaming?.desiredScriptFile
    ?? `${entityName}_events.js`;
  const scriptPath         = scriptsFolderRelative ? `${scriptsFolderRelative}${sep}${desiredScriptFile}` : null;
  const absoluteScriptPath = scriptsFolderAbsolute ? `${scriptsFolderAbsolute}${sep}${desiredScriptFile}` : null;

  const onLoadFunctionName = setup?.onLoadFunctionName
    ?? templatePreview?.scriptNaming?.onLoadFunctionName
    ?? `${entityName}_OnLoad`;
  const onChangeFunctionName = setup?.onChangeFunctionName
    ?? templatePreview?.scriptNaming?.onChangeFunctionName
    ?? (eventFieldName ? `${eventFieldName}_OnChange` : null);

  return {
    namingSource:         setup?.namingSource ?? templatePreview?.scriptNaming?.namingSource ?? 'Scripts_Naming',
    scriptsFolderAbsolute,
    scriptsFolderRelative,
    entityLogicalName:    entityName,
    desiredScriptFile,
    scriptPath,
    absoluteScriptPath,
    repositoryRoot:       normRepoRoot ?? null,
    actionType:           setup?.actionType ?? templatePreview?.actionType ?? null,
    eventName:            planTarget?.eventName ?? setup?.eventName ?? templatePreview?.scriptTarget?.eventName ?? null,
    eventFieldName:       eventFieldName ?? null,
    onLoadFunctionName,
    onChangeFunctionName,
    helperNamingRule:     'descriptive camelCase, no nvr_ prefix by default',
    mainHelperSuggestion: setup?.mainHelperSuggestion
      ?? templatePreview?.scriptNaming?.mainHelperSuggestion
      ?? null,
  };
}

function buildScriptNamingContractLines(contract: ScriptNamingContract, pendingSetup: boolean): string[] {
  const lines: string[] = [
    '',
    `CRM script naming contract (${contract.namingSource}):`,
    `* Naming source: ${contract.namingSource}`,
  ];
  if (contract.repositoryRoot)         lines.push(`* Repository root: ${contract.repositoryRoot}`);
  if (contract.scriptsFolderAbsolute)  lines.push(`* Scripts folder: ${contract.scriptsFolderAbsolute}`);
  if (contract.scriptsFolderRelative)  lines.push(`* Relative target directory: ${contract.scriptsFolderRelative}`);
  lines.push(`* Entity logical name: ${contract.entityLogicalName}`);
  lines.push(`* Derived file name: ${contract.desiredScriptFile}`);
  if (contract.scriptPath)        lines.push(`* Derived relative target file: ${contract.scriptPath}`);
  if (contract.absoluteScriptPath) lines.push(`* Derived absolute target file: ${contract.absoluteScriptPath}`);
  lines.push(`* OnLoad handler: ${contract.onLoadFunctionName}`);
  if (contract.onChangeFunctionName) lines.push(`* OnChange handler: ${contract.onChangeFunctionName}`);
  lines.push(`* Helper functions: ${contract.helperNamingRule}`);
  if (contract.mainHelperSuggestion) lines.push(`* Main helper suggestion: ${contract.mainHelperSuggestion}`);

  if (pendingSetup) {
    lines.push('', 'Save this derived target via set_task_developer_target with:');
    if (contract.repositoryRoot)        lines.push(`* repositoryRoot: ${contract.repositoryRoot}`);
    if (contract.scriptsFolderRelative) lines.push(`* selectedScriptTarget: ${contract.scriptsFolderRelative}`);
    lines.push(`* desiredScriptFile: ${contract.desiredScriptFile}`);
    if (contract.scriptPath)            lines.push(`* artifactPath: ${contract.scriptPath}`);
    if (contract.absoluteScriptPath)    lines.push(`* absoluteScriptPath: ${contract.absoluteScriptPath}`);
    if (contract.actionType)            lines.push(`* actionType: ${contract.actionType}`);
    lines.push(`* primaryEntityLogicalName: ${contract.entityLogicalName}`);
    if (contract.eventName)             lines.push(`* eventName: ${contract.eventName}`);
    if (contract.eventFieldName)        lines.push(`* eventFieldName: ${contract.eventFieldName}`);
    lines.push(`* namingSource: ${contract.namingSource}`);
    lines.push(`* onLoadFunctionName: ${contract.onLoadFunctionName}`);
    if (contract.onChangeFunctionName)  lines.push(`* onChangeFunctionName: ${contract.onChangeFunctionName}`);
    if (contract.mainHelperSuggestion)  lines.push(`* mainHelperSuggestion: ${contract.mainHelperSuggestion}`);
    lines.push('', 'Do not ask the user what to do with this target. Do not ask for the task ID. Reload get_task_full_context after saving.');
  }

  return lines;
}

// ── Script context section ────────────────────────────────────────────────────

function buildScriptContextLines(
  task: Task,
  customer?: Customer,
  templatePreview?: PromptTemplate | null,
): string[] | null {
  const workKind      = task.crmDeveloperWorkflow?.detectedWorkKind ?? templatePreview?.workKind;
  const devTargetKind = task.workflowSetup?.devTargetKind ?? templatePreview?.workKind;
  const isScriptTask  = devTargetKind === 'script' || workKind === 'script' || workKind === 'ribbon';
  if (!isScriptTask) return null;

  const setup  = task.workflowSetup;
  const target = task.crmDeveloperWorkflow?.technicalPlan?.target;

  const lines: string[] = ['', 'Script target context:'];

  const actionType = setup?.actionType ?? templatePreview?.actionType;
  if (actionType) lines.push(`* Action type: ${actionType}`);

  const targetFile  = setup?.artifactPath ?? setup?.scriptPath ?? target?.scriptPath;
  const isCreateNew = actionType === 'create-new-script';

  // Compute preview contract early so we can show a concrete path even before it is persisted
  const previewContract    = (isCreateNew && !targetFile)
    ? computeScriptNamingContract(task, customer, templatePreview)
    : null;
  const derivedPreviewPath = previewContract?.scriptPath ?? null;

  if (targetFile) {
    lines.push(`* Target file: ${targetFile}`);
  } else if (isCreateNew && derivedPreviewPath) {
    lines.push(`* Target file preview: ${derivedPreviewPath}`);
    lines.push(`* Persistence state: not yet saved to task setup`);
    lines.push(`* Required action: save this target via set_task_developer_target`);
  } else if (isCreateNew) {
    lines.push('* Target file: NOT SET — derive from entity name and naming convention below, then save via set_task_developer_target');
  } else {
    lines.push('* Target file: NOT SET — do not guess or create a file path');
  }

  if (isCreateNew && setup?.desiredScriptFile) {
    lines.push(`* Desired file name: ${setup.desiredScriptFile}`);
  }

  const entity = setup?.primaryEntityLogicalName ?? target?.entityLogicalName ?? templatePreview?.scriptTarget?.entityLogicalName;
  if (entity) lines.push(`* Table (logical name): ${entity}`);

  if (target?.webResourceName) lines.push(`* Web resource name: ${target.webResourceName}`);
  if (target?.formName)        lines.push(`* Form name: ${target.formName}`);

  const eventName      = target?.eventName      ?? setup?.eventName      ?? templatePreview?.scriptTarget?.eventName;
  const eventFieldName = target?.eventFieldName ?? setup?.eventFieldName ?? templatePreview?.scriptTarget?.eventFieldName;
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

  // For create-new-script tasks without a resolved target: show the concrete naming contract
  // when the entity name is known (from task, plan, or template preview); fall back to generic conventions otherwise.
  if (isCreateNew && !targetFile) {
    const contract = previewContract; // already computed above to avoid double work
    if (contract) {
      lines.push(...buildScriptNamingContractLines(contract, true));
    } else {
      lines.push(
        '',
        'CRM JS script naming conventions:',
        '* File name format: <entityLogicalName>_events.js (Scripts_Naming convention — do not add extra nvr_ prefix if entity already has it, e.g. nvr_servicecase → nvr_servicecase_events.js)',
        '* OnLoad handler: <entityLogicalName>_OnLoad',
        '* OnChange handler: <fieldLogicalName>_OnChange',
        '* Helper functions: descriptive camelCase without namespace prefixes',
        '* Script directory: customer scriptFolder (see Customer developer defaults) or Scripts/',
        '* Do not invent web resource subfolder paths not present in customer defaults.',
        '* Do not set file names or web resource names to placeholder or undetermined values.',
      );
    }
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
    lines.push('', 'Proposal/draft actions (call the MCP tool immediately; for convention-derived setup metadata such as script file name, persist and continue — user approval is required only before code file edits, not before saving task setup metadata):');
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
    ...(!readiness.isReady
      ? [
          `First MCP call: \`prepare_developer_task\` with taskId "${task.id}".`,
          'Use its returned task/readiness context directly. Do not reload get_task_full_context unless prepare_developer_task returns an error or missing context.',
          'Stop at the approval gate or hard blocker returned by prepare_developer_task. Do not ask for fields that the returned template/default setup already resolved.',
        ]
      : [
          'Start by loading the full current context for this task using the Task Workbench MCP tool `get_task_full_context`.',
        ]),
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

  lines.push(
    '',
    'Current task identity and MCP writes:',
    `* The current task ID is the Task ID shown in this prompt.`,
    '* Use this ID for all Task Workbench MCP read/write calls.',
    '* Do not ask the user for the task ID again unless the prompt does not contain one and get_task_full_context cannot be loaded.',
    '* For setup/readiness, prefer prepare_developer_task. It applies templates, customer defaults, target derivation, technical plan drafting, setup confirmation, and returns updated context in one call.',
    '* Use low-level setup tools only if prepare_developer_task reports a hard blocker that needs a specific corrective write.',
  );

  const templatePreview = matchPromptTemplate(task.title ?? '', task.originalMessage);

  const customerDefaultsLines = buildCustomerDevDefaultsLines(customer);
  if (customerDefaultsLines.length) lines.push(...customerDefaultsLines);

  const scriptContext = buildScriptContextLines(task, customer, templatePreview);
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
      'Setup orchestration:',
      `Call \`prepare_developer_task\` once with { "taskId": "${task.id}", "mode": "setup-until-approval-gate" }. Use the returned context/readiness as the source of truth.`,
      '',
      'prepare_developer_task is allowed to perform only safe local setup writes:',
      '* apply matched templates and customer developer defaults',
      '* set Developer mode, work classification, target entity/event/script naming metadata',
      '* save a deterministic task analysis and technical plan draft',
      '* confirm setup only when no hard blockers remain',
      '* return approvalGates/hardBlockers/missingInputs without requiring a follow-up reload',
      '',
      'Setup rules:',
      '',
      '1. First call prepare_developer_task. Do not call get_task_full_context or get_task_templates before it.',
      '2. If status is stopped_at_approval_gate, summarize the approval gate and stop before file edits.',
      '3. If status is blocked, ask only for missingInputs/hardBlockers returned by the tool.',
      '4. If status is ready_for_implementation, continue only if implementationReadiness.isImplementationReady is true and the workflow phase allows code changes.',
      '5. If Task Workbench MCP becomes unavailable or any required MCP read/write fails after 3 retries, stop immediately.',
    );
    return lines.join('\n');

    lines.push(
      '',
      `Recommended next step: ${readiness.recommendedNextStep}`,
      '',
      'Setup orchestration (up to 8 safe Task Workbench-only actions):',
      'When a complete developer target can be derived from customer defaults, task template, and naming convention, save it immediately via set_task_developer_target, reload get_task_full_context, and continue.',
      '',
      'Allowed auto-setup actions (no user input needed when the value is explicit):',
      '* setting task mode to Developer when the task is clearly a development task',
      '* setting work classification to script/plugin when explicit from the task text',
      ...(customerDefaultsLines.length
        ? ['* applying customer/environment developer defaults (repositoryRoot, scriptFolder, pluginFolder) via set_task_developer_target when listed in the Customer developer defaults section above']
        : []),
      '* for create-new-script tasks: when entity name is known from template, task text, or customer defaults, derive the script directory and file name using Scripts_Naming (<fullEntityLogicalName>_events.js — do not double the nvr_ prefix if entity already has it, e.g. nvr_servicecase → nvr_servicecase_events.js; do not strip the prefix; do not use dot-notation namespace patterns for helper functions), then call set_task_developer_target with repositoryRoot, selectedScriptTarget, desiredScriptFile, artifactPath, absoluteScriptPath, actionType, primaryEntityLogicalName, eventName, eventFieldName, namingSource, onLoadFunctionName, onChangeFunctionName, mainHelperSuggestion — do not stop or ask the user before saving this metadata',
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
      `2. Call \`get_task_templates\` with taskId "${task.id}". If matchedTemplate is returned, apply its workKind, actionType, targetEntity, and scriptTarget/pluginTarget values via \`set_task_work_classification\` (for workKind/actionType) and \`set_task_developer_target\` (for targetEntity/scriptTarget/pluginTarget) BEFORE treating those fields as missing blockers. Reload \`get_task_full_context\` after applying template values.`,
      '3. If repository root is not set but \`customerDevDefaults.repositoryRoot\` is present in the \`get_task_full_context\` response — call \`set_task_developer_target\` with that value immediately, reload \`get_task_full_context\`, and continue. Do NOT ask the user for repository root when a customer default is available.',
      '4. Do not create or modify any files until the task is implementation-ready and the workflow phase allows it.',
      '5. If work kind is missing, "unknown", or inconsistent with the task assignment — save it via `set_task_work_classification`, reload `get_task_full_context`, and continue.',
      '6. If target artifact path is missing for update-existing-script — do not guess a file name or directory. Update next step via `set_task_next_step` and stop until the user provides the correct path.',
      '7. If target artifact path is missing for create-new-script and entity name is known — derive the script directory and file name using Scripts_Naming convention: file = <entityLogicalName>_events.js (do not add another nvr_ prefix if the entity already has it — e.g. nvr_servicecase → nvr_servicecase_events.js, not nvr_nvr_servicecase_events.js), then call `set_task_developer_target` with repositoryRoot, selectedScriptTarget (directory, e.g. from customer scriptFolder or Scripts/), desiredScriptFile, artifactPath (full relative path e.g. Scripts\\nvr_servicecase_events.js), absoluteScriptPath, actionType, primaryEntityLogicalName, eventName, eventFieldName, namingSource, onLoadFunctionName, onChangeFunctionName, mainHelperSuggestion in a single call. Do not save placeholder or undetermined values. Reload `get_task_full_context` and continue. If repo root is also missing, stop and ask only for that.',
      '8. If technical plan is missing — create a draft via `save_technical_plan` when enough context exists. Mark it ready for approval via `mark_technical_plan_ready_for_approval`. Stop at the approval gate before any file edits.',
      '9. If Dataverse metadata verification is required but not completed — run `run_dataverse_check_for_task` (Primarch integration). Record all findings locally. Reload `get_task_full_context` and continue. Stop only if the check itself fails or findings contradict the assignment.',
      '10. If target entity logical name is missing and explicit from the assignment or template — save via `set_task_developer_target` and continue. The technical plan may also document the target entity, but `set_task_developer_target` is the source of truth for developer target metadata.',
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
