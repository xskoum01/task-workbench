import { describe, expect, it, vi } from 'vitest';
import { prepareImplementInput, isScriptCreateMode } from './aiKitImplementMode';

describe('prepareImplementInput', () => {
  it('script create allows missing artifact file and returns empty content', async () => {
    const result = await prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/repo/Scripts/new_script.js',
        repoRoot: 'C:/repo',
        aiKitPath: 'C:/ai-kit',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent: vi.fn(),
      },
    );

    expect(result.isCreateMode).toBe(true);
    expect(result.currentContent).toBe('');
    expect(result.artifactPath).toBe('C:/repo/Scripts/new_script.js');
  });

  it('script update blocks missing artifact file', async () => {
    await expect(() => prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'update',
        artifactPath: 'C:/repo/Scripts/existing_script.js',
        repoRoot: 'C:/repo',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent: vi.fn(),
      },
    )).rejects.toThrow(/Target file not found/);
  });

  it('create mode still blocks artifact outside repo', async () => {
    await expect(() => prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/outside/new_script.js',
        repoRoot: 'C:/repo',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent: vi.fn(),
      },
    )).rejects.toThrow(/outside the repository root/i);
  });

  it('create mode still blocks artifact inside AI Kit repo', async () => {
    await expect(() => prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/ai-kit/rules/new_script.js',
        repoRoot: 'C:/repo',
        aiKitPath: 'C:/ai-kit',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent: vi.fn(),
      },
    )).rejects.toThrow(/AI Kit is read-only/i);
  });

  it('implement in create mode does not require existing file content', async () => {
    const readFileContent = vi.fn();
    await prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/repo/Scripts/new_script.js',
        repoRoot: 'C:/repo',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent,
      },
    );

    expect(readFileContent).not.toHaveBeenCalled();
  });

  it('create mode with missing file returns empty currentContent — no scaffold pre-written', async () => {
    // "Create + Implement with AI Kit" must not write any file before the user clicks Apply.
    // prepareImplementInput returns currentContent = '' so the AI generates from scratch.
    // File creation happens only in AiKitActionsPanel.applyImplementation after user confirms.
    const saveGeneratedFileMock = vi.fn();  // should never be called by prepareImplementInput
    const result = await prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/repo/Scripts/nvr_account.js',
        repoRoot: 'C:/repo',
        aiKitPath: 'C:/ai-kit',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(false),
        readFileContent: vi.fn(),
      },
    );

    expect(result.currentContent).toBe('');
    expect(result.isCreateMode).toBe(true);
    expect(saveGeneratedFileMock).not.toHaveBeenCalled();
  });

  it('create mode with existing file reads content and retains isCreateMode', async () => {
    // If "Create Script File" was already run, the file exists. AI should update it, not start blank.
    const result = await prepareImplementInput(
      {
        taskKind: 'script',
        workIntent: 'create',
        artifactPath: 'C:/repo/Scripts/nvr_account.js',
        repoRoot: 'C:/repo',
      },
      {
        checkPathExists: vi.fn().mockResolvedValue(true),
        readFileContent: vi.fn().mockResolvedValue('/** existing */\n'),
      },
    );

    expect(result.isCreateMode).toBe(true);
    expect(result.currentContent).toBe('/** existing */\n');
  });
});

describe('isScriptCreateMode', () => {
  it('returns true only for script + create', () => {
    expect(isScriptCreateMode({ taskKind: 'script', workIntent: 'create' })).toBe(true);
  });

  it('returns false for script + update', () => {
    expect(isScriptCreateMode({ taskKind: 'script', workIntent: 'update' })).toBe(false);
  });

  it('returns false for plugin + create', () => {
    expect(isScriptCreateMode({ taskKind: 'plugin', workIntent: 'create' })).toBe(false);
  });

  it('returns false when workIntent is undefined', () => {
    expect(isScriptCreateMode({ taskKind: 'script', workIntent: undefined })).toBe(false);
  });
});
