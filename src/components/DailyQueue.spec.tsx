// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DailyQueue from './DailyQueue';
import * as api from '../lib/tauriCommands';
import type { DailyQueueResult } from '../lib/tauriCommands';
import type { WorkItem } from '../domain/workItem';

function workItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: 1,
    id,
    kind: 'task',
    title: `Task ${id}`,
    status: 'ready',
    priority: 'normal',
    source: 'manual',
    externalReferences: [],
    tags: [],
    context: [],
    createdAt: '2026-08-17T08:00:00Z',
    updatedAt: '2026-08-17T08:00:00Z',
    revision: 1,
    history: [],
    ...overrides,
  };
}

function queueResult(entries: Array<{ item: WorkItem; position: number }>, revision = 1): DailyQueueResult {
  return {
    apiVersion: '1',
    date: '2026-08-17',
    revision,
    generatedAt: '2026-08-17T08:00:00Z',
    entries: entries.map(({ item, position }) => ({
      id: item.id,
      kind: 'work_item' as const,
      position,
      workItem: item,
      addedAt: '2026-08-17T08:00:00Z',
    })),
  };
}

describe('DailyQueue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    // No `globals: true` in this project's vitest setup, so
    // @testing-library/react cannot auto-detect the test framework and
    // auto-register its own afterEach(cleanup) — without this explicit call,
    // each test's rendered tree stays mounted into the next test's document.
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the empty state when nothing is queued', async () => {
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([], 0));
    render(<DailyQueue workItems={[]} />);
    expect(await screen.findByText(/nothing queued for today yet/i)).toBeInTheDocument();
  });

  it('renders queued entries in order, with the first non-terminal one marked "Right now"', async () => {
    const a = workItem('a', { title: 'Ptáček' });
    const b = workItem('b', { title: 'Neopharma' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(
      queueResult([{ item: a, position: 1 }, { item: b, position: 2 }]),
    );
    render(<DailyQueue workItems={[]} />);

    expect(await screen.findByText('Ptáček')).toBeInTheDocument();
    expect(screen.getByText('Neopharma')).toBeInTheDocument();
    expect(screen.getByText('Right now')).toBeInTheDocument();
    expect(screen.getByText('Up next')).toBeInTheDocument();
    // "Right now" section contains the first entry only.
    const nowGroup = screen.getByText('Right now').closest('.daily-queue-group');
    expect(nowGroup).toContainElement(screen.getByText('Ptáček'));
  });

  it('a completed item is never shown as "Right now" even if it is first in the queue', async () => {
    const done = workItem('done', { title: 'Finished thing', status: 'completed' });
    const active = workItem('todo', { title: 'Still to do', status: 'ready' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(
      queueResult([{ item: done, position: 1 }, { item: active, position: 2 }]),
    );
    render(<DailyQueue workItems={[]} />);

    await screen.findByText('Finished thing');
    const nowGroup = screen.getByText('Right now').closest('.daily-queue-group');
    expect(nowGroup).toContainElement(screen.getByText('Still to do'));
    expect(nowGroup).not.toContainElement(screen.getByText('Finished thing'));
  });

  it('adds a task via the picker, excluding items already queued', async () => {
    const queued = workItem('queued', { title: 'Already queued' });
    const addable = workItem('addable', { title: 'Addable task' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([{ item: queued, position: 1 }]));
    const addSpy = vi
      .spyOn(api, 'addToDailyQueue')
      .mockResolvedValue(queueResult([{ item: queued, position: 1 }, { item: addable, position: 2 }], 2));

    render(<DailyQueue workItems={[queued, addable]} />);
    await screen.findByText('Already queued');

    fireEvent.click(screen.getByRole('button', { name: /add work item/i }));
    expect(screen.getByText('Addable task')).toBeInTheDocument();
    expect(screen.queryByText('Already queued', { selector: '.daily-queue-picker-title' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Addable task'));
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('2026-08-17', 'addable', 1));
  });

  it('creates a lightweight text note without creating a work item', async () => {
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([], 0));
    const updated: DailyQueueResult = {
      ...queueResult([], 1),
      entries: [{
        id: 'queue-note-1',
        kind: 'note',
        position: 1,
        text: 'Send email',
        addedAt: '2026-08-17T08:00:00Z',
      }],
    };
    const addNoteSpy = vi.spyOn(api, 'addNoteToDailyQueue').mockResolvedValue(updated);

    render(<DailyQueue workItems={[]} />);
    await screen.findByText(/nothing queued/i);
    fireEvent.change(screen.getByRole('textbox', { name: /quick queue note/i }), {
      target: { value: '  Send email  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(addNoteSpy).toHaveBeenCalledWith('2026-08-17', 'Send email', 0));
    expect(await screen.findByText('Send email')).toBeInTheDocument();
    expect(screen.getByText('Text note')).toBeInTheDocument();
  });

  it('accepts a work item dropped from the Work records list', async () => {
    const dropped = workItem('drop-me', { title: 'Dragged work' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([], 0));
    const addSpy = vi.spyOn(api, 'addToDailyQueue').mockResolvedValue(
      queueResult([{ item: dropped, position: 1 }], 1),
    );
    render(<DailyQueue workItems={[dropped]} />);
    const queue = await screen.findByRole('region', { name: /today's queue/i });

    fireEvent.drop(queue, {
      dataTransfer: { getData: (type: string) => type === 'application/x-task-workbench-work-item' ? dropped.id : '' },
    });

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('2026-08-17', dropped.id, 0));
  });

  it('removes a task', async () => {
    const a = workItem('a', { title: 'Removable' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([{ item: a, position: 1 }]));
    const removeSpy = vi.spyOn(api, 'removeFromDailyQueue').mockResolvedValue(queueResult([], 2));

    render(<DailyQueue workItems={[]} />);
    await screen.findByText('Removable');

    fireEvent.click(screen.getByRole('button', { name: /remove removable/i }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('2026-08-17', 'a', 1));
    expect(await screen.findByText(/nothing queued for today yet/i)).toBeInTheDocument();
  });

  it('moves a task up and down using the accessible buttons', async () => {
    const a = workItem('a', { title: 'A' });
    const b = workItem('b', { title: 'B' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(
      queueResult([{ item: a, position: 1 }, { item: b, position: 2 }]),
    );
    const moveSpy = vi
      .spyOn(api, 'moveDailyQueueItem')
      .mockResolvedValue(queueResult([{ item: b, position: 1 }, { item: a, position: 2 }], 2));

    render(<DailyQueue workItems={[]} />);
    await screen.findByText('B');

    // "B" is in the "Up next" group at position 2 — move it up.
    const bRow = screen.getByText('B').closest<HTMLElement>('.daily-queue-row')!;
    fireEvent.click(within(bRow).getByRole('button', { name: /move up/i }));
    await waitFor(() => expect(moveSpy).toHaveBeenCalledWith('2026-08-17', 'b', 1, 1));
  });

  it('reorders via drag and drop', async () => {
    const a = workItem('a', { title: 'A' });
    const b = workItem('b', { title: 'B' });
    const c = workItem('c', { title: 'C' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(
      queueResult([{ item: a, position: 1 }, { item: b, position: 2 }, { item: c, position: 3 }]),
    );
    const moveSpy = vi.spyOn(api, 'moveDailyQueueItem').mockResolvedValue(
      queueResult([{ item: c, position: 1 }, { item: a, position: 2 }, { item: b, position: 3 }], 2),
    );

    render(<DailyQueue workItems={[]} />);
    await screen.findByText('C');

    const sourceRow = screen.getByText('C').closest('.daily-queue-row')!;
    const targetRow = screen.getByText('A').closest('.daily-queue-row')!;
    fireEvent.dragStart(sourceRow);
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);

    await waitFor(() => expect(moveSpy).toHaveBeenCalledWith('2026-08-17', 'c', 1, 1));
  });

  it('on a revision conflict, shows a message and refreshes from the authoritative queue', async () => {
    const a = workItem('a', { title: 'A' });
    const getSpy = vi
      .spyOn(api, 'getDailyQueue')
      .mockResolvedValueOnce(queueResult([{ item: a, position: 1 }], 1))
      .mockResolvedValueOnce(queueResult([{ item: a, position: 1 }], 5));
    vi.spyOn(api, 'removeFromDailyQueue').mockRejectedValue(
      new Error('revision_conflict: Expected revision 1, but current revision is 5.'),
    );

    render(<DailyQueue workItems={[]} />);
    await screen.findByText('A');

    fireEvent.click(screen.getByRole('button', { name: /remove a from/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere/i);
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));
  });

  it("Today's queue is visually and structurally distinct from status/priority display", async () => {
    const a = workItem('a', { title: 'A', status: 'ready', priority: 'high' });
    vi.spyOn(api, 'getDailyQueue').mockResolvedValue(queueResult([{ item: a, position: 1 }]));
    render(<DailyQueue workItems={[]} />);
    await screen.findByText('A');
    // The queue section carries its own heading/landmark, separate from any
    // status/planningBucket display elsewhere on the page.
    expect(screen.getByRole('region', { name: "Today's queue" })).toBeInTheDocument();
    expect(screen.getByText("Today's queue")).toBeInTheDocument();
  });
});
