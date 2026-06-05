/**
 * Default AppSettings shape used as the initial state before Tauri loads.
 * No mock tasks or customers — the app starts empty with real local data only.
 */
import type { AppSettings, Customer } from '../types';

/**
 * Built-in sentinel customer for tasks that don't belong to any CRM project.
 * Always present in memory (injected by AppContext after load).
 * Has no repository, plugin, or script paths — dev tools collapse automatically.
 */
export const OTHER_CUSTOMER_ID = '__other__';
export const OTHER_CUSTOMER: Customer = {
  id:        OTHER_CUSTOMER_ID,
  name:      'Other',
  shortCode: 'OTHER',
};

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
  crmMetadataEnabled: false,
  primarchMcpCommand: '',
  primarchMcpArgs: '',
  primarchMcpWorkingDirectory: '',
  primarchMcpReadOnly: true,
  primarchMcpLastStatus: 'not_configured',
  primarchMcpLastError: undefined,
};

