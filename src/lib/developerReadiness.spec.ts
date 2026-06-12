import { describe, it, expect } from 'vitest';
import { getDeveloperReadiness } from './developerReadiness';
import type { Task, CrmVerificationReport } from '../types';

// Minimal task with no developer setup
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: '[TEST] Task',
    status: 'in-progress',
    customerId: 'customer-acme',
    ...overrides,
  } as unknown as Task;
}

// Fully ready plugin task
function makeReadyPluginTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: {
      devTargetKind: 'plugin',
      repositoryRoot: 'C:/repos/CrmPlugins',
      pluginProject: 'Acme.Plugins',
      primaryEntityLogicalName: 'account',
      confirmedAt: '2026-06-01T10:00:00.000Z',
    },
    crmDeveloperWorkflow: {
      detectedWorkKind: 'plugin',
      technicalPlan: {
        generatedAt: '2026-06-01T10:00:00.000Z',
        workKind: 'plugin',
        summary: 'Implement account create plugin.',
        target: {
          entityLogicalName: 'account',
          message: 'Create',
          stage: 'PreOperation',
          mode: 'Sync',
          pluginProject: 'Acme.Plugins',
        },
        implementationSteps: ['Step 1'],
        dataverseFindings: [],
        risks: [],
        testChecklist: [],
      },
    },
    crmVerificationReports: [{ verdict: 'pass', summary: 'All clear.' }] as CrmVerificationReport[],
    ...overrides,
  });
}

// Fully ready script task
function makeReadyScriptTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: {
      devTargetKind: 'script',
      repositoryRoot: 'C:/repos/CrmScripts',
      scriptPath: 'src/scripts/account_form.js',
      primaryEntityLogicalName: 'account',
      confirmedAt: '2026-06-01T10:00:00.000Z',
    },
    crmDeveloperWorkflow: {
      detectedWorkKind: 'script',
      technicalPlan: {
        generatedAt: '2026-06-01T10:00:00.000Z',
        workKind: 'script',
        summary: 'Extend account form script.',
        target: {
          entityLogicalName: 'account',
          scriptPath: 'src/scripts/account_form.js',
          formName: 'Account Main Form',
          eventName: 'OnLoad',
          functionName: 'onAccountLoad',
        },
        implementationSteps: ['Step 1'],
        dataverseFindings: [],
        risks: [],
        testChecklist: [],
      },
    },
    crmVerificationReports: [{ verdict: 'pass', summary: 'All clear.' }] as CrmVerificationReport[],
    ...overrides,
  });
}

describe('getDeveloperReadiness — mode gate', () => {
  it('blocks when taskMode is not developer', () => {
    const r = getDeveloperReadiness(makeTask());
    expect(r.isReady).toBe(false);
    expect(r.blockers).toContain('Task mode is not set to Developer.');
    expect(r.blockers).toHaveLength(1);
  });

  it('blocks when taskMode is general', () => {
    const r = getDeveloperReadiness(makeTask({ taskMode: 'general' }));
    expect(r.isReady).toBe(false);
    expect(r.blockers[0]).toContain('Task mode is not set to Developer.');
  });
});

describe('getDeveloperReadiness — work kind gate', () => {
  it('blocks when work kind is missing', () => {
    const r = getDeveloperReadiness(makeTask({ taskMode: 'developer' }));
    expect(r.isReady).toBe(false);
    expect(r.blockers[0]).toContain('Work kind must be plugin or script.');
  });

  it('blocks when work kind is unknown', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      crmDeveloperWorkflow: { detectedWorkKind: 'unknown' },
    }));
    expect(r.blockers[0]).toContain('Work kind must be plugin or script.');
  });

  it('blocks when devTargetKind is repo', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'repo' },
    }));
    expect(r.blockers[0]).toContain('Work kind must be plugin or script.');
  });

  it('passes work kind gate for detectedWorkKind=plugin', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin' },
    }));
    expect(r.blockers[0]).not.toContain('Work kind');
  });

  it('passes work kind gate for devTargetKind=script', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script' },
    }));
    expect(r.blockers[0]).not.toContain('Work kind');
  });

  it('passes work kind gate for detectedWorkKind=ribbon', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      crmDeveloperWorkflow: { detectedWorkKind: 'ribbon' },
    }));
    expect(r.blockers[0]).not.toContain('Work kind');
  });
});

describe('getDeveloperReadiness — common checks', () => {
  it('blocks when customer is missing', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      customerId: undefined,
      workflowSetup: { devTargetKind: 'plugin' },
    }));
    expect(r.blockers).toContain('Customer/environment is not set.');
  });

  it('accepts customer from workflowSetup.customerId fallback', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      customerId: undefined,
      workflowSetup: { devTargetKind: 'plugin', customerId: 'fallback-customer' },
    }));
    expect(r.blockers).not.toContain('Customer/environment is not set.');
  });

  it('blocks when repository root is not set', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, repositoryRoot: undefined },
    }));
    expect(r.blockers).toContain('Repository root is not set.');
  });

  it('blocks when setup has not been confirmed', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, confirmedAt: undefined },
    }));
    expect(r.blockers).toContain('Developer setup has not been confirmed.');
  });

  it('blocks when technical plan is missing', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin', technicalPlan: undefined },
    }));
    expect(r.blockers).toContain('Technical implementation plan is missing.');
  });

  it('blocks when Dataverse verification has not run', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: undefined,
    }));
    expect(r.blockers).toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
  });

  it('accepts verdict=warnings as completed verification', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: [{ verdict: 'warnings' }] as CrmVerificationReport[],
    }));
    expect(r.blockers).not.toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
    expect(r.warnings.some(w => w.includes('warnings'))).toBe(true);
  });

  it('accepts verdict=fail as completed verification, adds warning', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: [{ verdict: 'fail' }] as CrmVerificationReport[],
    }));
    expect(r.blockers).not.toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
    expect(r.warnings.some(w => w.includes('issues'))).toBe(true);
  });

  it('accepts verification skipped via skippedAt', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: undefined,
      implementationVerification: {
        dataverseCheck: { status: 'skipped', skippedAt: '2026-06-01T00:00:00.000Z', skippedReason: 'not applicable' },
      },
    }));
    expect(r.blockers).not.toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
  });

  it('accepts verification manually overridden', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: undefined,
      implementationVerification: {
        dataverseCheck: { status: 'manually-verified', manuallyVerifiedAt: '2026-06-01T00:00:00.000Z' },
      },
    }));
    expect(r.blockers).not.toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
  });
});

describe('getDeveloperReadiness — plugin-specific checks', () => {
  it('is fully ready for a complete plugin task', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask());
    expect(r.isReady).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it('blocks when plugin project is not selected', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, pluginProject: undefined },
      crmDeveloperWorkflow: {
        ...makeReadyPluginTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyPluginTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyPluginTask().crmDeveloperWorkflow!.technicalPlan!.target, pluginProject: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Plugin project is not selected.');
  });

  it('accepts pluginProject from technicalPlan.target fallback', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, pluginProject: undefined },
    }));
    // plan.target.pluginProject = 'Acme.Plugins' is still set → should pass
    expect(r.blockers).not.toContain('Plugin project is not selected.');
  });

  it('blocks when target entity logical name is missing', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, primaryEntityLogicalName: undefined },
      crmDeveloperWorkflow: {
        ...makeReadyPluginTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyPluginTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyPluginTask().crmDeveloperWorkflow!.technicalPlan!.target, entityLogicalName: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Target entity logical name is not set.');
  });

  it('blocks when message is missing from technical plan', () => {
    const base = makeReadyPluginTask();
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: { ...base.crmDeveloperWorkflow!.technicalPlan!.target, message: undefined },
        },
      },
    }));
    expect(r.blockers.some(b => b.includes('Plugin registration') && b.includes('message'))).toBe(true);
  });

  it('blocks when stage and mode are missing from technical plan', () => {
    const base = makeReadyPluginTask();
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: { ...base.crmDeveloperWorkflow!.technicalPlan!.target, stage: undefined, mode: undefined },
        },
      },
    }));
    expect(r.blockers.some(b => b.includes('Plugin registration') && b.includes('stage') && b.includes('mode'))).toBe(true);
  });
});

describe('getDeveloperReadiness — script-specific checks', () => {
  it('is fully ready for a complete script task', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask());
    expect(r.isReady).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it('blocks when target script path is not set', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: { ...makeReadyScriptTask().workflowSetup, artifactPath: undefined, scriptPath: undefined },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Target script/artifact path is not set.');
  });

  it('accepts artifactPath as target', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: undefined,
        artifactPath: 'src/scripts/account_form.js',
      },
    }));
    expect(r.blockers).not.toContain('Target script/artifact path is not set.');
  });

  it('blocks when entity logical name is missing', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: { ...makeReadyScriptTask().workflowSetup, primaryEntityLogicalName: undefined },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, entityLogicalName: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Target entity logical name (table) is not set.');
  });

  it('blocks when form/event info is missing and not marked manual-later', () => {
    const base = makeReadyScriptTask();
    const r = getDeveloperReadiness(makeReadyScriptTask({
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: {
            ...base.crmDeveloperWorkflow!.technicalPlan!.target,
            formName: undefined,
            eventName: undefined,
            functionName: undefined,
          },
        },
      },
    }));
    expect(r.blockers).toContain('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
  });

  it('passes form/event check when eventName is set', () => {
    const base = makeReadyScriptTask();
    const r = getDeveloperReadiness(makeReadyScriptTask({
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: {
            entityLogicalName: 'account',
            scriptPath: 'src/scripts/account_form.js',
            eventName: 'OnLoad',
          },
        },
      },
    }));
    expect(r.blockers).not.toContain('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
  });

  it('passes form/event check when scriptFormRegistration is manual-later', () => {
    const base = makeReadyScriptTask();
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptFormRegistration: 'manual-later',
      },
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: {
            entityLogicalName: 'account',
            scriptPath: 'src/scripts/account_form.js',
            formName: undefined,
            eventName: undefined,
            functionName: undefined,
          },
        },
      },
    }));
    expect(r.blockers).not.toContain('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
  });
});

describe('getDeveloperReadiness — JS script detection warning', () => {
  it('adds warning and adjusted next step when title mentions JavaScript form script', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      title: 'Add JavaScript form script for account entity',
    }));
    expect(r.isReady).toBe(false);
    expect(r.blockers).toContain('Work kind must be plugin or script.');
    expect(r.warnings.some(w => w.includes('JavaScript/form scripts'))).toBe(true);
    expect(r.recommendedNextStep).toContain('script');
  });

  it('adds warning when originalMessage mentions form script', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      title: '[TEST] Some task',
      originalMessage: 'Please add a web resource form script for the contact form.',
    }));
    expect(r.warnings.some(w => w.includes('JavaScript/form scripts'))).toBe(true);
  });

  it('does not add JS warning when task text has no script indicators', () => {
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      title: 'Update plugin for account',
    }));
    expect(r.warnings).toHaveLength(0);
    expect(r.recommendedNextStep).toContain('Set work classification to plugin or script');
  });

  it('does not add JS warning when work kind is already set to plugin', () => {
    // JS detection only fires on the work kind gate failure path
    const r = getDeveloperReadiness(makeTask({
      taskMode: 'developer',
      title: 'Add JavaScript form script for account',
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin' },
    }));
    // Passes work kind gate as plugin; no JS-detection warning should appear
    expect(r.blockers[0]).not.toContain('Work kind must be plugin or script.');
  });
});

describe('getDeveloperReadiness — actionType: create-new-script', () => {
  it('passes when folder path + desiredScriptFile are set', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: 'src/scripts',
        artifactPath: undefined,
        actionType: 'create-new-script',
        desiredScriptFile: 'nvr_account_events.js',
      },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.blockers.some(b => b.includes('Script creation'))).toBe(false);
    expect(r.isReady).toBe(true);
  });

  it('passes when artifactPath is set (draft already applied)', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: undefined,
        artifactPath: 'C:/repos/scripts/nvr_account_events.js',
        actionType: 'create-new-script',
        desiredScriptFile: undefined,
      },
    }));
    expect(r.blockers.some(b => b.includes('Script creation'))).toBe(false);
  });

  it('blocks when folder path is set but desiredScriptFile is missing', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: 'src/scripts',
        artifactPath: undefined,
        actionType: 'create-new-script',
        desiredScriptFile: undefined,
      },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Script creation requires a known target directory and file name. Set script path and desired file name.');
  });

  it('recommendedNextStep points to setup for create blocker', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: 'src/scripts',
        artifactPath: undefined,
        actionType: 'create-new-script',
        desiredScriptFile: undefined,
      },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.recommendedNextStep).toContain('directory and file name');
  });
});

describe('getDeveloperReadiness — actionType: update-existing-script', () => {
  it('passes when scriptPath points to a specific .js file', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        actionType: 'update-existing-script',
      },
    }));
    // scriptPath is 'src/scripts/account_form.js' — a specific file
    expect(r.blockers.some(b => b.includes('Script update'))).toBe(false);
    expect(r.isReady).toBe(true);
  });

  it('passes when artifactPath is set', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: undefined,
        artifactPath: 'C:/repos/scripts/nvr_account_events.js',
        actionType: 'update-existing-script',
      },
    }));
    expect(r.blockers.some(b => b.includes('Script update'))).toBe(false);
  });

  it('blocks when scriptPath is a folder (not a specific file)', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: 'src/scripts',
        artifactPath: undefined,
        actionType: 'update-existing-script',
      },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.blockers).toContain('Script update requires a specific existing file path. Set script path to an existing .js file.');
  });

  it('recommendedNextStep points to setup for update blocker', () => {
    const r = getDeveloperReadiness(makeReadyScriptTask({
      workflowSetup: {
        ...makeReadyScriptTask().workflowSetup,
        scriptPath: 'src/scripts',
        artifactPath: undefined,
        actionType: 'update-existing-script',
      },
      crmDeveloperWorkflow: {
        ...makeReadyScriptTask().crmDeveloperWorkflow,
        technicalPlan: {
          ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!,
          target: { ...makeReadyScriptTask().crmDeveloperWorkflow!.technicalPlan!.target, scriptPath: undefined },
        },
      },
    }));
    expect(r.recommendedNextStep).toContain('existing script file path');
  });
});

describe('getDeveloperReadiness — eventFieldName satisfies form/event check', () => {
  it('passes form/event check when only eventFieldName is set', () => {
    const base = makeReadyScriptTask();
    const r = getDeveloperReadiness(makeReadyScriptTask({
      crmDeveloperWorkflow: {
        ...base.crmDeveloperWorkflow,
        technicalPlan: {
          ...base.crmDeveloperWorkflow!.technicalPlan!,
          target: {
            entityLogicalName: 'account',
            scriptPath: 'src/scripts/account_form.js',
            eventFieldName: 'new_status',
          },
        },
      },
    }));
    expect(r.blockers).not.toContain('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
  });
});

describe('getDeveloperReadiness — recommendedNextStep', () => {
  it('returns ready message when all checks pass', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask());
    expect(r.recommendedNextStep).toBe('Ready for code generation.');
  });

  it('returns mode recommendation when mode is wrong', () => {
    const r = getDeveloperReadiness(makeTask());
    expect(r.recommendedNextStep).toContain('Developer');
  });

  it('returns repo root recommendation when root is missing', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      workflowSetup: { ...makeReadyPluginTask().workflowSetup, repositoryRoot: undefined },
    }));
    expect(r.recommendedNextStep).toContain('repository root');
  });

  it('returns technical plan recommendation when plan is missing', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin', technicalPlan: undefined },
    }));
    expect(r.recommendedNextStep).toContain('technical implementation plan');
  });

  it('returns warnings-aware message when warnings exist', () => {
    const r = getDeveloperReadiness(makeReadyPluginTask({
      crmVerificationReports: [{ verdict: 'warnings' }] as CrmVerificationReport[],
    }));
    expect(r.isReady).toBe(true);
    expect(r.recommendedNextStep).toContain('warnings');
  });
});
