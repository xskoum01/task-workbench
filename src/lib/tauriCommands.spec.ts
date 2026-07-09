import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri invoke bridge so these wrappers can be tested without a Tauri runtime.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { createOrCheckoutTaskBranch, commitTaskChanges, commitAndPushTaskChanges } from './tauriCommands';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// createOrCheckoutTaskBranch — the propose -> approve -> create/checkout wrapper
// ---------------------------------------------------------------------------

describe('createOrCheckoutTaskBranch', () => {
  it('calls create_or_checkout_task_branch_command with repoRoot and branchName', async () => {
    await createOrCheckoutTaskBranch('C:/repo', 'feature/123-add-thing');
    expect(invokeMock).toHaveBeenCalledWith('create_or_checkout_task_branch_command', {
      repoRoot: 'C:/repo',
      branchName: 'feature/123-add-thing',
    });
  });

  it('does not call create_git_branch (the fetch+rebase flow is a separate command)', async () => {
    await createOrCheckoutTaskBranch('C:/repo', 'feature/x');
    expect(invokeMock).not.toHaveBeenCalledWith('create_git_branch', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// commitTaskChanges / commitAndPushTaskChanges — forceAddFiles pass-through
// ---------------------------------------------------------------------------

describe('commitTaskChanges', () => {
  it('passes forceAddFiles through when provided', async () => {
    await commitTaskChanges('C:/repo', ['a.js'], 'msg', ['ignored.js']);
    expect(invokeMock).toHaveBeenCalledWith('commit_task_changes', {
      repoRoot: 'C:/repo',
      files: ['a.js'],
      message: 'msg',
      forceAddFiles: ['ignored.js'],
    });
  });

  it('sends null forceAddFiles when omitted (backend treats as empty)', async () => {
    await commitTaskChanges('C:/repo', ['a.js'], 'msg');
    expect(invokeMock).toHaveBeenCalledWith('commit_task_changes', {
      repoRoot: 'C:/repo',
      files: ['a.js'],
      message: 'msg',
      forceAddFiles: null,
    });
  });
});

describe('commitAndPushTaskChanges', () => {
  it('passes forceAddFiles through when provided', async () => {
    await commitAndPushTaskChanges('C:/repo', ['a.js'], 'msg', ['ignored.js']);
    expect(invokeMock).toHaveBeenCalledWith('commit_and_push_task_changes', {
      repoRoot: 'C:/repo',
      files: ['a.js'],
      message: 'msg',
      forceAddFiles: ['ignored.js'],
    });
  });

  it('sends null forceAddFiles when omitted', async () => {
    await commitAndPushTaskChanges('C:/repo', ['a.js'], 'msg');
    expect(invokeMock).toHaveBeenCalledWith('commit_and_push_task_changes', {
      repoRoot: 'C:/repo',
      files: ['a.js'],
      message: 'msg',
      forceAddFiles: null,
    });
  });
});
