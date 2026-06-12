/**
 * Returns true if saving tasks to persistent storage should be blocked.
 * Saving must be blocked when the initial load from disk failed — any write
 * would overwrite the existing file with an empty or partial in-memory state.
 */
export function isTaskSaveBlocked(taskLoadFailed: boolean): boolean {
  return taskLoadFailed;
}

/**
 * Builds a user-visible error message for a task load failure.
 */
export function buildTaskLoadErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    'Task storage failed to load. ' +
    `Detail: ${msg}. ` +
    'Saving is disabled to prevent data loss. ' +
    'Restart the app and check the data directory if this persists.'
  );
}
