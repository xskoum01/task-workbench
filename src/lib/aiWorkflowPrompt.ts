import type { Task } from '../types';
import { getDeveloperReadiness, type DeveloperReadiness } from './developerReadiness';

export type { DeveloperReadiness };

function buildScriptContextLines(task: Task): string[] | null {
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
  if (target?.eventName)       lines.push(`* Event: ${target.eventName}`);
  if (target?.eventFieldName)  lines.push(`* Event field (onChange): ${target.eventFieldName}`);
  if (target?.functionName)    lines.push(`* Function name: ${target.functionName}`);

  if (setup?.conventionsSource)       lines.push(`* Conventions reference: ${setup.conventionsSource}`);
  if (setup?.relatedExistingFiles?.length) {
    lines.push(`* Related files: ${setup.relatedExistingFiles.join(', ')}`);
  }

  if (setup?.scriptFormRegistration === 'manual-later') {
    lines.push('* Form/event registration: will be done manually (not part of this implementation)');
  }

  return lines;
}

export function buildAiWorkflowPrompt(task: Task): string {
  const currentStep = task.crmDeveloperWorkflow?.currentStep;
  const workKind    = task.crmDeveloperWorkflow?.detectedWorkKind;
  const mode        = task.taskMode;
  const customer    = task.customerId ?? task.workflowSetup?.customerId;

  const readiness = getDeveloperReadiness(task);

  const lines: string[] = [
    'You are working on a CRM development task managed by Task Workbench.',
    '',
    'Use Task Workbench MCP tools for task context and workflow updates.',
    'Start by loading the full current context for this task using the Task Workbench MCP tool `get_task_full_context`.',
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
  if (customer)    lines.push(`* Customer/environment: ${customer}`);

  const scriptContext = buildScriptContextLines(task);
  if (scriptContext) lines.push(...scriptContext);

  if (!readiness.isReady) {
    lines.push(
      '',
      'IMPORTANT: This task is NOT implementation-ready. Do not implement code before understanding and resolving all issues listed below.',
      '',
      'Do not perform external writes (Dataverse writes, plugin registration, web resource upload, GitHub/ADO actions) at this stage.',
      '',
      'The following issues must be resolved through Task Workbench before implementation can begin:',
    );
    for (const issue of readiness.blockers) {
      lines.push(`* ${issue}`);
    }
    if (readiness.warnings.length > 0) {
      lines.push('', 'Warnings (review after resolving blockers):');
      for (const w of readiness.warnings) lines.push(`* ${w}`);
    }
    lines.push(
      '',
      `Recommended next step: ${readiness.recommendedNextStep}`,
      '',
      'Setup rules:',
      '',
      `1. Load the full task context using \`get_task_full_context\` with id "${task.id}".`,
      '2. Do not create or modify any files until all readiness issues above are resolved.',
      '3. If work kind is missing, "unknown", or inconsistent with the task assignment — save work classification via `set_task_work_classification` and stop.',
      '4. If target artifact path is missing — do not guess a file name or directory. Save/update next step via `set_task_next_step` and stop.',
      '5. If technical plan is missing — create it via `save_technical_plan`. Do not begin coding.',
      '6. If Dataverse metadata verification is required but not completed — run `run_dataverse_check_for_task` (Primarch integration). Record all findings back into Task Workbench.',
      '7. If Task Workbench MCP becomes unavailable or any required MCP read/write fails — stop immediately. Do not continue outside Task Workbench workflow.',
      '8. After resolving all issues, update the next step in Task Workbench and ask the user to re-generate this prompt.',
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
