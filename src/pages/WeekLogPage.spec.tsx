// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WeekLogPage from './WeekLogPage';
import * as api from '../lib/tauriCommands';

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    tasks: [],
    settings: {},
    updateWeeklyNote: vi.fn(),
    getCustomerById: vi.fn(),
  }),
}));

describe('WeekLogPage queue notes', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a completed queue note alongside completed tasks', async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    vi.spyOn(api, 'getDailyQueue').mockImplementation(async (date) => {
      const queueDate = date ?? today;
      return {
        apiVersion: '1',
        date: queueDate,
        revision: queueDate === today ? 2 : 0,
        generatedAt: now.toISOString(),
        entries: queueDate === today ? [{
          id: 'queue-note-1',
          kind: 'note',
          position: 1,
          text: 'Send email',
          addedAt: now.toISOString(),
          completedAt: now.toISOString(),
        }] : [],
      };
    });

    render(<WeekLogPage />);

    expect(await screen.findByText('Send email')).toBeInTheDocument();
    expect(screen.getByText('Queue note')).toBeInTheDocument();
  });
});
