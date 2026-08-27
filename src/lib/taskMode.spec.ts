import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { createTaskRecord } from './taskRecord';
import contractCases from './taskMode.contract-cases.json';
import { inferTaskMode } from './taskMode';

const baseTask: Task = {
  id: 'task-mode-contract',
  title: 'General task',
  source: 'manual',
  customerId: '',
  taskType: 'other',
  status: 'new',
  confidence: 100,
  originalMessage: '',
  receivedAt: '2026-08-26T08:00:00.000Z',
  suggestedActions: [],
};

describe('effective task workflow type contract', () => {
  for (const contractCase of contractCases) {
    it(contractCase.name, () => {
      const task = { ...baseTask, ...contractCase.task } as Task;
      expect(inferTaskMode(task)).toEqual(contractCase.expected);
    });
  }

  it('does not materialize an automatic classification into the explicit override', () => {
    const task = createTaskRecord({
      title: 'Programátorské zadání č. 2 — OnLoad + OnChange validace délky schůzky',
      source: 'manual',
      customerId: '',
      taskType: 'other',
      status: 'new',
      confidence: 100,
      originalMessage: '',
    }, 'new-auto-developer', '2026-08-26T08:00:00.000Z');

    expect(inferTaskMode(task)).toEqual({ mode: 'developer', isAuto: true });
    expect(task.taskMode).toBeUndefined();
  });
});
