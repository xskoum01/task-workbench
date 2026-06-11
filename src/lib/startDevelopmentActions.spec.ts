import { describe, expect, it } from 'vitest';
import { resolveScriptActions } from './startDevelopmentActions';

describe('resolveScriptActions', () => {
  it('includes Create Script File actions for Script Create when file is missing', () => {
    const state = resolveScriptActions({
      isScript: true,
      workIntent: 'create',
      scriptTargetPath: 'C:/repo/Scripts/new_script.js',
      scriptTargetExists: false,
    });

    expect(state.showCreateScriptFile).toBe(true);
    expect(state.showCreateScriptAndImplement).toBe(true);
    expect(state.openScriptPrimary).toBe(false);
    expect(state.openScriptDisabledReason).toBe('Script file does not exist yet. Create it first.');
  });

  it('keeps open script as primary for Script Update when file exists', () => {
    const state = resolveScriptActions({
      isScript: true,
      workIntent: 'update',
      scriptTargetPath: 'C:/repo/Scripts/existing_script.js',
      scriptTargetExists: true,
    });

    expect(state.showCreateScriptFile).toBe(false);
    expect(state.showCreateScriptAndImplement).toBe(false);
    expect(state.openScriptPrimary).toBe(true);
    expect(state.openScriptDisabledReason).toBeNull();
  });

  it('hides create actions once file is created (scriptTargetExists becomes true)', () => {
    const state = resolveScriptActions({
      isScript: true,
      workIntent: 'create',
      scriptTargetPath: 'C:/repo/Scripts/new_script.js',
      scriptTargetExists: true,
    });

    expect(state.showCreateScriptFile).toBe(false);
    expect(state.showCreateScriptAndImplement).toBe(false);
    expect(state.openScriptPrimary).toBe(true);
    expect(state.openScriptDisabledReason).toBeNull();
  });

  it('hides create actions when no script target is configured', () => {
    const state = resolveScriptActions({
      isScript: true,
      workIntent: 'create',
      scriptTargetPath: '',
      scriptTargetExists: false,
    });

    expect(state.showCreateScriptFile).toBe(false);
    expect(state.showCreateScriptAndImplement).toBe(false);
  });

  it('returns all false when not a script task', () => {
    const state = resolveScriptActions({
      isScript: false,
      workIntent: 'create',
      scriptTargetPath: 'C:/repo/Scripts/new_script.js',
      scriptTargetExists: false,
    });

    expect(state.showCreateScriptFile).toBe(false);
    expect(state.showCreateScriptAndImplement).toBe(false);
    expect(state.openScriptPrimary).toBe(false);
    expect(state.openScriptDisabledReason).toBeNull();
  });
});
