import { describe, it, expect } from 'vitest';
import {
  RESETTABLE_WORKFLOW_KEYS,
  taskHasResettableWorkflowState,
  buildTaskWorkflowResetPatch,
  resetTaskWorkflowToNew,
  DEFAULT_WORKFLOW_RESET_AUDIT_NOTE,
} from './taskWorkflowReset';
import { isTaskActivityLine, formatTaskActivityNote } from './taskActivityFormatter';
import { getDeveloperReadiness } from './developerReadiness';
import { buildAiWorkflowPrompt } from './aiWorkflowPrompt';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Test task',
    source: 'manual',
    customerId: 'cust-1',
    taskType: 'feature',
    status: 'in-progress',
    confidence: 80,
    originalMessage: 'Original request text.',
    receivedAt: '2026-06-01T00:00:00.000Z',
    suggestedActions: [{ id: 'a1', label: 'Do something' }],
    ...overrides,
  } as unknown as Task;
}

/** A task that has been through the full developer workflow — analyzed, developed, verified,
 *  tested, reviewed, and marked done — used to exercise "reset a fully-worked task" scenarios. */
function makeFullyWorkedTask(): Task {
  return makeTask({
    status: 'done',
    waitingState: null,
    attentionState: null,
    completedAt: '2026-06-10T00:00:00.000Z',
    estimatedEffort: 4,
    planningBucket: 'today',
    suggestedPlanningBucket: 'this_week',
    priorityScore: 72,
    priorityReason: 'Due soon.',
    isPlanningLocked: true,
    analysisResult: { summary: 'Summary.', suggestedActions: [], confidence: 90 },
    generatedReply: 'Draft reply text.',
    scriptAnalysis: {
      artifactType: 'script', entityLogicalName: 'nvr_case', triggerType: 'onChange',
      operationType: 'new_onchange_handler', candidateFunctionName: 'onChangeHandler',
      shouldReuseExistingHandler: false, shouldCreateNewHandler: true, shouldCreateHelper: false,
      confidence: 80, summary: 'Analysis summary.',
    },
    selectedPluginProject: 'MyPlugins',
    aiFileReviews: [{ reviewerName: 'AI Kit', filePath: 'Scripts/foo.js' }],
    crmSkeletons: [{ mode: 'script', summary: 's', pseudoCode: 'p', logicalNamesUsed: [], metadataInspected: { entityLogicalNames: [], attributeLogicalNames: {}, toolsUsed: [] } }],
    crmVerificationReports: [{ verdict: 'pass', metadataVerdict: 'pass', runtimeReadiness: 'low_risk', summary: 's', issues: [], confirmedReferences: [], missingReferences: [], ambiguousReferences: [], runtimeRisks: [], pluginChecks: [], inspectedEntities: [], inspectedAttributesByEntity: {}, unableToVerifyReasons: [], metadataInspected: { entityLogicalNames: [], attributeLogicalNames: {}, toolsUsed: [] } }],
    crmDeveloperWorkflow: { detectedWorkKind: 'script', currentStep: 'pull-request', planApproval: { approved: true } },
    workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
    taskMode: 'developer',
    implementationVerification: { aiCodeReview: { status: 'passed', reviewedFiles: ['a.js'], rulesFiles: ['r.md'], checklistFiles: ['c.md'], knownPrReviewFiles: ['p.md'] } },
    deploymentTesting: {
      deployment: { status: 'deployed', notes: 'Deployed to dev.', recordedAt: '2026-06-04T12:00:00.000Z' },
      test: { status: 'passed', notes: 'Verified onChange fires.', recordedAt: '2026-06-04T13:00:00.000Z' },
    },
    localTestRecord: { status: 'passed', updatedAt: '2026-06-05T00:00:00.000Z' },
    consultantTestRecord: { status: 'passed', updatedAt: '2026-06-06T00:00:00.000Z' },
    mcpChecklistOverrides: { 'diagnosis': 'done' },
    mcpNextStep: { action: 'mark_done', reason: 'All resolved.', updatedAt: '2026-06-09T00:00:00.000Z' },
    gitWorkflow: {
      confirmedBranch: 'feature/123-nvr', confirmedAt: '2026-06-02T00:00:00.000Z',
      lastCommitHash: 'abc123', lastCommitAt: '2026-06-03T00:00:00.000Z', lastCommitBranch: 'feature/123-nvr',
      lastPushedBranch: 'feature/123-nvr', lastPushedAt: '2026-06-04T00:00:00.000Z',
    },
  });
}

/** Fields explicitly required to be preserved by the reset. */
const PRESERVED_FIELD_OVERRIDES: Partial<Task> = {
  dueAt: '2026-07-01T00:00:00.000Z',
  budget: 10,
  budgetHours: 8,
  budgetNote: 'Fixed-price scope.',
  notes: 'Manual note the user wrote.',
  workItemSource: 'azure_devops',
  ticketUrl: 'https://helpdesk.example.com/tickets/1',
  devopsTaskUrl: 'https://dev.azure.com/org/proj/_workitems/edit/42',
  externalMessageId: 'msg-1',
  sourceThreadId: 'thread-1',
  sourceUrl: 'https://outlook.example.com/mail/1',
  senderName: 'Jane Doe',
  senderEmail: 'jane@example.com',
  importedAt: '2026-05-01T00:00:00.000Z',
  classificationLabel: 'ADO work item',
  adoContext: { type: 'work-item', workItemNumber: 42 },
  classificationState: 'created',
  emailBodyHtml: '<p>Original email.</p>',
  mcpTestTask: true,
};

describe('RESETTABLE_WORKFLOW_KEYS parity', () => {
  it('does not include the always-reset baseline fields (status/waitingState/attentionState/suggestedActions)', () => {
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('status');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('waitingState');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('attentionState');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('suggestedActions');
  });

  it('does not include any field required to be preserved', () => {
    const preservedKeys = Object.keys(PRESERVED_FIELD_OVERRIDES);
    for (const key of preservedKeys) {
      expect(RESETTABLE_WORKFLOW_KEYS).not.toContain(key);
    }
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('id');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('title');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('source');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('customerId');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('taskType');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('confidence');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('originalMessage');
    expect(RESETTABLE_WORKFLOW_KEYS).not.toContain('receivedAt');
  });
});

describe('taskHasResettableWorkflowState', () => {
  it('false for a brand-new task with no workflow state', () => {
    expect(taskHasResettableWorkflowState(makeTask({ status: 'new' }))).toBe(false);
  });

  it('false when resettable fields are present but empty (empty arrays/objects do not count)', () => {
    const task = makeTask({
      status: 'new',
      aiFileReviews: [],
      crmVerificationReports: [],
      crmDeveloperWorkflow: {},
      workflowSetup: {},
      implementationVerification: {},
      mcpChecklistOverrides: {},
    });
    expect(taskHasResettableWorkflowState(task)).toBe(false);
  });

  it('true when any single resettable field is genuinely set', () => {
    expect(taskHasResettableWorkflowState(makeTask({ taskMode: 'developer' }))).toBe(true);
    expect(taskHasResettableWorkflowState(makeTask({ completedAt: '2026-06-01T00:00:00.000Z' }))).toBe(true);
    expect(taskHasResettableWorkflowState(makeTask({ gitWorkflow: { confirmedBranch: 'feature/x' } }))).toBe(true);
  });

  it('true for a fully-worked (analyzed/developed/tested/reviewed/done) task', () => {
    expect(taskHasResettableWorkflowState(makeFullyWorkedTask())).toBe(true);
  });

  it('already-NEW task with stale legacy workflow state (old status-only reset bug) is still resettable', () => {
    // Reproduces the reported bug: status/waitingState/attentionState already reset to NEW, but
    // crmDeveloperWorkflow/workflowSetup/etc. were never cleared by the old applyTaskPhase("new").
    const task = makeTask({
      status: 'new', waitingState: null, attentionState: null,
      crmDeveloperWorkflow: { detectedWorkKind: 'script', currentStep: 'pull-request' },
      workflowSetup: { devTargetKind: 'script' },
    });
    expect(taskHasResettableWorkflowState(task)).toBe(true);
  });
});

describe('buildTaskWorkflowResetPatch', () => {
  it('always resets the baseline fields regardless of input', () => {
    const patch = buildTaskWorkflowResetPatch();
    expect(patch.status).toBe('new');
    expect(patch.waitingState).toBeNull();
    expect(patch.attentionState).toBeNull();
    expect(patch.suggestedActions).toEqual([]);
  });

  it('sets every resettable workflow key to undefined so it disappears on serialization', () => {
    const patch = buildTaskWorkflowResetPatch();
    for (const key of RESETTABLE_WORKFLOW_KEYS) {
      expect(patch[key]).toBeUndefined();
      expect(key in patch).toBe(true); // key present so a shallow merge overwrites, not just skips
    }
    // Confirms the "disappears after serialization" contract, not just an in-memory undefined.
    const serialized = JSON.parse(JSON.stringify({ ...makeFullyWorkedTask(), ...patch }));
    for (const key of RESETTABLE_WORKFLOW_KEYS) {
      expect(key in serialized).toBe(false);
    }
  });

  it('is idempotent — applying the patch twice produces the same result', () => {
    const once = { ...makeFullyWorkedTask(), ...buildTaskWorkflowResetPatch() };
    const twice = { ...once, ...buildTaskWorkflowResetPatch() };
    expect(JSON.parse(JSON.stringify(twice))).toEqual(JSON.parse(JSON.stringify(once)));
  });
});

describe('resetTaskWorkflowToNew', () => {
  it('resetting a fully-worked task produces a clean NEW workflow state', () => {
    const task = makeFullyWorkedTask();
    const patch = resetTaskWorkflowToNew(task);
    const result = { ...task, ...patch };

    expect(result.status).toBe('new');
    expect(result.waitingState).toBeNull();
    expect(result.attentionState).toBeNull();
    expect(result.suggestedActions).toEqual([]);
    for (const key of RESETTABLE_WORKFLOW_KEYS) {
      expect(result[key]).toBeUndefined();
    }
    expect(taskHasResettableWorkflowState(result)).toBe(false);
  });

  it('old technical-plan approval, Dataverse reports, AI/manual review results, test records, and gitWorkflow tracking cannot be reused after reset', () => {
    const task = makeFullyWorkedTask();
    const result = { ...task, ...resetTaskWorkflowToNew(task) };
    expect(result.crmDeveloperWorkflow).toBeUndefined();
    expect(result.crmVerificationReports).toBeUndefined();
    expect(result.implementationVerification).toBeUndefined();
    expect(result.deploymentTesting).toBeUndefined();
    expect(result.localTestRecord).toBeUndefined();
    expect(result.consultantTestRecord).toBeUndefined();
    expect(result.gitWorkflow).toBeUndefined();
  });

  it('REGRESSION: reset to NEW clears deployment state, deployment test state, source-control progression, and PR tracking together', () => {
    const task = makeFullyWorkedTask();
    task.crmDeveloperWorkflow = {
      ...task.crmDeveloperWorkflow,
      pullRequestProposal: { generatedAt: '2026-06-07T00:00:00.000Z', title: 't', body: 'b', checklist: [], warnings: [] },
      pullRequestTracking: { createdManually: true, createdAt: '2026-06-08T00:00:00.000Z', prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/1' },
    };
    task.waitingState = 'code-review';
    const result = { ...task, ...resetTaskWorkflowToNew(task) };

    expect(result.deploymentTesting).toBeUndefined();
    expect(result.gitWorkflow).toBeUndefined();
    expect(result.crmDeveloperWorkflow).toBeUndefined(); // clears nested pullRequestProposal/pullRequestTracking too
    expect(result.waitingState).toBeNull(); // clears the Code Review 'waiting for colleague review' state
    expect(taskHasResettableWorkflowState(result)).toBe(false);
  });

  it('preserves identity, original assignment, notes, tracking, source metadata, and budget constraints', () => {
    const task = makeFullyWorkedTask();
    Object.assign(task, PRESERVED_FIELD_OVERRIDES);
    const patch = resetTaskWorkflowToNew(task);
    const result = { ...task, ...patch };

    expect(result.id).toBe(task.id);
    expect(result.title).toBe(task.title);
    expect(result.source).toBe(task.source);
    expect(result.customerId).toBe(task.customerId);
    expect(result.taskType).toBe(task.taskType);
    expect(result.confidence).toBe(task.confidence);
    expect(result.originalMessage).toBe(task.originalMessage);
    expect(result.receivedAt).toBe(task.receivedAt);
    expect(result.dueAt).toBe(PRESERVED_FIELD_OVERRIDES.dueAt);
    expect(result.budget).toBe(PRESERVED_FIELD_OVERRIDES.budget);
    expect(result.budgetHours).toBe(PRESERVED_FIELD_OVERRIDES.budgetHours);
    expect(result.budgetNote).toBe(PRESERVED_FIELD_OVERRIDES.budgetNote);
    expect(result.workItemSource).toBe(PRESERVED_FIELD_OVERRIDES.workItemSource);
    expect(result.ticketUrl).toBe(PRESERVED_FIELD_OVERRIDES.ticketUrl);
    expect(result.devopsTaskUrl).toBe(PRESERVED_FIELD_OVERRIDES.devopsTaskUrl);
    expect(result.externalMessageId).toBe(PRESERVED_FIELD_OVERRIDES.externalMessageId);
    expect(result.sourceThreadId).toBe(PRESERVED_FIELD_OVERRIDES.sourceThreadId);
    expect(result.sourceUrl).toBe(PRESERVED_FIELD_OVERRIDES.sourceUrl);
    expect(result.senderName).toBe(PRESERVED_FIELD_OVERRIDES.senderName);
    expect(result.senderEmail).toBe(PRESERVED_FIELD_OVERRIDES.senderEmail);
    expect(result.importedAt).toBe(PRESERVED_FIELD_OVERRIDES.importedAt);
    expect(result.classificationLabel).toBe(PRESERVED_FIELD_OVERRIDES.classificationLabel);
    expect(result.adoContext).toEqual(PRESERVED_FIELD_OVERRIDES.adoContext);
    expect(result.classificationState).toBe(PRESERVED_FIELD_OVERRIDES.classificationState);
    expect(result.emailBodyHtml).toBe(PRESERVED_FIELD_OVERRIDES.emailBodyHtml);
    expect(result.mcpTestTask).toBe(true);
    // Original user note preserved, with the audit line appended — not erased.
    expect(result.notes).toContain('Manual note the user wrote.');
    expect(result.notes).toContain(DEFAULT_WORKFLOW_RESET_AUDIT_NOTE);
  });

  it('appends a concise audit note without erasing existing notes/activity history', () => {
    const task = makeTask({ notes: '[2026-06-01T00:00:00.000Z] MCP local write: create_test_task', taskMode: 'developer' });
    const patch = resetTaskWorkflowToNew(task);
    expect(patch.notes).toContain('MCP local write: create_test_task');
    expect(patch.notes).toContain(DEFAULT_WORKFLOW_RESET_AUDIT_NOTE);
    const lines = (patch.notes ?? '').split('\n');
    expect(lines).toHaveLength(2);
  });

  it('the appended audit note is recognized by the activity formatter, not treated as a manual note', () => {
    const task = makeTask({ notes: 'User note.', taskMode: 'developer' });
    const patch = resetTaskWorkflowToNew(task);
    const auditLine = (patch.notes ?? '').split('\n')[1];
    expect(isTaskActivityLine(auditLine)).toBe(true);
    expect(formatTaskActivityNote(auditLine).message).toContain('NEW');
  });

  it('is idempotent — resetting an already-clean NEW task produces the same clean state without damaging preserved fields', () => {
    const clean = makeTask({ status: 'new', waitingState: null, attentionState: null, suggestedActions: [] });
    Object.assign(clean, PRESERVED_FIELD_OVERRIDES);
    const once = { ...clean, ...resetTaskWorkflowToNew(clean) };
    const twice = { ...once, ...resetTaskWorkflowToNew(once) };

    expect(twice.status).toBe('new');
    expect(twice.id).toBe(clean.id);
    expect(twice.mcpTestTask).toBe(true);
    expect(twice.budget).toBe(PRESERVED_FIELD_OVERRIDES.budget);
    // Preserved fields are untouched by a second reset.
    expect(twice.dueAt).toBe(PRESERVED_FIELD_OVERRIDES.dueAt);
    expect(taskHasResettableWorkflowState(twice)).toBe(false);
    // The original manual note survives both resets verbatim — each reset appends its own audit
    // line without touching or duplicating the prior content.
    const noteLines = (twice.notes ?? '').split('\n');
    expect(noteLines[0]).toBe('Manual note the user wrote.');
    expect(noteLines.filter((l) => l.includes(DEFAULT_WORKFLOW_RESET_AUDIT_NOTE))).toHaveLength(2);
  });

  it('accepts a custom audit note', () => {
    const task = makeTask({});
    const patch = resetTaskWorkflowToNew(task, 'Custom reset reason.');
    expect(patch.notes).toContain('Custom reset reason.');
  });
});

describe('reset does not touch anything outside local task state', () => {
  it('buildTaskWorkflowResetPatch/resetTaskWorkflowToNew are pure — no I/O, no Git, no filesystem, no Dataverse calls', () => {
    // These are plain synchronous functions operating on an in-memory object; there is no way for
    // them to reach the filesystem, Git, or an external system. This test pins that contract by
    // construction: both are ordinary sync functions returning plain data.
    expect(buildTaskWorkflowResetPatch.constructor.name).toBe('Function');
    expect(resetTaskWorkflowToNew.constructor.name).toBe('Function');
    const task = makeFullyWorkedTask();
    const before = JSON.stringify(task);
    resetTaskWorkflowToNew(task);
    // The input task object itself is never mutated — only a new patch object is returned.
    expect(JSON.stringify(task)).toBe(before);
  });
});

describe('workflow overview / AI prompt after reset show the initial step, not a cached later step', () => {
  it('getDeveloperReadiness recommends the initial set_task_mode step after reset, not the fully-worked task\'s later step', () => {
    const worked = makeFullyWorkedTask();
    const workedReadiness = getDeveloperReadiness(worked);
    expect(workedReadiness.categorizedBlockers.some((b) => b.mcpTool === 'set_task_mode')).toBe(false);

    const reset = { ...worked, ...resetTaskWorkflowToNew(worked) } as Task;
    const resetReadiness = getDeveloperReadiness(reset);
    expect(resetReadiness.isReady).toBe(false);
    expect(resetReadiness.categorizedBlockers.some((b) => b.mcpTool === 'set_task_mode')).toBe(true);
  });

  it('buildAiWorkflowPrompt recommends the initial setup step after reset instead of the cached pull-request phase', () => {
    const worked = makeFullyWorkedTask();
    const reset = { ...worked, ...resetTaskWorkflowToNew(worked) } as Task;
    const prompt = buildAiWorkflowPrompt(reset);
    expect(prompt).not.toContain('Phase: pull-request');
    expect(prompt).toContain('set_task_mode');
  });
});
