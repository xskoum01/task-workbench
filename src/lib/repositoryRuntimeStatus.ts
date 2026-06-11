import * as tauriApi from './tauriCommands';

export interface RepositoryRuntimeStatusInput {
  repoRoot?: string | null;
  artifactPath?: string | null;
}

export interface RepositoryRuntimeStatus {
  repoRoot: string | null;
  artifactPath: string | null;
  repoRootExists: boolean | null;
  artifactPathExists: boolean | null;
  artifactPathIsFile: boolean | null;
  gitDiffAvailable: boolean | null;
  currentBranch: string | null;
  warnings: string[];
}

export interface RepositoryRuntimeStatusDeps {
  checkPathExists(path: string): Promise<boolean>;
  readFileContent(path: string): Promise<string>;
  collectGitReviewContext(repoRoot: string): Promise<{ currentBranch: string; diff: string }>;
}

const DEFAULT_DEPS: RepositoryRuntimeStatusDeps = {
  checkPathExists: tauriApi.checkPathExists,
  readFileContent: tauriApi.readFileContent,
  collectGitReviewContext: tauriApi.collectGitReviewContext,
};

export async function getRepositoryRuntimeStatus(
  input: RepositoryRuntimeStatusInput,
  deps: RepositoryRuntimeStatusDeps = DEFAULT_DEPS,
): Promise<RepositoryRuntimeStatus> {
  const repoRoot = input.repoRoot?.trim() || null;
  const artifactPath = input.artifactPath?.trim() || null;
  const warnings: string[] = [];

  let repoRootExists: boolean | null = null;
  let artifactPathExists: boolean | null = null;
  let artifactPathIsFile: boolean | null = null;
  let gitDiffAvailable: boolean | null = null;
  let currentBranch: string | null = null;

  if (repoRoot) {
    try {
      repoRootExists = await deps.checkPathExists(repoRoot);
      if (!repoRootExists) {
        warnings.push(`Repository root does not exist on disk: ${repoRoot}`);
      }
    } catch {
      warnings.push(`Could not verify repository root on disk: ${repoRoot}`);
    }
  }

  if (artifactPath) {
    try {
      artifactPathExists = await deps.checkPathExists(artifactPath);
      if (!artifactPathExists) {
        warnings.push(`Artifact file does not exist on disk: ${artifactPath}`);
      }
    } catch {
      warnings.push(`Could not verify artifact path on disk: ${artifactPath}`);
    }

    if (artifactPathExists) {
      try {
        await deps.readFileContent(artifactPath);
        artifactPathIsFile = true;
      } catch {
        artifactPathIsFile = false;
        warnings.push(`Artifact path is not a readable file: ${artifactPath}`);
      }
    }
  }

  if (repoRoot && repoRootExists !== false) {
    try {
      const gitCtx = await deps.collectGitReviewContext(repoRoot);
      gitDiffAvailable = true;
      currentBranch = gitCtx.currentBranch?.trim() || null;
    } catch {
      gitDiffAvailable = false;
      warnings.push(`Git diff is not available for repository root: ${repoRoot}`);
    }
  }

  return {
    repoRoot,
    artifactPath,
    repoRootExists,
    artifactPathExists,
    artifactPathIsFile,
    gitDiffAvailable,
    currentBranch,
    warnings,
  };
}