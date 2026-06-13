import type { Task, Customer } from '../types';

export type BlockerCategory =
  | 'auto-resolvable'  // AI calls an MCP tool immediately — value is explicit in the task
  | 'workflow-action'  // AI runs a read-only MCP tool (e.g. Dataverse check)
  | 'proposal'         // AI creates a draft/proposal via MCP tool, then stops for approval
  | 'approval-gate'    // Requires explicit user approval before AI continues
  | 'hard';            // True blocker: AI must stop and request missing input from user

export interface ReadinessBlocker {
  message: string;
  category: BlockerCategory;
  /** MCP tool to call for auto-resolvable and workflow-action blockers. */
  mcpTool?: string;
}

export interface DeveloperReadiness {
  isReady: boolean;
  /** Plain string list kept for backward compatibility. */
  blockers: string[];
  /** Structured list with categories. Use this in AI prompts. */
  categorizedBlockers: ReadinessBlocker[];
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

const JS_SCRIPT_PATTERN = /\b(javascript|form\s*script|web\s*resource|jscript|on.?load|on.?save|field.*change|column.*change|onchange|onload|onsave|script)\b/i;
const PLUGIN_PATTERN    = /\b(plugin|plug-in|c#|\.net)\b/i;

function looksLikeJsScriptTask(task: Task): boolean {
  const text = [task.title ?? '', task.originalMessage ?? '', task.classificationLabel ?? ''].join(' ');
  return JS_SCRIPT_PATTERN.test(text);
}

function looksLikePluginTask(task: Task): boolean {
  const text = [task.title ?? '', task.originalMessage ?? '', task.classificationLabel ?? ''].join(' ');
  return PLUGIN_PATTERN.test(text);
}

function isSpecificFilePath(p: string | undefined): boolean {
  if (!p) return false;
  return /\.[jt]sx?$/.test(p);
}

function pickRecommendedNextStep(blockers: ReadinessBlocker[], warnings: string[]): string {
  if (blockers.length === 0) {
    return warnings.length > 0
      ? 'Review warnings, then proceed with code generation.'
      : 'Ready for code generation.';
  }
  // Use the first hard blocker for the recommended step, or the first blocker overall
  const first = (blockers.find(b => b.category === 'hard') ?? blockers[0]).message;
  if (first.includes('Customer'))                      return 'Set customer/environment for this task.';
  if (first.includes('Repository root'))               return 'Set repository root via Developer Target Setup.';
  if (first.includes('setup has not been confirmed'))  return 'Complete and confirm the developer setup.';
  if (first.includes('Technical implementation plan')) return 'Generate a technical implementation plan draft with save_technical_plan.';
  if (first.includes('Dataverse metadata'))            return 'Run Dataverse metadata verification with run_dataverse_check_for_task.';
  if (first.includes('Plugin project'))                return 'Select the plugin project.';
  if (first.includes('Target entity'))                 return 'Specify the target entity logical name in the technical plan.';
  if (first.includes('Plugin registration'))           return 'Specify message, stage, and execution mode in the technical plan.';
  if (first.includes('Script creation requires'))      return 'Set target directory and file name for script creation in Developer Target Setup.';
  if (first.includes('Script update requires'))        return 'Set the existing script file path in Developer Target Setup.';
  if (first.includes('Target script'))                 return 'Set the target script path via Developer Target Setup.';
  if (first.includes('Form/event'))                    return 'Add form/event details to the technical plan, or mark form registration as manual-later.';
  return 'Resolve all blockers before proceeding with implementation.';
}

function addBlocker(
  blockers: ReadinessBlocker[],
  message: string,
  category: BlockerCategory,
  mcpTool?: string,
): void {
  blockers.push({ message, category, ...(mcpTool ? { mcpTool } : {}) });
}

/** Resolved default repository root from the customer (computed path wins over raw). */
export function getCustomerDefaultRepoRoot(customer: Customer | undefined): string | undefined {
  return customer?.resolvedRepositoryPath ?? customer?.repositoryRoot ?? undefined;
}

export function getDeveloperReadiness(task: Task, customer?: Customer): DeveloperReadiness {
  const categorizedBlockers: ReadinessBlocker[] = [];
  const warnings: string[] = [];

  // ── Mode gate ──────────────────────────────────────────────────────────────
  if (task.taskMode !== 'developer') {
    const message = 'Task mode is not set to Developer.';
    // Auto-resolvable when task text clearly indicates dev work
    const category: BlockerCategory = 'auto-resolvable';
    addBlocker(categorizedBlockers, message, category, 'set_task_mode');
    const blockers = categorizedBlockers.map(b => b.message);
    return {
      isReady: false,
      blockers,
      categorizedBlockers,
      warnings: [],
      recommendedNextStep: 'Set task mode to Developer.',
    };
  }

  // ── Work kind gate ─────────────────────────────────────────────────────────
  const detectedWorkKind = task.crmDeveloperWorkflow?.detectedWorkKind;
  const devTargetKind    = task.workflowSetup?.devTargetKind;
  const isPlugin = devTargetKind === 'plugin' || detectedWorkKind === 'plugin';
  const isScript = devTargetKind === 'script' || detectedWorkKind === 'script' || detectedWorkKind === 'ribbon';

  if (!isPlugin && !isScript) {
    const looksScript = looksLikeJsScriptTask(task);
    const looksPlugin = looksLikePluginTask(task);
    const isAutoResolvable = looksScript || looksPlugin;
    const message = 'Work kind must be plugin or script.';

    addBlocker(
      categorizedBlockers,
      message,
      isAutoResolvable ? 'auto-resolvable' : 'hard',
      isAutoResolvable ? 'set_task_work_classification' : undefined,
    );

    const blockers = categorizedBlockers.map(b => b.message);
    return {
      isReady: false,
      blockers,
      categorizedBlockers,
      warnings: looksScript
        ? ['Task text mentions JavaScript/form scripts. Consider classifying this task as script work kind.']
        : [],
      recommendedNextStep: looksScript
        ? 'Set work classification to script (JavaScript form script indicators found in task text).'
        : looksPlugin
          ? 'Set work classification to plugin (plugin indicators found in task text).'
          : 'Set work classification to plugin or script via Set Work Classification.',
    };
  }

  // ── Common checks ──────────────────────────────────────────────────────────
  const customerId = task.customerId || task.workflowSetup?.customerId;
  if (!customerId) {
    addBlocker(categorizedBlockers, 'Customer/environment is not set.', 'hard');
  }

  if (!task.workflowSetup?.repositoryRoot) {
    const customerRepoRoot = getCustomerDefaultRepoRoot(customer);
    if (customerRepoRoot) {
      addBlocker(
        categorizedBlockers,
        'Repository root is not set.',
        'auto-resolvable',
        'set_task_developer_target',
      );
    } else {
      addBlocker(categorizedBlockers, 'Repository root is not set.', 'hard');
    }
  }

  // Technical plan — proposal (AI creates a draft), not a hard blocker
  const plan = task.crmDeveloperWorkflow?.technicalPlan;
  if (!plan) {
    addBlocker(categorizedBlockers, 'Technical implementation plan is missing.', 'proposal', 'save_technical_plan');
  }

  // Dataverse verification — workflow-action (AI runs the check), not a hard blocker
  if (!isDataverseVerificationSatisfied(task)) {
    addBlocker(
      categorizedBlockers,
      'Dataverse metadata verification has not been completed or explicitly skipped.',
      'workflow-action',
      'run_dataverse_check_for_task',
    );
  } else {
    const verdict = task.crmVerificationReports?.[0]?.verdict;
    if (verdict === 'warnings') warnings.push('Dataverse verification completed with warnings. Review before implementing.');
    if (verdict === 'fail')     warnings.push('Dataverse verification found issues. Ensure they are accounted for in the technical plan.');
  }

  // Setup confirmation — approval-gate: only meaningful once other hard blockers are gone
  const hardBlockersBeforeConfirm = categorizedBlockers.filter(b => b.category === 'hard');
  if (!task.workflowSetup?.confirmedAt && hardBlockersBeforeConfirm.length === 0) {
    addBlocker(categorizedBlockers, 'Developer setup has not been confirmed.', 'approval-gate', 'confirm_task_setup');
  } else if (!task.workflowSetup?.confirmedAt) {
    // Still add as approval-gate so it shows in blockers string list for backward compat,
    // but defer — it comes after all hard blockers in practice
    addBlocker(categorizedBlockers, 'Developer setup has not been confirmed.', 'approval-gate', 'confirm_task_setup');
  }

  // ── Plugin-specific ────────────────────────────────────────────────────────
  if (isPlugin) {
    const pluginProject =
      task.workflowSetup?.pluginProject ??
      (task as { selectedPluginProject?: string }).selectedPluginProject ??
      plan?.target?.pluginProject;
    if (!pluginProject) {
      addBlocker(categorizedBlockers, 'Plugin project is not selected.', 'hard');
    }

    const entityLogicalName =
      task.workflowSetup?.primaryEntityLogicalName ??
      plan?.target?.entityLogicalName;
    if (!entityLogicalName) {
      addBlocker(categorizedBlockers, 'Target entity logical name is not set.', 'proposal', 'save_technical_plan');
    }

    if (plan) {
      const missing = (
        [
          !plan.target?.message ? 'message' : null,
          !plan.target?.stage   ? 'stage'   : null,
          !plan.target?.mode    ? 'mode'    : null,
        ] as (string | null)[]
      ).filter((v): v is string => v !== null);
      if (missing.length > 0) {
        addBlocker(
          categorizedBlockers,
          `Plugin registration details are incomplete: ${missing.join(', ')} not specified in technical plan.`,
          'proposal',
          'save_technical_plan',
        );
      }
    }
  }

  // ── Script-specific ────────────────────────────────────────────────────────
  if (isScript) {
    const targetPath =
      task.workflowSetup?.artifactPath ??
      task.workflowSetup?.scriptPath ??
      plan?.target?.scriptPath;

    const actionType = task.workflowSetup?.actionType;
    const repoRoot   = task.workflowSetup?.repositoryRoot;

    if (!targetPath) {
      if (actionType === 'update-existing-script') {
        // Hard blocker — must not guess an existing file
        addBlocker(categorizedBlockers, 'Target script/artifact path is not set.', 'hard');
      } else if (actionType === 'create-new-script') {
        // Proposal — can suggest path when repo root is known
        const category: BlockerCategory = repoRoot ? 'proposal' : 'hard';
        addBlocker(
          categorizedBlockers,
          'Target script/artifact path is not set.',
          category,
          category === 'proposal' ? 'set_task_developer_target' : undefined,
        );
      } else {
        addBlocker(categorizedBlockers, 'Target script/artifact path is not set.', 'hard');
      }
    } else {
      if (actionType === 'create-new-script') {
        const hasDir = !!(task.workflowSetup?.scriptPath || plan?.target?.scriptPath);
        const hasFileName =
          !!(task.workflowSetup?.artifactPath) ||
          isSpecificFilePath(task.workflowSetup?.scriptPath) ||
          isSpecificFilePath(plan?.target?.scriptPath) ||
          !!(task.workflowSetup?.desiredScriptFile);
        if (!hasDir || !hasFileName) {
          const category: BlockerCategory = repoRoot ? 'proposal' : 'hard';
          addBlocker(
            categorizedBlockers,
            'Script creation requires a known target directory and file name. Set script path and desired file name.',
            category,
            category === 'proposal' ? 'set_task_developer_target' : undefined,
          );
        }
      } else if (actionType === 'update-existing-script') {
        const hasSpecificFile =
          !!(task.workflowSetup?.artifactPath) ||
          isSpecificFilePath(task.workflowSetup?.scriptPath) ||
          isSpecificFilePath(plan?.target?.scriptPath);
        if (!hasSpecificFile) {
          addBlocker(
            categorizedBlockers,
            'Script update requires a specific existing file path. Set script path to an existing .js file.',
            'hard',
          );
        }
      }
    }

    const entityLogicalName =
      task.workflowSetup?.primaryEntityLogicalName ??
      plan?.target?.entityLogicalName;
    if (!entityLogicalName) {
      // Proposal — AI can add entity to plan when it's clear from assignment
      addBlocker(
        categorizedBlockers,
        'Target entity logical name (table) is not set.',
        'proposal',
        'save_technical_plan',
      );
    }

    if (plan) {
      const hasFormEventInfo = !!(
        plan.target?.formName ||
        plan.target?.eventName ||
        plan.target?.eventFieldName ||
        plan.target?.functionName ||
        task.workflowSetup?.eventName ||
        task.workflowSetup?.eventFieldName
      );
      const isManualLater = task.workflowSetup?.scriptFormRegistration === 'manual-later';
      if (!hasFormEventInfo && !isManualLater) {
        addBlocker(
          categorizedBlockers,
          'Form/event registration details are not set. Add form name, event name, or mark as manual registration later.',
          'proposal',
          'save_technical_plan',
        );
      }
    }
  }

  const blockers = categorizedBlockers.map(b => b.message);

  return {
    isReady: blockers.length === 0,
    blockers,
    categorizedBlockers,
    warnings,
    recommendedNextStep: pickRecommendedNextStep(categorizedBlockers, warnings),
  };
}
