import { describe, it, expect } from 'vitest';
import { appendActivityNote, formatTaskActivityNote, isTaskActivityLine } from './taskActivityFormatter';

describe('taskActivityFormatter — Deployment & Testing markers', () => {
  it('formats a UI-recorded manual deployment confirmation as a neutral Czech message', () => {
    const note = appendActivityNote(undefined, 'UI: manual-deployment-deployed');
    expect(isTaskActivityLine(note)).toBe(true);
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Manuální nasazení potvrzeno.');
    expect(formatted.source).toBe('Deployment');
  });

  it('formats a UI-recorded manual deployment failure', () => {
    const note = appendActivityNote(undefined, 'UI: manual-deployment-failed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Manuální nasazení selhalo.');
  });

  it('formats a UI-recorded manual deployment not-needed override', () => {
    const note = appendActivityNote(undefined, 'UI: manual-deployment-not-needed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Manuální nasazení označeno jako nepotřebné.');
  });

  it('formats a UI-recorded manual deployment reset', () => {
    const note = appendActivityNote(undefined, 'UI: manual-deployment-reset');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Resetován záznam manuálního nasazení.');
  });

  it('formats an MCP-recorded manual deployment confirmation identically in meaning, tagged as MCP', () => {
    const note = appendActivityNote(undefined, 'MCP local write: record_manual_deployment -> deployed');
    expect(isTaskActivityLine(note)).toBe(true);
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Manuální nasazení potvrzeno.');
    expect(formatted.source).toBe('MCP / Deployment');
  });

  it('formats a UI-recorded deployment test passed confirmation', () => {
    const note = appendActivityNote(undefined, 'UI: deployment-test-passed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Test nasazení potvrzen jako úspěšný.');
    expect(formatted.source).toBe('Deployment');
  });

  it('formats a UI-recorded deployment test failure', () => {
    const note = appendActivityNote(undefined, 'UI: deployment-test-failed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Test nasazení neprošel.');
  });

  it('formats a UI-recorded deployment test not-needed override', () => {
    const note = appendActivityNote(undefined, 'UI: deployment-test-not-needed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Test nasazení označen jako nepotřebný.');
  });

  it('formats a UI-recorded deployment test reset', () => {
    const note = appendActivityNote(undefined, 'UI: deployment-test-reset');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Resetován záznam testu nasazení.');
  });

  it('formats an MCP-recorded deployment test result, tagged as MCP', () => {
    const note = appendActivityNote(undefined, 'MCP local write: record_deployment_test -> passed');
    const formatted = formatTaskActivityNote(note);
    expect(formatted.message).toBe('Test nasazení potvrzen jako úspěšný.');
    expect(formatted.source).toBe('MCP / Deployment');
  });

  it('does not misclassify an unrelated note as a deployment/test marker', () => {
    const note = appendActivityNote(undefined, 'User note: deployed the fix to a colleague.');
    expect(isTaskActivityLine(note)).toBe(false);
  });
});
