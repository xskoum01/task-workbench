import { describe, expect, it } from 'vitest';
import { isPathInsideDir } from './pathUtils';

describe('isPathInsideDir', () => {
  it('file at repo root level is inside repo', () => {
    expect(isPathInsideDir('C:/repo/file.cs', 'C:/repo')).toBe(true);
  });

  it('file in subdirectory is inside repo', () => {
    expect(isPathInsideDir('C:/repo/sub/file.cs', 'C:/repo')).toBe(true);
  });

  it('deeply nested file is inside repo', () => {
    expect(isPathInsideDir('C:/repo/Plugins/ProjectA/ProjectA/ProjectA.cs', 'C:/repo')).toBe(true);
  });

  it('repo-extra prefix does not match repo', () => {
    expect(isPathInsideDir('C:/repo-extra/file.cs', 'C:/repo')).toBe(false);
  });

  it('repo2 prefix does not match repo', () => {
    expect(isPathInsideDir('C:/repo2/file.cs', 'C:/repo')).toBe(false);
  });

  it('sibling directory does not match', () => {
    expect(isPathInsideDir('C:/repox/file.cs', 'C:/repo')).toBe(false);
  });

  it('backslash paths (Windows-style) are normalised', () => {
    expect(isPathInsideDir('C:\\repo\\sub\\file.cs', 'C:\\repo')).toBe(true);
  });

  it('mixed backslash and forward slash paths', () => {
    expect(isPathInsideDir('C:\\repo\\file.cs', 'C:/repo')).toBe(true);
  });

  it('trailing slash on dirPath is stripped', () => {
    expect(isPathInsideDir('C:/repo/file.cs', 'C:/repo/')).toBe(true);
  });

  it('trailing slash on both', () => {
    expect(isPathInsideDir('C:/repo/sub/', 'C:/repo/')).toBe(true);
  });

  it('comparison is case-insensitive', () => {
    expect(isPathInsideDir('C:/Repo/Sub/File.cs', 'c:/repo')).toBe(true);
  });

  it('exact match of file and dir paths returns true', () => {
    expect(isPathInsideDir('C:/repo', 'C:/repo')).toBe(true);
  });

  it('file outside repo root is false', () => {
    expect(isPathInsideDir('C:/other/file.cs', 'C:/repo')).toBe(false);
  });

  it('AI Kit path does not match customer repo', () => {
    expect(isPathInsideDir(
      'C:/repos/power-platform-ai-kit/ai-rules/crm-plugin-rules.md',
      'C:/repos/customer-repo',
    )).toBe(false);
  });

  it('customer file does not match AI Kit path', () => {
    expect(isPathInsideDir(
      'C:/repos/customer-repo/Plugins/Plugin.cs',
      'C:/repos/power-platform-ai-kit',
    )).toBe(false);
  });
});
