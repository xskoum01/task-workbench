/**
 * Default AppSettings shape used as the initial state before Tauri loads.
 * No mock tasks or customers — the app starts empty with real local data only.
 */
import type { AppSettings } from '../types';

export const defaultSettings: AppSettings = {
  appName: 'Task Workbench',
  theme: 'dark',
  defaultTaskConfidence: 80,
  aiModel: '',
  aiApiKey: '',
  crmBaseDirectory: '',
  repositoryTemplate: '',
  repositoryTemplateType: 'none',
  repositoryTemplatePath: '',
  initializeGitOnCreate: true,
  defaultGitBranch: 'main',
  createInitialCommit: false,
  microsoftTenant: '',
  graphEnabled: false,
  m365AccountEmail: '',
  outlookStatus: 'not_configured',
  teamsStatus: 'not_configured',
  microsoftClientId: '',
  // Microsoft account connection model — all start disconnected
  microsoftConnectionStatus: 'disconnected',
  microsoftAccountDisplayName: undefined,
  microsoftTenantId: undefined,
  microsoftTenantName: undefined,
  lastMicrosoftSyncAt: undefined,
  lastMicrosoftError: undefined,
};

