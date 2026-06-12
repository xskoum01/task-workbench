import { describe, it, expect } from 'vitest';
import { isTaskSaveBlocked, buildTaskLoadErrorMessage } from './taskStorageGuard';

describe('isTaskSaveBlocked', () => {
  it('returns false when task load succeeded (initial state)', () => {
    expect(isTaskSaveBlocked(false)).toBe(false);
  });

  it('returns true when task load failed', () => {
    expect(isTaskSaveBlocked(true)).toBe(true);
  });

  it('save is never blocked if load never failed', () => {
    // Simulates the normal happy path: app starts, load succeeds, saves are allowed
    const taskLoadFailed = false;
    expect(isTaskSaveBlocked(taskLoadFailed)).toBe(false);
  });

  it('save is blocked immediately once load fails', () => {
    // Simulates the error path: app starts, load throws, saves must be blocked
    const taskLoadFailed = true;
    expect(isTaskSaveBlocked(taskLoadFailed)).toBe(true);
  });

  it('save becomes unblocked if taskLoadFailed is reset to false (after successful reload)', () => {
    // Simulates recovery: user manually reloads and it succeeds
    let taskLoadFailed = true;
    expect(isTaskSaveBlocked(taskLoadFailed)).toBe(true);
    taskLoadFailed = false;
    expect(isTaskSaveBlocked(taskLoadFailed)).toBe(false);
  });
});

describe('buildTaskLoadErrorMessage', () => {
  it('includes the original error message in the output', () => {
    const msg = buildTaskLoadErrorMessage(new Error('JSON parse error at offset 42'));
    expect(msg).toContain('JSON parse error at offset 42');
  });

  it('indicates that saving is disabled to prevent data loss', () => {
    const msg = buildTaskLoadErrorMessage(new Error('any error'));
    expect(msg).toContain('Saving is disabled');
    expect(msg).toContain('prevent data loss');
  });

  it('advises restarting the app', () => {
    const msg = buildTaskLoadErrorMessage(new Error('any error'));
    expect(msg).toContain('Restart the app');
  });

  it('handles non-Error objects gracefully', () => {
    const msg = buildTaskLoadErrorMessage('string error value');
    expect(msg).toContain('string error value');
  });

  it('handles null without throwing', () => {
    expect(() => buildTaskLoadErrorMessage(null)).not.toThrow();
    expect(buildTaskLoadErrorMessage(null)).toContain('null');
  });

  it('handles undefined without throwing', () => {
    expect(() => buildTaskLoadErrorMessage(undefined)).not.toThrow();
  });

  it('contains the failed-to-load text', () => {
    const msg = buildTaskLoadErrorMessage(new Error('disk error'));
    expect(msg).toContain('failed to load');
  });
});
