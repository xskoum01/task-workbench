import type { Task } from '../types';

export interface DeveloperReadiness {
  isReady: boolean;
  blockers: string[];
  warnings: string[];
  recommendedNextStep: string;
}

const VERIFIED_VERDICTS = new Set(['pass', 'warnings', 'fail']);

function isDataverseVerificationSatisfied(task: Task): boolean {
  const verdict = task.crmVerificationReports?.[0]?.verdict;
  if (verdict && VERIFIED_VERDICTS.has(verdict)) return true;
  const dvCheck = task.implementationVerification?.dataverseCheck;
  return !!(
    dvCheck?.skippedAt ||
    dvCheck?.manuallyVerifiedAt ||
    dvCheck?.status === 'skipped' ||
    dvCheck?.status === 'manually-verified'
  );
}

const JS_SCRIPT_PATTERN = /\b(javascript|form\s*script|web\s*resource|jscript|on.?load|on.?save|field.*change|column.*change|onchange|onload|onsave)\b/i;

function looksLikeJsScriptTask(task: Task): boolean {
  const text = [task.title ?? '', task.originalMessage ?? '', task.classificationLabel ?? ''].join(' ');
  return JS_SCRIPT_PATTERN.test(text);
}

function isSpecificFilePath(p: string | undefined): boolean {
  if (!p) return false;
  return /\.[jt]sx?$/.test(p);
}

function pickRecommendedNextStep(blockers: string[], warnings: string[]): string {
  if (blockers.length === 0) {
    return warnings.length > 0
      ? 'Review warnings, then proceed with code generation.'
      : 'Ready for code generation.';
  }
  const first = blockers[0];
  if (first.includes('Customer'))                      return 'Set customer/environment for this task.';
  if (first.includes('Repository root'))               return 'Set repository root via Developer Target Setup.';
  if (first.includes('setup has not been confirmed'))  return 'Complete and confirm the developer setup.';
  if (first.includes('Technical implementation plan')) return 'Generate a technical implementation plan.';
  if (first.includes('Dataverse metadata'))            return 'Run Dataverse metadata verification or mark it as not required.';
  if (first.includes('Plugin project'))                return 'Select the plugin project.';
  if (first.includes('Target entity'))                 return 'Specify the target entity logical name in the technical plan.';
  if (first.includes('Plugin registration'))           return 'Specify message, stage, and execution mode in the technical plan.';
  if (first.includes('Script creation requires'))      return 'Set target directory and file name for script creation in Developer Target Setup.';
  if (first.includes('Script update requires'))        return 'Set the existing script file path in Developer Target Setup.';
  if (first.includes('Target script'))                 return 'Set the target script path via Developer Target Setup.';
  if (first.includes('Form/event'))                    return 'Add form/event details to the technical plan, or mark form registration as manual-later.';
  return 'Resolve all blockers before proceeding with implementation.';
}

export function getDeveloperReadiness(task: Task): DeveloperReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Mode gate — must be developer
  if (task.taskMode !== 'developer') {
    return {
      isReady: false,
      blockers: ['Task mode is not set to Developer.'],
      warnings: [],
      recommendedNextStep: 'Set task mode to Developer.',
    };
  }

  // Work kind gate — must resolve to plugin or script
  const detectedWorkKind = task.crmDeveloperWorkflow?.detectedWorkKind;
  const devTargetKind    = task.workflowSetup?.devTargetKind;
  const isPlugin = devTargetKind === 'plugin' || detectedWorkKind === 'plugin';
  const isScript = devTargetKind === 'script' || detectedWorkKind === 'script' || detectedWorkKind === 'ribbon';

  if (!isPlugin && !isScript) {
    const looksScript = looksLikeJsScriptTask(task);
    return {
      isReady: false,
      blockers: ['Work kind must be plugin or script.'],
      warnings: looksScript
        ? ['Task text mentions JavaScript/form scripts. Consider classifying this task as script work kind.']
        : [],
      recommendedNextStep: looksScript
        ? 'Set work classification to script (JavaScript form script indicators found in task text).'
        : 'Set work classification to plugin or script via Set Work Classification.',
    };
  }

  // Common checks (order determines recommendedNextStep)
  const customer = task.customerId || task.workflowSetup?.customerId;
  if (!customer) blockers.push('Customer/environment is not set.');

  if (!task.workflowSetup?.repositoryRoot) blockers.push('Repository root is not set.');

  if (!task.workflowSetup?.confirmedAt) blockers.push('Developer setup has not been confirmed.');

  const plan = task.crmDeveloperWorkflow?.technicalPlan;
  if (!plan) blockers.push('Technical implementation plan is missing.');

  if (!isDataverseVerificationSatisfied(task)) {
    blockers.push('Dataverse metadata verification has not been completed or explicitly skipped.');
  } else {
    const verdict = task.crmVerificationReports?.[0]?.verdict;
    if (verdict === 'warnings') warnings.push('Dataverse verification completed with warnings. Review before implementing.');
    if (verdict === 'fail')     warnings.push('Dataverse verification found issues. Ensure they are accounted for in the technical plan.');
  }

  // Plugin-specific
  if (isPlugin) {
    const pluginProject =
      task.workflowSetup?.pluginProject ??
      (task as { selectedPluginProject?: string }).selectedPluginProject ??
      plan?.target?.pluginProject;
    if (!pluginProject) blockers.push('Plugin project is not selected.');

    const entityLogicalName =
      task.workflowSetup?.primaryEntityLogicalName ??
      plan?.target?.entityLogicalName;
    if (!entityLogicalName) blockers.push('Target entity logical name is not set.');

    if (plan) {
      const missing = (
        [
          !plan.target?.message ? 'message' : null,
          !plan.target?.stage   ? 'stage'   : null,
          !plan.target?.mode    ? 'mode'    : null,
        ] as (string | null)[]
      ).filter((v): v is string => v !== null);
      if (missing.length > 0) {
        blockers.push(`Plugin registration details are incomplete: ${missing.join(', ')} not specified in technical plan.`);
      }
    }
  }

  // Script-specific
  if (isScript) {
    const targetPath =
      task.workflowSetup?.artifactPath ??
      task.workflowSetup?.scriptPath ??
      plan?.target?.scriptPath;

    if (!targetPath) {
      blockers.push('Target script/artifact path is not set.');
    } else {
      const actionType = task.workflowSetup?.actionType;

      if (actionType === 'create-new-script') {
        const hasDir = !!(task.workflowSetup?.scriptPath || plan?.target?.scriptPath);
        const hasFileName =
          !!(task.workflowSetup?.artifactPath) ||
          isSpecificFilePath(task.workflowSetup?.scriptPath) ||
          isSpecificFilePath(plan?.target?.scriptPath) ||
          !!(task.workflowSetup?.desiredScriptFile);
        if (!hasDir || !hasFileName) {
          blockers.push('Script creation requires a known target directory and file name. Set script path and desired file name.');
        }
      } else if (actionType === 'update-existing-script') {
        const hasSpecificFile =
          !!(task.workflowSetup?.artifactPath) ||
          isSpecificFilePath(task.workflowSetup?.scriptPath) ||
          isSpecificFilePath(plan?.target?.scriptPath);
        if (!hasSpecificFile) {
          blockers.push('Script update requires a specific existing file path. Set script path to an existing .js file.');
        }
      }
    }

    const entityLogicalName =
      task.workflowSetup?.primaryEntityLogicalName ??
      plan?.target?.entityLogicalName;
    if (!entityLogicalName) blockers.push('Target entity logical name (table) is not set.');

    if (plan) {
      const hasFormEventInfo = !!(
        plan.target?.formName ||
        plan.target?.eventName ||
        plan.target?.eventFieldName ||
        plan.target?.functionName
      );
      const isManualLater = task.workflowSetup?.scriptFormRegistration === 'manual-later';
      if (!hasFormEventInfo && !isManualLater) {
        blockers.push('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
      }
    }
  }

  return {
    isReady: blockers.length === 0,
    blockers,
    warnings,
    recommendedNextStep: pickRecommendedNextStep(blockers, warnings),
  };
}
