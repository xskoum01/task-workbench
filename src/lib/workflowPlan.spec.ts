import { describe, expect, it } from 'vitest';
import { buildTaskWorkflowPlan } from './workflowPlan';
import type { Task } from '../types';

function makeScriptCreateTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-1',
    title: 'Add account script',
    status: 'in-progress',
    taskMode: 'developer',
    workflowSetup: {
      devTargetKind: 'script',
      workIntent: 'create',
      scriptPath: 'C:/repo/Scripts/nvr_account.js',
      artifactPath: 'C:/repo/Scripts/nvr_account.js',
      confirmedAt: '2026-06-01T10:00:00.000Z',
    },
    ...overrides,
  } as unknown as Task;
}

describe('buildTaskWorkflowPlan — script create', () => {
  it('currentAction is verify-implementation when script-create task is in-progress', () => {
    const task = makeScriptCreateTask({ status: 'in-progress' });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.currentAction).toBe('verify-implementation');
  });

  it('requiresScriptCreate is true for script create', () => {
    const task = makeScriptCreateTask({ status: 'analyzed' });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.requiresScriptCreate).toBe(true);
  });

  it('currentAction is start-development when script-create task is analyzed', () => {
    const task = makeScriptCreateTask({ status: 'analyzed' });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.currentAction).toBe('start-development');
  });

  it('requiresDevTools is true for confirmed script task', () => {
    const task = makeScriptCreateTask({ status: 'in-progress' });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.requiresDevTools).toBe(true);
  });
});

describe('buildTaskWorkflowPlan — Deployment & Testing transition (displayPhase-driven action)', () => {
  it('REGRESSION: currentAction/currentActionLabel reflect Deployment & Testing, not stale Verify Implementation, once waitingState is consultant-testing', () => {
    // Root cause: currentAction/currentActionLabel were previously keyed on task.status alone.
    // status stays 'in-progress' across the Development -> Deployment & Testing transition (only
    // waitingState changes), so the plan kept recommending "Verify Implementation" forever.
    const task = makeScriptCreateTask({ status: 'in-progress', waitingState: 'consultant-testing' });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.displayPhase).toBe('testing');
    expect(plan.currentAction).not.toBe('verify-implementation');
    expect(plan.currentAction).toBe('none');
    expect(plan.currentActionLabel).toBe('Deployment & testing in progress');
    expect(plan.currentActionLabel).not.toBe('Verify Implementation');
  });

  it('currentAction is verify-implementation again once back in plain Development (waitingState cleared)', () => {
    const task = makeScriptCreateTask({ status: 'in-progress', waitingState: null });
    const plan = buildTaskWorkflowPlan(task);
    expect(plan.displayPhase).toBe('in-progress');
    expect(plan.currentAction).toBe('verify-implementation');
    expect(plan.currentActionLabel).toBe('Verify Implementation');
  });

  it('the Deployment & Testing action label is stable across plugin and script targets', () => {
    const pluginTask = makeScriptCreateTask({
      status: 'in-progress',
      waitingState: 'consultant-testing',
      workflowSetup: { devTargetKind: 'plugin', workIntent: 'update', confirmedAt: '2026-06-01T10:00:00.000Z' },
    });
    const plan = buildTaskWorkflowPlan(pluginTask);
    expect(plan.currentActionLabel).toBe('Deployment & testing in progress');
  });
});
