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
