/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types';
import TaskModeSwitch from './TaskModeSwitch';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('TaskModeSwitch', () => {
  it('shows Developer auto without persisting an explicit taskMode', () => {
    const task: Task = {
      id: 'auto-developer',
      title: 'Programátorské zadání č. 2 — OnLoad + OnChange validace délky schůzky',
      source: 'manual',
      customerId: '',
      taskType: 'other',
      status: 'new',
      confidence: 100,
      originalMessage: '',
      receivedAt: '2026-08-26T08:00:00.000Z',
      suggestedActions: [],
    };
    const onSetMode = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => root?.render(<TaskModeSwitch task={task} onSetMode={onSetMode} />));

    const active = host.querySelector('.tms-btn--active');
    expect(active?.textContent).toContain('Developer');
    expect(active?.textContent).toContain('auto');
    expect(task.taskMode).toBeUndefined();
    expect(onSetMode).not.toHaveBeenCalled();
  });
});
