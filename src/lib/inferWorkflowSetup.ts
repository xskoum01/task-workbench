/**
 * Central inference for WorkflowSetup defaults.
 *
 * Called when the Confirm Task Setup modal opens. All values are best-effort
 * guesses — they are shown pre-filled but the user can override every field
 * before confirming. Existing confirmed values always win over new guesses.
 */
import type { Task, Customer, WorkflowSetup, AiReviewerConfig } from '../types';
import type { DevTarget } from './resolveTaskDevTarget';
import { hintedPluginProject } from './resolveTaskDevTarget';
import { mergeWithDefaults } from './aiReviewers';

// ---------------------------------------------------------------------------
// Work intent inference
// ---------------------------------------------------------------------------

const FIX_PATTERNS    = /\b(fix|bug|error|broken|crash|issue|nefunguje|chyba|opravit|neopravuje)\b/i;
const REVIEW_PATTERNS = /\b(review|code review|zkontroluj|kontrola|přezkoumej)\b/i;
const CREATE_PATTERNS = /\b(create|new|scaffold|generate|založ|vytvoř|nový|nová|nové|vytvořit|vytvořte)\b/i;
const UPDATE_PATTERNS = /\b(update|change|modify|extend|adjust|uprav|změň|doplň|přidej|rozšiř)\b/i;

function inferWorkIntent(task: Task): NonNullable<WorkflowSetup['workIntent']> {
  if (task.workflowSetup?.workIntent) return task.workflowSetup.workIntent;

  const corpus = [
    task.title,
    task.originalMessage ?? '',
    task.analysisResult?.summaryEn ?? '',
    task.analysisResult?.summaryCz ?? '',
    task.classificationLabel ?? '',
  ].join(' ');

  // Priority: fix > review > create > update
  if (FIX_PATTERNS.test(corpus))    return 'fix';
  if (REVIEW_PATTERNS.test(corpus)) return 'review';
  if (CREATE_PATTERNS.test(corpus)) return 'create';
  if (UPDATE_PATTERNS.test(corpus)) return 'update';
  return 'update';
}

// ---------------------------------------------------------------------------
// Plugin project inference
// ---------------------------------------------------------------------------

function inferPluginProject(task: Task): string {
  if (task.workflowSetup?.pluginProject) return task.workflowSetup.pluginProject;
  if (task.selectedPluginProject)        return task.selectedPluginProject;
  const hinted = hintedPluginProject(task);
  if (hinted)                            return hinted;
  return '';
}

// ---------------------------------------------------------------------------
// Script path inference
// ---------------------------------------------------------------------------

function inferScriptPath(
  task: Task,
  customer: Customer | undefined,
  scriptFolder: string | undefined,
): string {
  if (task.workflowSetup?.scriptPath) return task.workflowSetup.scriptPath;
  if (scriptFolder)                   return scriptFolder;
  const root = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
  if (root)                           return `${root}/Scripts`;
  return '';
}

// ---------------------------------------------------------------------------
// Reviewer inference
// ---------------------------------------------------------------------------

function inferReviewerId(
  task: Task,
  devKind: 'plugin' | 'script' | 'repo',
  reviewerConfigs: AiReviewerConfig[] | undefined,
): string {
  if (task.workflowSetup?.reviewerId) return task.workflowSetup.reviewerId;
  if (!reviewerConfigs) return '';

  const enabled = mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled);
  if (devKind === 'repo') return '';

  const match = enabled.find(
    (r) =>
      r.appliesTo.devTargetKinds &&
      r.appliesTo.devTargetKinds.includes(devKind as 'plugin' | 'script'),
  );
  return match?.id ?? '';
}

// ---------------------------------------------------------------------------
// Inference hint labels
// ---------------------------------------------------------------------------

/** Returns a short hint string describing where the value came from. */
export interface SetupInferenceHints {
  workIntent?: string;
  devTargetKind?: string;
  pluginProject?: string;
  scriptPath?: string;
  reviewerId?: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface InferWorkflowSetupInput {
  task: Task;
  customer: Customer | undefined;
  customers: Customer[];
  devTarget: DevTarget;
  pluginsDir: string | undefined;
  scriptFolder: string | undefined;
  reviewerConfigs?: AiReviewerConfig[];
}

export interface InferWorkflowSetupResult {
  defaults: Required<Omit<WorkflowSetup, 'confirmedAt' | 'repositoryRoot'>> & {
    customerId: string;
  };
  hints: SetupInferenceHints;
}

export function inferWorkflowSetupDefaults({
  task,
  customer,
  devTarget,
  scriptFolder,
  reviewerConfigs,
}: InferWorkflowSetupInput): InferWorkflowSetupResult {
  const devKind = task.workflowSetup?.devTargetKind ?? devTarget.kind;

  const workIntent    = inferWorkIntent(task);
  const pluginProject = inferPluginProject(task);
  const scriptPath    = inferScriptPath(task, customer, scriptFolder);
  const reviewerId    = inferReviewerId(task, devKind, reviewerConfigs);
  const customerId    = task.workflowSetup?.customerId ?? task.customerId ?? '';

  // Build hint labels for the UI
  const hints: SetupInferenceHints = {};
  const corpus = [task.title, task.originalMessage ?? ''].join(' ');

  if (!task.workflowSetup?.workIntent) {
    if (FIX_PATTERNS.test(corpus) || REVIEW_PATTERNS.test(corpus) || CREATE_PATTERNS.test(corpus) || UPDATE_PATTERNS.test(corpus)) {
      hints.workIntent = 'Suggested from task text';
    }
  }

  if (!task.workflowSetup?.devTargetKind) {
    hints.devTargetKind = 'Inferred from task';
  }

  if (!task.workflowSetup?.pluginProject && !task.selectedPluginProject && hintedPluginProject(task)) {
    hints.pluginProject = 'Suggested from ADO context';
  } else if (!task.workflowSetup?.pluginProject && task.selectedPluginProject) {
    hints.pluginProject = 'From previously selected project';
  }

  if (!task.workflowSetup?.scriptPath && scriptFolder) {
    hints.scriptPath = 'From customer settings';
  } else if (!task.workflowSetup?.scriptPath && !scriptFolder && customer?.repositoryRoot) {
    hints.scriptPath = 'Derived from repository root';
  }

  if (!task.workflowSetup?.reviewerId && reviewerId) {
    hints.reviewerId = 'Matched by target kind';
  }

  return {
    defaults: {
      workIntent,
      devTargetKind: devKind,
      customerId,
      pluginProject,
      scriptPath,
      reviewerId,
    },
    hints,
  };
}
