import { describe, expect, it } from 'vitest';
import { buildScriptScaffold } from './scriptScaffold';

describe('buildScriptScaffold', () => {
  it('contains no TODO comment', () => {
    expect(buildScriptScaffold()).not.toMatch(/TODO/i);
  });

  it('contains no IIFE wrapper', () => {
    const content = buildScriptScaffold();
    expect(content).not.toMatch(/\(function\s*\(/);
    expect(content).not.toMatch(/\(\s*\(\s*\)\s*=>/);
  });

  it('contains no placeholder or stub comment', () => {
    const content = buildScriptScaffold();
    expect(content).not.toMatch(/placeholder|stub|implement/i);
  });

  it('does not wrap in namespace, class, or module', () => {
    const content = buildScriptScaffold();
    expect(content).not.toMatch(/^\s*(namespace|class|module)\s/m);
  });

  it('produces valid non-empty content', () => {
    const content = buildScriptScaffold();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});
