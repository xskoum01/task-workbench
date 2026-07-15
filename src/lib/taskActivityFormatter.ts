export interface FormattedTaskActivity {
  id: string;
  timestampLabel?: string;
  source?: string;
  message: string;
  raw: string;
}

const PRAGUE_TIME_FORMATTER = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TEXT = {
  testTaskCreated: 'Vytvo\u0159en testovac\u00ed \u00fakol.',
  dataverseRun: 'Spu\u0161t\u011bna kontrola v\u016f\u010di Dataverse.',
  resultWarning: 'varov\u00e1n\u00ed',
  resultFailed: 'chyba',
  resultPassed: 'bez chyb',
  pluginDraftCreated: 'Vytvo\u0159en plugin projekt a vygenerov\u00e1n draft.',
  scriptDraftGenerated: 'Vygenerov\u00e1n JavaScript draft.',
  developmentStarted: 'V\u00fdvoj byl zah\u00e1jen.',
  testingConfirmed: 'Konzultantsk\u00e9 testov\u00e1n\u00ed potvrzeno.',
  testingFailed: 'Konzultantsk\u00e9 testov\u00e1n\u00ed nepro\u0161lo.',
  testingConfirmedAndMovedToReview: 'Konzultantsk\u00e9 testov\u00e1n\u00ed potvrzeno a \u00fakol p\u0159esunut do Code Review / Waiting for PR.',
  movedToReview: '\u00dakol p\u0159esunut do Code Review / Waiting for PR.',
  movedBackToDevelopment: '\u00dakol vr\u00e1cen zp\u011bt do v\u00fdvoje.',
  gitBranchCreated: 'Vytvo\u0159ena Git v\u011btev.',
  gitCommitCreated: 'Vytvo\u0159en Git commit.',
  gitBranchPushed: 'Git v\u011btev byla pushnuta.',
  gitBranchPushedAndMovedToReview: 'Git v\u011btev byla pushnuta a \u00fakol p\u0159esunut do Code Review / Waiting for PR.',
  gitCommitAndPush: 'Vytvo\u0159en Git commit a v\u011btev byla pushnuta.',
  testingConfirmedCommitPushedMovedToReview: 'Zm\u011bny byly commitnuty a pushnuty; \u00fakol p\u0159esunut do Code Review / Waiting for PR.',
  aiKitImplementationGenerated: 'Naprogramov\u00e1no podle zad\u00e1n\u00ed pomoc\u00ed AI Kitu.',
  aiKitDiffReviewedPass: 'Diff zkontrolov\u00e1n podle AI Kitu: PASS.',
  aiKitDiffReviewedWarn: 'Diff zkontrolov\u00e1n podle AI Kitu: WARN.',
  aiKitDiffReviewedFail: 'Diff zkontrolov\u00e1n podle AI Kitu: FAIL.',
  aiKitReviewFixesApplied: 'P\u0159ipom\u00ednky z AI review byly opraveny pomoc\u00ed AI Kitu.',
  scriptFileCreated: 'Vytvo\u0159en pr\u00e1zdn\u00fd soubor skriptu.',
  dataverseMetadataCheckReset: 'Resetov\u00e1na kontrola Dataverse metadat.',
  aiCodeReviewReset: 'Resetov\u00e1na AI recenze k\u00f3du.',
  workflowResetToNew: '\u00dakol vr\u00e1cen do stavu NEW a pracovn\u00ed postup byl resetov\u00e1n.',
  manualDeploymentConfirmed: 'Manu\u00e1ln\u00ed nasazen\u00ed potvrzeno.',
  manualDeploymentFailed: 'Manu\u00e1ln\u00ed nasazen\u00ed selhalo.',
  manualDeploymentNotNeeded: 'Manu\u00e1ln\u00ed nasazen\u00ed ozna\u010deno jako nepot\u0159ebn\u00e9.',
  manualDeploymentReset: 'Resetov\u00e1n z\u00e1znam manu\u00e1ln\u00edho nasazen\u00ed.',
  deploymentTestPassed: 'Test nasazen\u00ed potvrzen jako \u00fasp\u011b\u0161n\u00fd.',
  deploymentTestFailed: 'Test nasazen\u00ed nepro\u0161el.',
  deploymentTestNotNeeded: 'Test nasazen\u00ed ozna\u010den jako nepot\u0159ebn\u00fd.',
  deploymentTestReset: 'Resetov\u00e1n z\u00e1znam testu nasazen\u00ed.',
};

/**
 * Appends a timestamped activity note line to a task's notes string.
 * Format: `[ISO-timestamp] body` \u2014 matched by formatTaskActivityNote/isTaskActivityLine below.
 * Canonical location for this helper \u2014 reuse it instead of re-deriving the same format elsewhere.
 */
export function appendActivityNote(existing: string | undefined, body: string): string {
  const line = `[${new Date().toISOString()}] ${body}`;
  return existing?.trim() ? `${existing.trim()}\n${line}` : line;
}

function formatTimestamp(rawTimestamp: string | undefined): string | undefined {
  if (!rawTimestamp) return undefined;
  const date = new Date(rawTimestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return PRAGUE_TIME_FORMATTER.format(date);
}

function formatDataverseResult(rawResult: string): string {
  const normalized = rawResult.trim().toLowerCase();
  if (normalized === 'warnings' || normalized === 'warning') return TEXT.resultWarning;
  if (normalized === 'failed' || normalized === 'fail') return TEXT.resultFailed;
  if (normalized === 'passed' || normalized === 'pass') return TEXT.resultPassed;
  return rawResult.trim();
}

export function formatTaskActivityNote(rawNote: string, index = 0): FormattedTaskActivity {
  const raw = rawNote.trim();
  const timestampMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(raw);
  const timestampLabel = formatTimestamp(timestampMatch?.[1]);
  const body = (timestampMatch?.[2] ?? raw).trim();

  if (/^MCP local write:\s*create_test_task$/i.test(body)) {
    return {
      id: `${index}-${raw}`,
      timestampLabel,
      source: 'MCP / Task Workbench',
      message: TEXT.testTaskCreated,
      raw,
    };
  }

  const dataverseMatch = /^MCP local write:\s*run_dataverse_check_for_task\s*->\s*(.+)$/i.exec(body);
  if (dataverseMatch) {
    return {
      id: `${index}-${raw}`,
      timestampLabel,
      source: 'MCP / Dataverse kontrola',
      message: `${TEXT.dataverseRun} V\u00fdsledek: ${formatDataverseResult(dataverseMatch[1])}.`,
      raw,
    };
  }

  if (body === 'Plugin project created and draft generated from Start Development workflow.') {
    return {
      id: `${index}-${raw}`,
      timestampLabel,
      source: 'Start Development',
      message: TEXT.pluginDraftCreated,
      raw,
    };
  }

  if (body === 'UI: script-draft-generated') {
    return {
      id: `${index}-${raw}`,
      timestampLabel,
      source: 'Script Draft',
      message: TEXT.scriptDraftGenerated,
      raw,
    };
  }

  if (body === 'Development started from Start Development modal.') {
    return {
      id: `${index}-${raw}`,
      timestampLabel,
      source: 'Start Development',
      message: TEXT.developmentStarted,
      raw,
    };
  }

  if (body === 'UI: consultant-testing-confirmed') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Testing', message: TEXT.testingConfirmed, raw };
  }
  if (body === 'UI: consultant-testing-failed') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Testing', message: TEXT.testingFailed, raw };
  }
  if (body === 'UI: consultant-testing-confirmed-and-moved-to-review') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Testing', message: TEXT.testingConfirmedAndMovedToReview, raw };
  }
  if (body === 'UI: moved-to-review') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Testing', message: TEXT.movedToReview, raw };
  }
  if (body === 'UI: moved-back-to-development') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Testing', message: TEXT.movedBackToDevelopment, raw };
  }
  if (body === 'UI: testing-confirmed-commit-pushed-moved-to-review') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git / Testing', message: TEXT.testingConfirmedCommitPushedMovedToReview, raw };
  }

  const gitBranchCreatedMatch = /^UI: git-branch-created -> (.+)$/i.exec(body);
  if (gitBranchCreatedMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git', message: `${TEXT.gitBranchCreated} (${gitBranchCreatedMatch[1]})`, raw };
  }
  const mcpGitBranchCreatedMatch = /^MCP local write: create_branch_for_task -> (.+)$/i.exec(body);
  if (mcpGitBranchCreatedMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'MCP / Git', message: `${TEXT.gitBranchCreated} (${mcpGitBranchCreatedMatch[1]})`, raw };
  }

  const gitCommitMatch = /^UI: git-commit-created -> (.+)$/i.exec(body);
  if (gitCommitMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git', message: `${TEXT.gitCommitCreated} (${gitCommitMatch[1]})`, raw };
  }
  const gitPushMatch = /^UI: git-branch-pushed -> (.+)$/i.exec(body);
  if (gitPushMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git', message: `${TEXT.gitBranchPushed} (${gitPushMatch[1]})`, raw };
  }
  const gitPushMovedToReviewMatch = /^UI: git-branch-pushed-and-moved-to-code-review -> (.+)$/i.exec(body);
  if (gitPushMovedToReviewMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git / Code Review', message: `${TEXT.gitBranchPushedAndMovedToReview} (${gitPushMovedToReviewMatch[1]})`, raw };
  }
  const gitCommitPushMatch = /^UI: git-commit-and-push -> (.+)$/i.exec(body);
  if (gitCommitPushMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Git', message: `${TEXT.gitCommitAndPush} (${gitCommitPushMatch[1]})`, raw };
  }
  const mcpGitCommitMatch = /^MCP local write: commit_task_changes -> (.+)$/i.exec(body);
  if (mcpGitCommitMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'MCP / Git', message: `${TEXT.gitCommitCreated} (${mcpGitCommitMatch[1]})`, raw };
  }
  const mcpGitPushMatch = /^MCP local write: push_task_branch -> (.+)$/i.exec(body);
  if (mcpGitPushMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'MCP / Git', message: `${TEXT.gitBranchPushed} (${mcpGitPushMatch[1]})`, raw };
  }
  const mcpGitBothMatch = /^MCP local write: commit_and_push_task_changes -> (.+)$/i.exec(body);
  if (mcpGitBothMatch) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'MCP / Git', message: `${TEXT.gitCommitAndPush} (${mcpGitBothMatch[1]})`, raw };
  }

  if (body === 'UI: script-file-created') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Script', message: TEXT.scriptFileCreated, raw };
  }
  if (body === 'UI: ai-kit-implementation-generated') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'AI Kit', message: TEXT.aiKitImplementationGenerated, raw };
  }
  const aiKitDiffReviewMatch = /^UI: ai-kit-diff-reviewed -> (PASS|WARN|FAIL)$/i.exec(body);
  if (aiKitDiffReviewMatch) {
    const verdict = aiKitDiffReviewMatch[1].toUpperCase();
    const msg = verdict === 'PASS' ? TEXT.aiKitDiffReviewedPass : verdict === 'WARN' ? TEXT.aiKitDiffReviewedWarn : TEXT.aiKitDiffReviewedFail;
    return { id: `${index}-${raw}`, timestampLabel, source: 'AI Kit', message: msg, raw };
  }
  if (body === 'UI: ai-kit-review-fixes-applied') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'AI Kit', message: TEXT.aiKitReviewFixesApplied, raw };
  }
  if (body === 'UI: dataverse-metadata-check-reset') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Verification', message: TEXT.dataverseMetadataCheckReset, raw };
  }
  if (body === 'UI: ai-code-review-reset') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Verification', message: TEXT.aiCodeReviewReset, raw };
  }
  if (body === 'Developer workflow reset to NEW by user.' || /^MCP local write: set_task_phase -> new \(workflow reset to NEW\)$/i.test(body)) {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Workflow', message: TEXT.workflowResetToNew, raw };
  }

  // Deployment & Testing — recorded either from the UI (one-click confirmation) or by Claude
  // through MCP record_manual_deployment/record_deployment_test after explicit user confirmation.
  const manualDeploymentMatch = /^(?:UI: manual-deployment-(deployed|failed|not-needed)|MCP local write: record_manual_deployment -> (deployed|failed|not-needed))$/i.exec(body);
  if (manualDeploymentMatch) {
    const status = (manualDeploymentMatch[1] ?? manualDeploymentMatch[2]).toLowerCase();
    const message = status === 'deployed' ? TEXT.manualDeploymentConfirmed
      : status === 'failed' ? TEXT.manualDeploymentFailed
      : TEXT.manualDeploymentNotNeeded;
    return { id: `${index}-${raw}`, timestampLabel, source: body.startsWith('MCP') ? 'MCP / Deployment' : 'Deployment', message, raw };
  }
  if (body === 'UI: manual-deployment-reset') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Deployment', message: TEXT.manualDeploymentReset, raw };
  }
  const deploymentTestMatch = /^(?:UI: deployment-test-(passed|failed|not-needed)|MCP local write: record_deployment_test -> (passed|failed|not-needed))$/i.exec(body);
  if (deploymentTestMatch) {
    const status = (deploymentTestMatch[1] ?? deploymentTestMatch[2]).toLowerCase();
    const message = status === 'passed' ? TEXT.deploymentTestPassed
      : status === 'failed' ? TEXT.deploymentTestFailed
      : TEXT.deploymentTestNotNeeded;
    return { id: `${index}-${raw}`, timestampLabel, source: body.startsWith('MCP') ? 'MCP / Deployment' : 'Deployment', message, raw };
  }
  if (body === 'UI: deployment-test-reset') {
    return { id: `${index}-${raw}`, timestampLabel, source: 'Deployment', message: TEXT.deploymentTestReset, raw };
  }

  return {
    id: `${index}-${raw}`,
    timestampLabel,
    message: body || raw,
    raw,
  };
}

export function isTaskActivityLine(line: string): boolean {
  const raw = line.trim();
  const timestampMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(raw);
  if (!timestampMatch) return false;

  const body = timestampMatch[2].trim();
  return (
    /^MCP local write:\s*create_test_task$/i.test(body) ||
    /^MCP local write:\s*run_dataverse_check_for_task\s*->\s*.+$/i.test(body) ||
    body === 'Plugin project created and draft generated from Start Development workflow.' ||
    body === 'Development started from Start Development modal.' ||
    body === 'UI: script-draft-generated' ||
    body === 'UI: consultant-testing-confirmed' ||
    body === 'UI: consultant-testing-failed' ||
    body === 'UI: consultant-testing-confirmed-and-moved-to-review' ||
    body === 'UI: moved-to-review' ||
    body === 'UI: moved-back-to-development' ||
    body === 'UI: testing-confirmed-commit-pushed-moved-to-review' ||
    /^UI: git-branch-created -> .+$/i.test(body) ||
    /^UI: git-commit-created -> .+$/i.test(body) ||
    /^UI: git-branch-pushed -> .+$/i.test(body) ||
    /^UI: git-branch-pushed-and-moved-to-code-review -> .+$/i.test(body) ||
    /^UI: git-commit-and-push -> .+$/i.test(body) ||
    /^MCP local write: create_branch_for_task -> .+$/i.test(body) ||
    /^MCP local write: commit_task_changes -> .+$/i.test(body) ||
    /^MCP local write: push_task_branch -> .+$/i.test(body) ||
    /^MCP local write: commit_and_push_task_changes -> .+$/i.test(body) ||
    body === 'UI: script-file-created' ||
    body === 'UI: ai-kit-implementation-generated' ||
    /^UI: ai-kit-diff-reviewed -> (PASS|WARN|FAIL)$/i.test(body) ||
    body === 'UI: ai-kit-review-fixes-applied' ||
    body === 'UI: dataverse-metadata-check-reset' ||
    body === 'UI: ai-code-review-reset' ||
    body === 'Developer workflow reset to NEW by user.' ||
    /^MCP local write: set_task_phase -> new \(workflow reset to NEW\)$/i.test(body) ||
    /^UI: manual-deployment-(deployed|failed|not-needed|reset)$/i.test(body) ||
    /^MCP local write: record_manual_deployment -> (deployed|failed|not-needed)$/i.test(body) ||
    /^UI: deployment-test-(passed|failed|not-needed|reset)$/i.test(body) ||
    /^MCP local write: record_deployment_test -> (passed|failed|not-needed)$/i.test(body)
  );
}

export function splitTaskNotes(notes: string | undefined): { manualNotes: string[]; activityLines: string[] } {
  const manualNotes: string[] = [];
  const activityLines: string[] = [];

  for (const line of (notes ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isTaskActivityLine(trimmed)) {
      activityLines.push(trimmed);
    } else {
      manualNotes.push(trimmed);
    }
  }

  return { manualNotes, activityLines };
}

export function formatTaskActivityNotes(notes: string | string[] | undefined): FormattedTaskActivity[] {
  const lines = Array.isArray(notes) ? notes : (notes ?? '').split(/\r?\n/);
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => formatTaskActivityNote(line, index));
}
