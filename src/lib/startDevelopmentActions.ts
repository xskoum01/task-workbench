export interface ResolveScriptActionsInput {
  isScript: boolean;
  workIntent?: 'create' | 'update' | 'fix' | 'review';
  scriptTargetPath?: string;
  scriptTargetExists: boolean;
}

export interface ScriptActionsState {
  showCreateScriptFile: boolean;
  showCreateScriptAndImplement: boolean;
  openScriptPrimary: boolean;
  openScriptDisabledReason: string | null;
}

export function resolveScriptActions(input: ResolveScriptActionsInput): ScriptActionsState {
  if (!input.isScript) {
    return {
      showCreateScriptFile: false,
      showCreateScriptAndImplement: false,
      openScriptPrimary: false,
      openScriptDisabledReason: null,
    };
  }

  const isCreateMode = input.workIntent === 'create';
  const hasTarget = !!input.scriptTargetPath?.trim();

  if (!hasTarget) {
    return {
      showCreateScriptFile: false,
      showCreateScriptAndImplement: false,
      openScriptPrimary: false,
      openScriptDisabledReason: 'No script target configured. Use Confirm Setup to select a script file.',
    };
  }

  if (isCreateMode && !input.scriptTargetExists) {
    return {
      showCreateScriptFile: true,
      showCreateScriptAndImplement: true,
      openScriptPrimary: false,
      openScriptDisabledReason: 'Script file does not exist yet. Create it first.',
    };
  }

  return {
    showCreateScriptFile: false,
    showCreateScriptAndImplement: false,
    openScriptPrimary: true,
    openScriptDisabledReason: null,
  };
}
