import { describe, expect, it } from 'vitest';
import { isPathInsideDir, isAbsolutePath } from './pathUtils';

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

describe('isAbsolutePath', () => {
  // --- Windows absolute ---
  it('Windows drive letter with backslash is absolute', () => {
    expect(isAbsolutePath('C:\\Users\\dev\\repo')).toBe(true);
  });

  it('Windows drive letter with forward slash is absolute', () => {
    expect(isAbsolutePath('C:/Users/dev/repo')).toBe(true);
  });

  it('Windows drive letter uppercase is absolute', () => {
    expect(isAbsolutePath('D:/CRM/VSK-Test')).toBe(true);
  });

  it('Windows drive letter lowercase is absolute', () => {
    expect(isAbsolutePath('c:/repos/customer')).toBe(true);
  });

  // --- UNC paths ---
  it('UNC path with backslashes is absolute', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('UNC path with forward slashes is absolute', () => {
    expect(isAbsolutePath('//server/share')).toBe(true);
  });

  // --- Unix absolute ---
  it('Unix path starting with / is absolute', () => {
    expect(isAbsolutePath('/home/user/repo')).toBe(true);
  });

  it('Unix root / is absolute', () => {
    expect(isAbsolutePath('/')).toBe(true);
  });

  // --- Relative paths ---
  it('bare folder name is relative', () => {
    expect(isAbsolutePath('VSK-Test')).toBe(false);
  });

  it('relative path with subdirectories is relative', () => {
    expect(isAbsolutePath('CRM/VSK-Test')).toBe(false);
  });

  it('relative path with backslash is relative', () => {
    expect(isAbsolutePath('relative\\path')).toBe(false);
  });

  it('empty string is relative', () => {
    expect(isAbsolutePath('')).toBe(false);
  });

  it('whitespace-only string is relative', () => {
    expect(isAbsolutePath('   ')).toBe(false);
  });

  it('dot-relative path is relative', () => {
    expect(isAbsolutePath('./local/path')).toBe(false);
  });

  it('parent-relative path is relative', () => {
    expect(isAbsolutePath('../sibling/path')).toBe(false);
  });
});
