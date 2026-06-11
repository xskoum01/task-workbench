import { describe, expect, it } from 'vitest';
import {
  assembleMarkdownForPrompt,
  buildCriticalAiKitRules,
  buildImplementInstructions,
  buildDiffReviewInstructions,
  type PowerPlatformAiKitContext,
} from './powerPlatformAiKit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PowerPlatformAiKitContext> = {}): PowerPlatformAiKitContext {
  return {
    kitPath: 'C:/ai-kit',
    taskKind: 'script',
    agentInstructions: '## Agents\nBe helpful.\n',
    taskRules: '## Rules\nFollow rules.\n',
    reviewRules: '## PR Review Comments\nPR-001: some issue.\n',
    checklist: '## Checklist\n- Item 1\n- Item 2\n',
    implementPromptTemplate: '## Implement template\nGenerate code.\n',
    reviewPromptTemplate: '## Review template\nReview code.\n',
    loadedFiles: ['AGENTS.md', 'ai-rules/crm-javascript-rules.md', 'ai-rules/known-pr-review-comments.md', 'ai-rules/crm-code-review-checklist.md', 'prompts/pp-implement-crm-task.md'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assembleMarkdownForPrompt
// ---------------------------------------------------------------------------

describe('assembleMarkdownForPrompt', () => {
  it('returns content unchanged when within maxChars', () => {
    const content = '## Section\nSome text.';
    expect(assembleMarkdownForPrompt(content, 10000)).toBe(content);
  });

  it('returns empty string for empty input', () => {
    expect(assembleMarkdownForPrompt('', 1000)).toBe('');
  });

  it('truncates non-critical sections when over budget', () => {
    const content = '## Intro\n' + 'x'.repeat(500) + '\n## Another\n' + 'y'.repeat(500);
    const result = assembleMarkdownForPrompt(content, 300);
    expect(result.length).toBeLessThanOrEqual(600); // budget + truncation note
    expect(result).toContain('[AI Kit assembler');
  });

  it('preserves critical section (early return) that appears late in file', () => {
    const nonCritical = '## Introduction\n' + 'a'.repeat(3000) + '\n';
    const critical = '## Early return policy\nDo not use return; as a guard clause.\n';
    const content = nonCritical + critical;
    // Use a budget that fits the non-critical section but not the critical one.
    // nonCritical section text ≈ nonCritical.length chars; critical section ≈ 62 chars.
    // Adding just 10 chars leaves too little room for the critical section.
    const result = assembleMarkdownForPrompt(content, nonCritical.length + 10);
    expect(result).toContain('Early return policy');
    expect(result).toContain('Do not use return; as a guard clause.');
    expect(result).toContain('AI Kit assembler');
    expect(result).toContain('critical section');
  });

  it('preserves single return section even when it appears after the budget', () => {
    const padding = '## Padding\n' + 'b'.repeat(4000) + '\n';
    const critical = '## Single return per function\nOne exit point rule.\n';
    const content = padding + critical;
    const result = assembleMarkdownForPrompt(content, 2000);
    expect(result).toContain('Single return per function');
    expect(result).toContain('One exit point rule.');
  });

  it('preserves mandatory section that appears after the budget', () => {
    const padding = '## Overview\n' + 'c'.repeat(3000) + '\n';
    const critical = '## Mandatory constraints\nDo not do X.\n';
    const content = padding + critical;
    const result = assembleMarkdownForPrompt(content, 2000);
    expect(result).toContain('Mandatory constraints');
  });

  it('non-critical sections beyond budget are dropped without error', () => {
    const s1 = '## Section 1\n' + 'd'.repeat(300);
    const s2 = '## Section 2\n' + 'e'.repeat(300);
    const s3 = '## Section 3\n' + 'f'.repeat(300);
    const content = [s1, s2, s3].join('\n\n');
    const result = assembleMarkdownForPrompt(content, 400);
    expect(result).toContain('Section 1');
    // Section 2 may or may not fit, but no crash
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildCriticalAiKitRules
// ---------------------------------------------------------------------------

describe('buildCriticalAiKitRules — script task', () => {
  it('includes no early return rule', () => {
    const rules = buildCriticalAiKitRules('script');
    expect(rules).toMatch(/early return/i);
    expect(rules).toMatch(/return;/);
  });

  it('includes single return per function rule', () => {
    const rules = buildCriticalAiKitRules('script');
    expect(rules).toMatch(/single return/i);
  });

  it('includes do not silently return when CRM attrs missing', () => {
    const rules = buildCriticalAiKitRules('script');
    expect(rules).toMatch(/getAttribute|getControl/i);
  });

  it('includes preserve existing file style / no namespace rule', () => {
    const rules = buildCriticalAiKitRules('script');
    expect(rules).toMatch(/namespace|IIFE|wrapper|class|module/i);
    expect(rules).toMatch(/preserve|existing.*style|style.*existing/i);
  });

  it('includes use exact names rule', () => {
    const rules = buildCriticalAiKitRules('script');
    expect(rules).toMatch(/exact.*name|name.*exact/i);
  });
});

describe('buildCriticalAiKitRules — plugin task', () => {
  it('includes no early return rule', () => {
    const rules = buildCriticalAiKitRules('plugin');
    expect(rules).toMatch(/early return/i);
  });

  it('includes no over-guarding rule', () => {
    const rules = buildCriticalAiKitRules('plugin');
    expect(rules).toMatch(/over-guard|over guard/i);
  });

  it('includes no invented metadata rule', () => {
    const rules = buildCriticalAiKitRules('plugin');
    expect(rules).toMatch(/invent/i);
  });

  it('includes no placeholders/TODOs rule', () => {
    const rules = buildCriticalAiKitRules('plugin');
    expect(rules).toMatch(/placeholder|TODO/i);
  });

  it('includes preserve project/class style rule', () => {
    const rules = buildCriticalAiKitRules('plugin');
    expect(rules).toMatch(/namespace|class|project.*style|style.*project/i);
  });
});

// ---------------------------------------------------------------------------
// buildImplementInstructions
// ---------------------------------------------------------------------------

describe('buildImplementInstructions', () => {
  it('includes MANDATORY CONSTRAINTS section', () => {
    const result = buildImplementInstructions(makeCtx());
    expect(result).toContain('## MANDATORY CONSTRAINTS');
  });

  it('includes CRITICAL AI KIT RULES section', () => {
    const result = buildImplementInstructions(makeCtx());
    expect(result).toContain('## CRITICAL AI KIT RULES');
  });

  it('includes KNOWN PR REVIEW COMMENTS section when reviewRules are present', () => {
    const result = buildImplementInstructions(makeCtx({ reviewRules: 'PR-005: Early return guard clause.' }));
    expect(result).toContain('KNOWN PR REVIEW COMMENTS');
    expect(result).toContain('PR-005');
  });

  it('includes CRM CODE REVIEW CHECKLIST when checklist is present', () => {
    const result = buildImplementInstructions(makeCtx({ checklist: '- No early returns\n' }));
    expect(result).toContain('CRM CODE REVIEW CHECKLIST');
    expect(result).toContain('No early returns');
  });

  it('includes IMPLEMENTATION PROMPT TEMPLATE when present', () => {
    const result = buildImplementInstructions(makeCtx({ implementPromptTemplate: 'Use positive branching.' }));
    expect(result).toContain('IMPLEMENTATION PROMPT TEMPLATE');
    expect(result).toContain('Use positive branching.');
  });

  it('includes early-return rule in script task even when taskRules has it late in the content', () => {
    const taskRules =
      '## Introduction\n' + 'intro text\n'.repeat(50) +
      '## Naming\n' + 'naming rules\n'.repeat(50) +
      '## Early return policy\nDo not use early returns.\n';
    const result = buildImplementInstructions(makeCtx({ taskRules }));
    // Critical rules block always contains early return guidance
    expect(result).toContain('CRITICAL AI KIT RULES');
    expect(result).toMatch(/early return/i);
  });

  it('script task prompt includes no namespace / no wrapper rules in critical block', () => {
    const result = buildImplementInstructions(makeCtx({ taskKind: 'script' }));
    expect(result).toMatch(/namespace|IIFE|wrapper/i);
  });

  it('plugin task prompt includes no over-guarding and no invented metadata rules', () => {
    const ctx = makeCtx({ taskKind: 'plugin' });
    const result = buildImplementInstructions(ctx);
    expect(result).toMatch(/over-guard|over guard/i);
    expect(result).toMatch(/invent/i);
  });

  it('includes VIOLATION FEEDBACK section when violationFeedback is provided', () => {
    const feedback = 'Your previous output had `return;` at line 5.';
    const result = buildImplementInstructions(makeCtx(), { violationFeedback: feedback });
    expect(result).toContain('VIOLATION FEEDBACK FROM PREVIOUS GENERATION');
    expect(result).toContain('return;');
  });

  it('does not include VIOLATION FEEDBACK section when not provided', () => {
    const result = buildImplementInstructions(makeCtx());
    expect(result).not.toContain('VIOLATION FEEDBACK');
  });

  it('create mode includes create-mode instruction', () => {
    const result = buildImplementInstructions(makeCtx(), { createMode: true });
    expect(result).toMatch(/create mode/i);
  });

  it('sections appear in correct order: MANDATORY → CLARIFICATION POLICY → CRITICAL → AGENTS → TASK-KIND → PR COMMENTS → CHECKLIST', () => {
    const result = buildImplementInstructions(makeCtx());
    const mandatoryPos       = result.indexOf('MANDATORY CONSTRAINTS');
    const clarificationPos   = result.indexOf('CLARIFICATION POLICY');
    const criticalPos        = result.indexOf('CRITICAL AI KIT RULES');
    const agentsPos          = result.indexOf('AGENT INSTRUCTIONS');
    const taskRulesPos       = result.indexOf('TASK-KIND RULES');
    const prCommentsPos      = result.indexOf('KNOWN PR REVIEW COMMENTS');
    const checklistPos       = result.indexOf('CRM CODE REVIEW CHECKLIST');

    expect(mandatoryPos).toBeLessThan(clarificationPos);
    expect(clarificationPos).toBeLessThan(criticalPos);
    expect(criticalPos).toBeLessThan(agentsPos);
    expect(agentsPos).toBeLessThan(taskRulesPos);
    expect(taskRulesPos).toBeLessThan(prCommentsPos);
    expect(prCommentsPos).toBeLessThan(checklistPos);
  });

  it('does not use blind slice — critical content in taskRules survives', () => {
    // Pad taskRules so the critical section appears well past the old 4000-char limit
    const padding = '## Style guide\n' + 'style rules line\n'.repeat(300);
    const critical = '## Early return policy\nNever use return; as guard clause.\n';
    const taskRules = padding + critical;
    const result = buildImplementInstructions(makeCtx({ taskRules }));
    expect(result).toContain('Early return policy');
    expect(result).toContain('Never use return; as guard clause.');
  });

  it('includes OUTPUT FORMAT schema', () => {
    const result = buildImplementInstructions(makeCtx());
    expect(result).toContain('OUTPUT FORMAT');
    expect(result).toContain('proposedContent');
    expect(result).toContain('clarificationNeeded');
  });

  // ── Clarification policy tests ──────────────────────────────────────────────

  it('includes CLARIFICATION POLICY section', () => {
    const result = buildImplementInstructions(makeCtx());
    expect(result).toContain('## CLARIFICATION POLICY');
  });

  it('CLARIFICATION POLICY lists Dataverse verification failure as a reason NOT to set clarificationNeeded', () => {
    const result = buildImplementInstructions(makeCtx());
    const policyStart = result.indexOf('## CLARIFICATION POLICY');
    const nextSection = result.indexOf('\n## ', policyStart + 1);
    const policyBlock = result.slice(policyStart, nextSection > -1 ? nextSection : undefined);
    expect(policyBlock).toMatch(/Do NOT set clarificationNeeded/);
    expect(policyBlock).toContain('Failed or missing Dataverse metadata verification');
  });

  it('CLARIFICATION POLICY says field names not confirmed in Dataverse schema must not trigger clarificationNeeded', () => {
    const result = buildImplementInstructions(makeCtx());
    const policyStart = result.indexOf('## CLARIFICATION POLICY');
    const nextSection = result.indexOf('\n## ', policyStart + 1);
    const policyBlock = result.slice(policyStart, nextSection > -1 ? nextSection : undefined);
    expect(policyBlock).toContain('Field names from the task assignment that were not confirmed in Dataverse schema');
  });

  it('CLARIFICATION POLICY instructs to list unconfirmed metadata in risks or testScenarios', () => {
    const result = buildImplementInstructions(makeCtx());
    const policyStart = result.indexOf('## CLARIFICATION POLICY');
    const nextSection = result.indexOf('\n## ', policyStart + 1);
    const policyBlock = result.slice(policyStart, nextSection > -1 ? nextSection : undefined);
    expect(policyBlock).toMatch(/risks or testScenarios/);
    expect(policyBlock).toContain('Metadata not confirmed');
  });

  it('OUTPUT FORMAT clarificationNeeded description does not say to use it for missing Dataverse metadata', () => {
    const result = buildImplementInstructions(makeCtx());
    const outputFormatStart = result.indexOf('OUTPUT FORMAT');
    const outputFormatBlock = result.slice(outputFormatStart);
    const clarificationLine = outputFormatBlock
      .split('\n')
      .find((l) => l.includes('"clarificationNeeded":') && l.includes('<'));
    expect(clarificationLine).toBeDefined();
    // Must say "Do NOT set for failed/missing Dataverse verification"
    expect(clarificationLine).toMatch(/Do NOT set for failed/i);
    // Must NOT tell AI to put missing Dataverse metadata here
    expect(clarificationLine).not.toMatch(/missing Dataverse metadata.*trigger|missing metadata.*clarification/i);
  });

  it('script task CRITICAL AI KIT RULES say to use exact field names and add to risks — not set clarificationNeeded', () => {
    const result = buildImplementInstructions(makeCtx({ taskKind: 'script' }));
    const criticalStart = result.indexOf('## CRITICAL AI KIT RULES');
    const nextSection = result.indexOf('\n## ', criticalStart + 1);
    const criticalBlock = result.slice(criticalStart, nextSection > -1 ? nextSection : undefined);
    // Must say to use exact name from task
    expect(criticalBlock).toMatch(/exact name from the task/);
    // Must say to add to risks or testScenarios
    expect(criticalBlock).toMatch(/risks or testScenarios/);
    // Must explicitly say NOT to set clarificationNeeded for this
    expect(criticalBlock).toMatch(/do NOT set clarificationNeeded for this/);
  });

  it('plugin task CRITICAL AI KIT RULES say to use exact names and add to risks — not set clarificationNeeded', () => {
    const result = buildImplementInstructions(makeCtx({ taskKind: 'plugin' }));
    const criticalStart = result.indexOf('## CRITICAL AI KIT RULES');
    const nextSection = result.indexOf('\n## ', criticalStart + 1);
    const criticalBlock = result.slice(criticalStart, nextSection > -1 ? nextSection : undefined);
    // Must say to add to risks or testScenarios
    expect(criticalBlock).toMatch(/risks or testScenarios/);
    // Must explicitly say NOT to set clarificationNeeded for unconfirmed metadata
    expect(criticalBlock).toMatch(/do NOT set clarificationNeeded for unconfirmed metadata/i);
    // Must NOT say "set clarificationNeeded instead" in context of missing metadata
    expect(criticalBlock).not.toMatch(/needs missing metadata.*clarificationNeeded|metadata.*set clarificationNeeded instead/);
  });

  it('MANDATORY CONSTRAINTS do not instruct to set clarificationNeeded for missing metadata', () => {
    const result = buildImplementInstructions(makeCtx());
    const mandatoryStart = result.indexOf('## MANDATORY CONSTRAINTS');
    const nextSection = result.indexOf('\n## ', mandatoryStart + 1);
    const mandatoryBlock = result.slice(mandatoryStart, nextSection > -1 ? nextSection : undefined);
    // Must NOT say "set clarificationNeeded" in the MANDATORY CONSTRAINTS section
    expect(mandatoryBlock).not.toMatch(/set clarificationNeeded instead/);
  });
});

// ---------------------------------------------------------------------------
// buildDiffReviewInstructions — regression: still loads all files
// ---------------------------------------------------------------------------

describe('buildDiffReviewInstructions', () => {
  it('includes CRM development rules', () => {
    const result = buildDiffReviewInstructions(makeCtx());
    expect(result).toContain('CRM DEVELOPMENT RULES');
  });

  it('includes known PR review comments', () => {
    const result = buildDiffReviewInstructions(makeCtx({ reviewRules: 'PR-001: something.\n' }));
    expect(result).toContain('KNOWN PR REVIEW COMMENTS');
    expect(result).toContain('PR-001');
  });

  it('includes checklist', () => {
    const result = buildDiffReviewInstructions(makeCtx({ checklist: 'checklist item A' }));
    expect(result).toContain('CRM CODE REVIEW CHECKLIST');
    expect(result).toContain('checklist item A');
  });
});
