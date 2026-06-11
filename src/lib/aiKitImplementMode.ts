import { isPathInsideDir } from './pathUtils';

export interface PrepareImplementInput {
  taskKind: 'plugin' | 'script' | 'ribbon' | 'crm-other';
  workIntent?: 'create' | 'update' | 'fix' | 'review';
  artifactPath: string;
  repoRoot?: string | null;
  aiKitPath?: string | null;
}

export interface PrepareImplementDeps {
  checkPathExists(path: string): Promise<boolean>;
  readFileContent(path: string): Promise<string>;
}

export interface PreparedImplementInput {
  artifactPath: string;
  currentContent: string;
  isCreateMode: boolean;
}

export function isScriptCreateMode(input: Pick<PrepareImplementInput, 'taskKind' | 'workIntent'>): boolean {
  return input.taskKind === 'script' && input.workIntent === 'create';
}

export async function prepareImplementInput(
  input: PrepareImplementInput,
  deps: PrepareImplementDeps,
): Promise<PreparedImplementInput> {
  const artifactPath = input.artifactPath.trim();
  if (!artifactPath) {
    throw new Error('No artifact file path is configured. Set scriptPath or artifactPath in task setup.');
  }

  if (input.aiKitPath?.trim() && isPathInsideDir(artifactPath, input.aiKitPath.trim())) {
    throw new Error(
      'AI Kit is read-only. Target file must be inside the customer repository, not the AI Kit repo.\n' +
      `File: ${artifactPath}\nAI Kit: ${input.aiKitPath}`
    );
  }

  if (input.repoRoot?.trim() && !isPathInsideDir(artifactPath, input.repoRoot.trim())) {
    throw new Error(`Target file is outside the repository root.\nFile: ${artifactPath}\nRepo: ${input.repoRoot}`);
  }

  const createMode = isScriptCreateMode(input);
  const fileExists = await deps.checkPathExists(artifactPath).catch(() => false);

  if (!fileExists && !createMode) {
    throw new Error(
      `Target file not found for ${input.taskKind} ${input.workIntent ?? 'update'} workflow.\n` +
      `File: ${artifactPath}`
    );
  }

  if (!fileExists && createMode) {
    return {
      artifactPath,
      currentContent: '',
      isCreateMode: true,
    };
  }

  const currentContent = await deps.readFileContent(artifactPath);
  return {
    artifactPath,
    currentContent,
    isCreateMode: createMode,
  };
}
