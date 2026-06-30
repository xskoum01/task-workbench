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

// Prompt-time template preview

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
    titlePattern: 'Script: Predvyplneni servisniho pozadavku',
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

// Script naming contract

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
    lines.push('', 'Do not ask the user what to do with this target. Do not ask for the task ID. In normal setup, prepare_developer_task saves this metadata and returns the updated context.');
  }

  return lines;
}

// Script context section

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
    lines.push('* Target file: NOT SET - derive from entity name and naming convention below, then save through prepare_developer_task');
  } else {
    lines.push('* Target file: NOT SET - do not guess or create a file path');
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
        '* File name format: <entityLogicalName>_events.js (Scripts_Naming convention - do not add extra nvr_ prefix if entity already has it, e.g. nvr_servicecase -> nvr_servicecase_events.js)',
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
    lines.push('', 'Proposal/draft actions (call the MCP tool immediately; for convention-derived setup metadata such as script file name, persist and continue - user approval is required only before code file edits, not before saving task setup metadata):');
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
  const currentStep   = task.crmDeveloperWorkflow?.currentStep;
  const workKind      = task.crmDeveloperWorkflow?.detectedWorkKind;
  const mode          = task.taskMode;
  const customerId = task.customerId ?? task.workflowSetup?.customerId;

  const readiness = getDeveloperReadiness(task, customer);

  const lines: string[] = [
    'You are working on a CRM development task managed by Task Workbench.',
    '',
    'Use Task Workbench MCP tools for task context and workflow updates.',
    `First MCP call: \`get_developer_work_packet\` with taskId "${task.id}".`,
    'Use the returned work packet as the source of truth for whether code may be written, where to write, what to implement, conventions, verification, and review/test/commit guidance.',
    'Do not inspect internal workflow phase/currentStep/approval state unless get_developer_work_packet returns an error or missing context.',
    '',
    `Task ID: ${task.id}`,
    '',
    `Task title: ${task.title}`,
    '',
    'Current known task metadata:',
    `* Status: ${task.status}`,
  ];

  if (currentStep && !readiness.isReady) lines.push(`* Phase: ${currentStep}`);
  if (mode)        lines.push(`* Mode: ${mode}`);
  if (workKind)    lines.push(`* Work classification: ${workKind}`);
  if (customerId)  lines.push(`* Customer/environment: ${customerId}`);

  lines.push(
    '',
    'Current task identity and MCP writes:',
    `* The current task ID is the Task ID shown in this prompt.`,
    '* Use this ID for all Task Workbench MCP read/write calls.',
    '* Do not ask the user for the task ID again unless the prompt does not contain one and get_task_full_context cannot be loaded.',
    '* For AI work, prefer get_developer_work_packet. It hides Task Workbench internal workflow state and returns a clear canWriteCode decision plus working instructions.',
    '* Use prepare_developer_task only when the work packet explicitly says setup is incomplete and recommends preparing the developer task.',
    '* Do not use low-level setup tools unless a high-level tool reports a specific corrective action that cannot be handled otherwise.',
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
      'Work packet flow:',
      `Call \`get_developer_work_packet\` once with { "taskId": "${task.id}" }. Use the returned canWriteCode decision as the source of truth.`,
      '',
      'If canWriteCode is false:',
      '* do not implement code or modify files',
      `* if blockingUserAction is about technical plan approval: call approve_technical_plan_if_safe with { "taskId": "${task.id}" } first`,
      '*   if canApprove=true and planRefreshed=true: the stale scaffold plan was automatically refreshed from trusted field mappings and approved — call get_developer_work_packet again and proceed',
      '*   if canApprove=true and planRefreshed=false: plan approved normally — call get_developer_work_packet again and proceed',
      '*   if canApprove=false: stop and report canApprove=false reasons to the user',
      '* summarize decisionReason and blockingUserAction from the packet',
      '* call prepare_developer_task only if recommendedNextAction says setup should be prepared/refreshed',
      '* otherwise stop and wait for the required Task Workbench/user action',
      '',
      'Setup rules:',
      '',
      '1. First call get_developer_work_packet. Do not call get_task_full_context, get_implementation_readiness, or get_task_templates before it.',
      '2. If canWriteCode is false, do not reason over internal gates; report the packet decision and stop unless the packet recommends prepare_developer_task.',
      '3. If canWriteCode is true, implement only the work described by writeTarget, implementation, conventions, and reviewTestCommit.',
      '4. Use get_task_full_context only as fallback when get_developer_work_packet returns an error or missing context.',
      '5. If Task Workbench MCP becomes unavailable or any required MCP read/write fails after 3 retries - stop immediately.',
    );
    return lines.join('\n');

  }

  if (readiness.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of readiness.warnings) lines.push(`* ${w}`);
  }

  lines.push(
    '',
    'Use the returned developer work packet as the only source of truth for implementation.',
    'Known target preview only, not write authorization: task metadata and script context above show known values but file writes require workPacket.canWriteCode === true.',
    '',
    'Implementation rules:',
    '',
    `1. If workPacket.canWriteCode is false: (a) if blockingUserAction mentions plan approval, call approve_technical_plan_if_safe with { "taskId": "${task.id}" } — if canApprove=true (whether planRefreshed=true or false) call get_developer_work_packet again and proceed with the refreshed packet; if canApprove=false stop and report the reasons to the user; (b) for all other blockers stop and report decisionReason and blockingUserAction. Do not create or modify files. Note: approve_technical_plan_if_safe will internally refresh stale scaffold plan steps/risks when the work packet already contains trusted field mappings — no manual plan regeneration is needed in that case.`,
    '2. If workPacket.canWriteCode is true, implement only files listed in workPacket.writeTarget / targetFiles.',
    '3. Do not guess paths, entities, fields, mappings, handlers, or web resource names outside the work packet.',
    '4. Inspect only conventions and similar files recommended by the work packet before writing code.',
    '5. If Task Workbench MCP becomes unavailable or any required MCP read/write fails - stop immediately. Do not continue implementation outside Task Workbench workflow.',
    ...(workKind === 'script' || workKind === 'ribbon' || task.workflowSetup?.devTargetKind === 'script'
      ? ['6. Dataverse metadata verification for JS/TS is not available through MCP. Use the in-app Verify Implementation modal after implementation/upload for script files.']
      : ['6. If Dataverse metadata verification is required but not completed - run run_dataverse_check_for_task (Primarch integration) first. If verification cannot be recorded in Task Workbench, stop.']),
    '7. Do not perform external writes: Dataverse writes, web resource upload, plugin registration, GitHub/ADO actions, deployments.',
    '8. Record local test results, build results, consultant testing, PR review findings and next step back into Task Workbench using the packet guidance.',
    '9. At the end, summarize what was changed and what should happen next.',
    '10. Implement only exact field mappings returned in workPacket.implementation.fieldMappings. Do not add, infer, or substitute fields. Unmapped source fields are context only and must not be written to target fields. If workPacket.implementation.requiresFieldMappings is true and fieldMappings is empty, stop immediately — report workPacket.implementation.missingRequiredMappings to the user; do not write scaffold or TODO code as a substitute.',
    '11. Fields listed in workPacket.implementation.validationFields are read-only source context for conditional logic — never write them to target entity fields.',
    '12. Follow AI Kit mandatory rules from workPacket.aiKit before writing code. After implementation, run or request AI Kit review, or record it as the required next step.',
    '13. If the target file contains TODO comments, FIXME comments, placeholder handlers, or scaffold code, do not accept it as complete. Decide based on what the packet provides: (a) if workPacket.implementation.fieldMappings and the business rules in this packet provide enough information to replace the TODO/scaffold safely, fix the file by replacing every TODO with real implementation — do not leave any TODO in output; (b) if the packet does not provide enough information to replace a TODO (e.g. requiresFieldMappings is true but fieldMappings is empty), stop immediately and report the blocker to the user. Do not call continue_developer_workflow or record_local_test while any TODO, FIXME, or placeholder comment remains in implementation code.',
    '14. Before writing changes or accepting an existing target file as complete, inspect it. Existing code containing TODO comments, placeholder/stub handlers, or fields outside workPacket.implementation.fieldMappings is not acceptable as complete. Inspect and follow workPacket.aiKit.rulesFiles when provided; if empty, follow workPacket.aiKit.mandatoryRulesSummary.',
  );

  lines.push(
    '',
    'Post-implementation workflow (call after every file write):',
    '',
    '1. Call `continue_developer_workflow` with the task ID. Do not stop after creating files.',
    '2. Follow the returned nextAction and instructionForAI until the tool returns wait_for_user or mark_done.',
    '3. For any requiresUserApproval=true action (branch create, push, Dataverse write), ask the user for explicit confirmation first.',
    '4. If workPacket.implementation.fieldMappings is empty when mappings are expected, stop. Do not write TODO or scaffold code as a substitute for missing mappings.',
    '5. TODO comments in final implementation output are never acceptable. Do not call continue_developer_workflow or record_local_test until every TODO, FIXME, and placeholder comment has been replaced with actual implementation. If the packet provides enough information to replace a TODO, do so. If not, report the blocker.',
  );

  return lines.join('\n');
}
