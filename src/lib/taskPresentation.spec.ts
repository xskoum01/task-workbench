import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { expectedOutcomeCzech } from './taskPresentation';

const baseTask = { id: 't1', title: 'ADO task', source: 'devops', customerId: 'other', taskType: 'other', status: 'new', confidence: 100, originalMessage: '', receivedAt: '2026-01-01', suggestedActions: [] } satisfies Task;

describe('task presentation', () => {
  it('translates the historical ADO expected-outcome sentence', () => {
    expect(expectedOutcomeCzech({
      ...baseTask,
      description: 'Azure DevOps task 10847 requests adding the KS / KS specialist fields to scripts. The exact implementation details should be checked in the linked work item.',
    })).toBe('Azure DevOps úkol 10847 požaduje doplnění polí KS / KS specialist do skriptů. Přesné detaily implementace ověřte v odkazované položce.');
  });
});
