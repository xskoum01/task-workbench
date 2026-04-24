import { useState, useEffect } from 'react';
import type { AppSettings, AppTemplate, M365ConnectionStatus, MicrosoftConnectionStatus, TemplateValidationState } from '../types';
import { useApp } from '../context/AppContext';
import Icon from '../components/Icon';
import type { IconName } from '../components/Icon';
import * as tauriApi from '../lib/tauriCommands';
import TemplatesSection from '../components/TemplatesSection';
import AiReviewersSettingsPanel from '../components/AiReviewersSettingsPanel';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Settings block card */
function SettingsBlock({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: IconName;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={['settings-block', className].filter(Boolean).join(' ')}>
      <div className="settings-block-header">
        <span className="settings-block-icon">
          <Icon name={icon} size={15} />
        </span>
        <div>
          <div className="settings-block-title">{title}</div>
          <div className="settings-block-desc">{description}</div>
        </div>
      </div>
      <div className="settings-block-body">{children}</div>
    </div>
  );
}

/** Label + control row inside a settings block */
function SettingsField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-form-row">
      <label className="form-label">{label}</label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teams chat URL parser
// ---------------------------------------------------------------------------

/**
 * Extract a chatId from a pasted Teams chat link or return the raw input if
 * it already looks like a chatId.
 *
 * Teams deep links look like:
 *   https://teams.microsoft.com/l/chat/19%3Axxx%40thread.v2/0?context=...
 * The chatId is the path segment after /l/chat/ decoded from percent-encoding.
 */
function parseTeamsChatId(raw: string): string {
  const input = raw.trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/');
    const chatIdx = parts.indexOf('chat');
    if (chatIdx !== -1 && parts[chatIdx + 1]) {
      return decodeURIComponent(parts[chatIdx + 1]);
    }
  } catch {
    // Not a URL — treat as a raw chat ID
  }
  return input;
}

// ---------------------------------------------------------------------------
// M365 status helpers
// ---------------------------------------------------------------------------

const M365_STATUS_LABEL: Record<M365ConnectionStatus, string> = {
  not_configured: 'Not configured',
  configured:     'Configured',
  connected:      'Connected',
  error:          'Error',
};

const M365_STATUS_CLASS: Record<M365ConnectionStatus, string> = {
  not_configured: 'repo-status-not-created',
  configured:     'repo-status-missing',   // amber — configured but not authenticated
  connected:      'repo-status-linked',    // green
  error:          'repo-status-missing',   // amber/warning
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { settings, updateSettings, rescanRepositories } = useApp();

  const [draft, setDraft]         = useState<AppSettings>(settings);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [isDirty, setIsDirty]     = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [rescanMsg, setRescanMsg]   = useState('');
  const [m365Notice, setM365Notice] = useState('');
  const [templateValidation, setTemplateValidation] = useState<TemplateValidationState>('not_selected');
  const [templateValidating, setTemplateValidating] = useState(false);

  useEffect(() => {
    setDraft(settings);
    setIsDirty(false);
    // Reset validation when settings reload
    setTemplateValidation(
      settings.repositoryTemplatePath ? 'not_selected' : 'not_selected'
    );
  }, [settings]);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateSettings(draft);
      setIsDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  // --- Repository Workspace actions ----------------------------------------

  async function handleChooseFolder() {
    try {
      const picked = await tauriApi.pickFolder();
      if (picked) {
        set('crmBaseDirectory', picked);
      }
    } catch (err) {
      // Native dialog not available in browser dev mode — silently ignore
      console.warn('pickFolder unavailable:', err);
    }
  }

  async function handleOpenBaseDir() {
    const dir = draft.crmBaseDirectory;
    if (!dir) return;
    try {
      await tauriApi.openPath(dir);
    } catch (err) {
      console.warn('openPath failed:', err);
    }
  }

  async function handleRescan() {
    setRescanning(true);
    setRescanMsg('');
    try {
      // Persist any unsaved base directory before rescanning
      if (isDirty) {
        await updateSettings(draft);
        setIsDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
      await rescanRepositories();
      setRescanMsg('Repositories rescanned successfully.');
      setTimeout(() => setRescanMsg(''), 4000);
    } catch (err) {
      setRescanMsg('Rescan failed. Check the console for details.');
    } finally {
      setRescanning(false);
    }
  }

  // --- Template actions ---------------------------------------------------

  async function handleChooseZip() {
    try {
      const picked = await tauriApi.pickFile('ZIP Archives', ['zip']);
      if (picked) {
        setDraft((prev) => ({
          ...prev,
          repositoryTemplateType: 'zip',
          repositoryTemplatePath: picked,
        }));
        setIsDirty(true);
        setSaved(false);
        setTemplateValidation('not_selected');
      }
    } catch (err) {
      console.warn('pickFile unavailable:', err);
    }
  }

  async function handleChooseTemplateFolder() {
    try {
      const picked = await tauriApi.pickFolder();
      if (picked) {
        setDraft((prev) => ({
          ...prev,
          repositoryTemplateType: 'folder',
          repositoryTemplatePath: picked,
        }));
        setIsDirty(true);
        setSaved(false);
        setTemplateValidation('not_selected');
      }
    } catch (err) {
      console.warn('pickFolder unavailable:', err);
    }
  }

  async function handleOpenTemplate() {
    const path = draft.repositoryTemplatePath;
    if (!path) return;
    try {
      await tauriApi.openPath(path);
    } catch (err) {
      console.warn('openPath failed:', err);
    }
  }

  async function handleValidateTemplate() {
    const path = draft.repositoryTemplatePath;
    const type = draft.repositoryTemplateType;
    if (!path || !type || type === 'none') {
      setTemplateValidation('not_selected');
      return;
    }
    setTemplateValidating(true);
    try {
      const result = await tauriApi.validateTemplate(path, type as 'zip' | 'folder');
      setTemplateValidation(result);
    } catch (err) {
      setTemplateValidation('invalid');
    } finally {
      setTemplateValidating(false);
    }
  }

  function clearTemplate() {
    setDraft((prev) => ({
      ...prev,
      repositoryTemplateType: 'none',
      repositoryTemplatePath: '',
    }));
    setIsDirty(true);
    setSaved(false);
    setTemplateValidation('not_selected');
  }

  // --- M365 connection actions ---------------------------------------------

  async function handleM365SignIn() {
    const clientId = (draft.microsoftClientId ?? '').trim();
    const tenantId = (draft.microsoftTenant   ?? '').trim();
    if (!tenantId) {
      setM365Notice('Enter your Directory (tenant) ID before signing in.');
      return;
    }
    if (!clientId) {
      setM365Notice('Enter your Application (client) ID before signing in.');
      return;
    }
    setDraft((prev) => ({
      ...prev,
      microsoftConnectionStatus: 'connecting' as MicrosoftConnectionStatus,
      lastMicrosoftError: undefined,
    }));
    setM365Notice('');
    try {
      const info = await tauriApi.connectMicrosoftAccount(clientId, tenantId);
      const m365Updates: Partial<AppSettings> = {
        microsoftConnectionStatus: 'connected',
        microsoftClientId:          clientId,
        microsoftTenant:            tenantId,
        microsoftAccountDisplayName: info.displayName,
        microsoftTenantId:          info.tenantId,
        m365AccountEmail:           info.email,
        lastMicrosoftSyncAt:        info.lastSyncAt,
        lastMicrosoftError:         undefined,
        outlookStatus:              'connected',
        teamsStatus:                'connected',
        graphEnabled:               true,
      };
      setDraft((prev) => ({ ...prev, ...m365Updates }));
      await updateSettings(m365Updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraft((prev) => ({
        ...prev,
        microsoftConnectionStatus: 'error' as MicrosoftConnectionStatus,
        lastMicrosoftError: message,
      }));
    }
  }

  async function handleM365Refresh() {
    const clientId = (draft.microsoftClientId ?? '').trim();
    setDraft((prev) => ({
      ...prev,
      microsoftConnectionStatus: 'refreshing' as MicrosoftConnectionStatus,
    }));
    try {
      const info = await tauriApi.refreshMicrosoftConnection(clientId);
      const m365Updates: Partial<AppSettings> = {
        microsoftConnectionStatus: 'connected',
        microsoftAccountDisplayName: info.displayName,
        microsoftTenantId:          info.tenantId,
        m365AccountEmail:           info.email,
        lastMicrosoftSyncAt:        info.lastSyncAt,
        lastMicrosoftError:         undefined,
      };
      setDraft((prev) => ({ ...prev, ...m365Updates }));
      await updateSettings(m365Updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraft((prev) => ({
        ...prev,
        microsoftConnectionStatus: 'error' as MicrosoftConnectionStatus,
        lastMicrosoftError: message,
      }));
    }
  }

  // --- Data reset -----------------------------------------------------------

  const [resetting, setResetting]     = useState(false);
  const [resetMsg, setResetMsg]       = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  async function handleResetLocalData() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setResetMsg('');
    try {
      await tauriApi.resetLocalData();
      setResetMsg('Local task and customer data cleared.');
      setConfirmReset(false);
      setTimeout(() => setResetMsg(''), 5000);
      // Reload the page so the empty state loads from disk
      window.location.reload();
    } catch (err) {
      setResetMsg('Reset failed. Check the console for details.');
      console.warn('resetLocalData failed:', err);
    } finally {
      setResetting(false);
    }
  }

  /** Clears all Microsoft account connection metadata and revokes the token cache. */
  async function handleM365Disconnect() {
    try {
      await tauriApi.disconnectMicrosoftAccount();
    } catch (err) {
      console.warn('disconnectMicrosoftAccount failed:', err);
    }
    // Preserve microsoftTenant and microsoftClientId so the user doesn't have
    // to re-enter both IDs if they reconnect immediately after disconnecting.
    const m365Updates: Partial<AppSettings> = {
      microsoftConnectionStatus:   'disconnected',
      outlookStatus:               'not_configured',
      teamsStatus:                 'not_configured',
      graphEnabled:                false,
      m365AccountEmail:            '',
      microsoftAccountDisplayName: undefined,
      microsoftTenantId:           undefined,
      microsoftTenantName:         undefined,
      lastMicrosoftSyncAt:         undefined,
      lastMicrosoftError:          undefined,
    };
    setDraft((prev) => ({ ...prev, ...m365Updates }));
    await updateSettings(m365Updates);
    setM365Notice('');
  }

  // -------------------------------------------------------------------------

  const baseDir      = draft.crmBaseDirectory ?? '';
  const templatePath = draft.repositoryTemplatePath ?? '';

  // ---------------------------------------------------------------------------
  // Tab state
  // ---------------------------------------------------------------------------

  type SettingsTab = 'general' | 'workspace' | 'ai' | 'm365';
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
    { id: 'general',   label: 'General',       icon: 'settings'       },
    { id: 'workspace', label: 'Workspace',      icon: 'folder'         },
    { id: 'ai',        label: 'AI',             icon: 'search'         },
    { id: 'm365',      label: 'Microsoft 365',  icon: 'mail'           },
  ];

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Application and integration configuration</div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`settings-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <Icon name={tab.icon} size={13} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="settings-tab-content">

        {/* ── General ──────────────────────────────────────────────────────── */}
        {activeTab === 'general' && (
          <>
            <SettingsBlock
              icon="settings"
              title="Application"
              description="General application preferences"
            >
              <SettingsField label="App Name">
                <input
                  className="form-input"
                  type="text"
                  value={draft.appName}
                  onChange={(e) => set('appName', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>

              <SettingsField label="Theme">
                <select
                  className="form-select"
                  value={draft.theme}
                  onChange={(e) => set('theme', e.target.value)}
                  style={{ maxWidth: 280 }}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light (not yet implemented)</option>
                </select>
              </SettingsField>

              <SettingsField label="Default Task Confidence %">
                <input
                  className="form-input"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.defaultTaskConfidence}
                  onChange={(e) =>
                    set('defaultTaskConfidence', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))
                  }
                  style={{ maxWidth: 100 }}
                />
              </SettingsField>

              <SettingsField label="Platform">
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Tauri 2 / Windows
                </span>
              </SettingsField>
            </SettingsBlock>

            <SettingsBlock icon="folder" title="Data Management" description="Reset local persisted data. Settings and Microsoft tokens are preserved.">
              <div className="settings-form-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  Clears all tasks and customers stored locally. Use this to start fresh without reinstalling the app.
                </div>
                <div className="settings-action-row">
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: confirmReset ? 'var(--color-blocked)' : undefined }}
                    onClick={handleResetLocalData}
                    disabled={resetting}
                    title="Clear all local task and customer data"
                  >
                    {resetting ? 'Resetting…' : confirmReset ? 'Click again to confirm reset' : 'Reset local data'}
                  </button>
                  {confirmReset && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmReset(false)}
                    >
                      Cancel
                    </button>
                  )}
                  {resetMsg && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{resetMsg}</span>
                  )}
                </div>
              </div>
            </SettingsBlock>
          </>
        )}

        {/* ── Workspace ────────────────────────────────────────────────────── */}
        {activeTab === 'workspace' && (
          <>
            <SettingsBlock
              icon="folder"
              title="Repository Workspace"
              description="Where customer repositories live, how they are detected, and what default template to use for scaffolding"
            >
              {/* Base directory chooser */}
              <SettingsField label="CRM Base Directory">
                <div className="settings-repo-dir-row">
                  {baseDir ? (
                    <span className="settings-repo-dir-value" title={baseDir}>{baseDir}</span>
                  ) : (
                    <span className="settings-repo-dir-placeholder">No directory selected</span>
                  )}
                  <div className="settings-repo-dir-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleChooseFolder}
                      title="Open the system folder picker"
                    >
                      <Icon name="folder" size={13} /> Choose…
                    </button>
                    {baseDir && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleOpenBaseDir}
                        title="Open in file explorer"
                      >
                        Open
                      </button>
                    )}
                  </div>
                </div>
                {!baseDir && (
                  <p className="settings-hint">
                    Click <strong>Choose…</strong> to select the root folder that contains your customer repositories.
                  </p>
                )}
              </SettingsField>

              {/* Repository template */}
              <SettingsField label="Default repository template">
                <div className="settings-template-section">
                  <div className="settings-template-current">
                    {templatePath ? (
                      <>
                        <span
                          className="settings-repo-dir-value"
                          title={templatePath}
                          style={{ flex: 1 }}
                        >
                          {templatePath}
                        </span>
                        <span
                          className={`template-validation-badge${
                            templateValidation === 'valid'   ? ' template-valid'   :
                            templateValidation === 'invalid' ? ' template-invalid' : ''
                          }`}
                        >
                          {templateValidation === 'valid'        ? '✓ Valid'
                           : templateValidation === 'invalid'    ? '✗ Invalid'
                           : 'Not validated'}
                        </span>
                      </>
                    ) : (
                      <span className="settings-repo-dir-placeholder">No template selected</span>
                    )}
                  </div>
                  <div className="settings-template-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleChooseZip}
                      title="Pick a ZIP archive as the repository template"
                    >
                      <Icon name="folder" size={13} /> Choose ZIP
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleChooseTemplateFolder}
                      title="Pick a folder as the repository template"
                    >
                      <Icon name="folder" size={13} /> Choose Folder
                    </button>
                    {templatePath && (
                      <>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleValidateTemplate}
                          disabled={templateValidating}
                        >
                          {templateValidating ? 'Validating…' : 'Validate'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleOpenTemplate}
                        >
                          Open
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={clearTemplate}
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="settings-hint">
                  A ZIP archive with a single top-level folder (e.g.{' '}
                  <code>_GIT_REPO_TEMPLATE/</code>) is automatically stripped so
                  the contents land directly in the customer directory.
                </p>
              </SettingsField>

              {/* Rescan action */}
              <SettingsField label="Repository scan">
                <div className="settings-action-row">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleRescan}
                    disabled={rescanning}
                    title="Re-check all customer repository paths"
                  >
                    {rescanning ? 'Scanning…' : 'Rescan Repositories'}
                  </button>
                  {rescanMsg && (
                    <span className="settings-inline-msg">
                      <Icon name="check" size={12} /> {rescanMsg}
                    </span>
                  )}
                </div>
                <p className="settings-hint">
                  Checks each customer's repository folder and updates its status (Linked / Missing / Not created).
                  {isDirty && <> Unsaved changes will be saved automatically before scanning.</>}
                </p>
              </SettingsField>
            </SettingsBlock>

            <SettingsBlock
              icon="file-text"
              title="Templates"
              description="Plugin and Script templates for new customer repositories"
            >
              <TemplatesSection
                templates={draft.templates ?? []}
                onChange={(updated: AppTemplate[]) => {
                  setDraft((prev) => ({ ...prev, templates: updated }));
                  setIsDirty(true);
                  setSaved(false);
                }}
              />
            </SettingsBlock>

            <SettingsBlock
              icon="folder"
              title="Plugin Template"
              description="Local folder used as a template when scaffolding new plugin projects"
            >
              <SettingsField label="Template Folder">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="form-input"
                    type="text"
                    placeholder="C:\Templates\PluginTemplate"
                    value={draft.pluginTemplateFolder ?? ''}
                    onChange={(e) => set('pluginTemplateFolder', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={async () => {
                      try {
                        const picked = await tauriApi.pickFolder();
                        if (picked) set('pluginTemplateFolder', picked);
                      } catch {}
                    }}
                    title="Browse for template folder"
                  >
                    Browse
                  </button>
                  {draft.pluginTemplateFolder && (
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => tauriApi.openPath(draft.pluginTemplateFolder!).catch(() => {})}
                      title="Open template folder"
                    >
                      Open
                    </button>
                  )}
                </div>
              </SettingsField>
              <div className="settings-field-hint">
                Files may contain <code>__PROJECT_NAME__</code> and <code>__NAMESPACE__</code> placeholders.
                They are replaced when scaffolding a new plugin project.
              </div>
            </SettingsBlock>
          </>
        )}

        {/* ── AI ───────────────────────────────────────────────────────────── */}
        {activeTab === 'ai' && (
          <>
            <SettingsBlock
              icon="search"
              title="AI Configuration"
              description="OpenAI API key and model for task classification and workflow automation"
            >
              <SettingsField label="Model">
                <input
                  className="form-input"
                  type="text"
                  placeholder="gpt-4.1-mini"
                  value={draft.aiModel}
                  onChange={(e) => set('aiModel', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>

              <SettingsField label="API Key">
                <input
                  className="form-input"
                  type="password"
                  placeholder="sk-…"
                  value={draft.aiApiKey}
                  onChange={(e) => set('aiApiKey', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>
            </SettingsBlock>

            <SettingsBlock
              icon="search"
              title="AI Reviewers"
              description="Configurable AI reviewer profiles for plugin and script code review"
            >
              <AiReviewersSettingsPanel
                configs={draft.aiReviewers}
                onChange={(updated) => {
                  setDraft((prev) => ({ ...prev, aiReviewers: updated }));
                  setIsDirty(true);
                  setSaved(false);
                }}
              />
              <p className="settings-hint">
                Reviewer instructions are sent as the AI system prompt. Changes take effect
                immediately when you save Settings.
              </p>
            </SettingsBlock>
          </>
        )}

        {/* ── Microsoft 365 ────────────────────────────────────────────────── */}
        {activeTab === 'm365' && (
          <>
            <SettingsBlock
              icon="mail"
              title="Microsoft 365 Integration"
              description="Sign in with your Microsoft work account to enable Outlook and Teams task ingestion"
            >
              {(() => {
                const status: MicrosoftConnectionStatus =
                  draft.microsoftConnectionStatus ?? 'disconnected';

                if (status === 'connected') {
                  return (
                    <div className="m365-panel">
                      <div className="m365-connection-info">
                        <span className="repo-status-badge repo-status-linked">Connected</span>
                        {draft.microsoftAccountDisplayName && (
                          <span className="m365-account-name">{draft.microsoftAccountDisplayName}</span>
                        )}
                        {draft.m365AccountEmail && (
                          <span className="m365-account-email">{draft.m365AccountEmail}</span>
                        )}
                      </div>

                      {(draft.microsoftTenantName || draft.microsoftTenantId || draft.microsoftTenant) && (
                        <div className="m365-tenant-row">
                          <span className="m365-field-label">Tenant</span>
                          <span className="m365-tenant-name">
                            {draft.microsoftTenantName ?? draft.microsoftTenantId ?? draft.microsoftTenant}
                          </span>
                        </div>
                      )}

                      <div className="m365-services">
                        <div className="m365-service-row">
                          <span className="m365-service-label">Outlook</span>
                          <span className={`repo-status-badge ${M365_STATUS_CLASS[draft.outlookStatus ?? 'not_configured']}`}>
                            {M365_STATUS_LABEL[draft.outlookStatus ?? 'not_configured']}
                          </span>
                        </div>
                        <div className="m365-service-row">
                          <span className="m365-service-label">Teams</span>
                          <span className={`repo-status-badge ${M365_STATUS_CLASS[draft.teamsStatus ?? 'not_configured']}`}>
                            {M365_STATUS_LABEL[draft.teamsStatus ?? 'not_configured']}
                          </span>
                        </div>
                      </div>

                      {draft.lastMicrosoftSyncAt && (
                        <div className="m365-meta-row">
                          <span className="m365-field-label">Last sync</span>
                          <span className="m365-field-value">
                            {new Date(draft.lastMicrosoftSyncAt).toLocaleString()}
                          </span>
                        </div>
                      )}

                      <div className="settings-action-row" style={{ marginTop: 4 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={handleM365Refresh}
                          title="Silently re-acquire Microsoft tokens"
                        >
                          Refresh
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={handleM365Disconnect}
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  );
                }

                if (status === 'refreshing') {
                  return (
                    <div className="m365-panel">
                      <div className="m365-connection-info">
                        <span className="repo-status-badge repo-status-missing">Refreshing…</span>
                      </div>
                    </div>
                  );
                }

                if (status === 'connecting') {
                  return (
                    <div className="m365-panel">
                      <div className="m365-connection-info">
                        <span className="repo-status-badge repo-status-missing">Connecting…</span>
                      </div>
                      {m365Notice && (
                        <div className="settings-m365-notice">
                          <Icon name="plug" size={13} />
                          <span>{m365Notice}</span>
                        </div>
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={handleM365Disconnect}
                      >
                        Cancel
                      </button>
                    </div>
                  );
                }

                if (status === 'error') {
                  return (
                    <div className="m365-panel">
                      <div className="m365-connection-info">
                        <span className="repo-status-badge repo-status-missing">Error</span>
                        {draft.lastMicrosoftError && (
                          <span className="m365-error-msg">{draft.lastMicrosoftError}</span>
                        )}
                      </div>
                      <div className="settings-action-row">
                        <button className="btn btn-secondary" onClick={handleM365SignIn}>
                          Retry
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={handleM365Disconnect}>
                          Disconnect
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="m365-panel">
                    <p className="settings-hint" style={{ marginTop: 0 }}>
                      Sign in with your Microsoft work account to enable Outlook and Teams import.
                    </p>
                    <div className="m365-client-id-field">
                      <label className="form-label" htmlFor="ms-tenant-id">
                        Directory (tenant) ID
                      </label>
                      <input
                        id="ms-tenant-id"
                        className="form-input"
                        type="text"
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        value={draft.microsoftTenant ?? ''}
                        onChange={(e) => { set('microsoftTenant', e.target.value); }}
                        style={{ maxWidth: 340 }}
                      />
                      <label className="form-label" htmlFor="ms-client-id" style={{ marginTop: 6 }}>
                        Application (client) ID
                      </label>
                      <input
                        id="ms-client-id"
                        className="form-input"
                        type="text"
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        value={draft.microsoftClientId ?? ''}
                        onChange={(e) => {
                          setDraft((prev) => ({ ...prev, microsoftClientId: e.target.value }));
                          setIsDirty(true);
                          setSaved(false);
                        }}
                        style={{ maxWidth: 340 }}
                      />
                      <p className="settings-hint" style={{ marginTop: 0 }}>
                        Both IDs are on the <strong>Overview</strong> page of your Azure App Registration.
                        Redirect URI must be set to <code>http://localhost:3049</code> (Mobile and desktop applications).
                      </p>
                    </div>
                    <button
                      className="btn btn-secondary"
                      onClick={handleM365SignIn}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Connect with Microsoft
                    </button>
                    {m365Notice && (
                      <div className="settings-m365-notice">
                        <Icon name="plug" size={13} />
                        <span>{m365Notice}</span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </SettingsBlock>

            {draft.teamsStatus === 'connected' && (
              <SettingsBlock
                icon="message-square"
                title="Teams Intake"
                description="Configure which Teams chat is used as the task intake inbox."
              >
                <SettingsField label="Intake chat">
                  <input
                    className="form-input"
                    type="text"
                    placeholder="Paste a Teams chat link or a raw chat ID"
                    value={draft.teamsIntakeChatId ?? ''}
                    onChange={(e) => {
                      const normalized = parseTeamsChatId(e.target.value);
                      set('teamsIntakeChatId', normalized || undefined);
                    }}
                    style={{ maxWidth: 420 }}
                  />
                </SettingsField>
                <p className="settings-hint">
                  Open the chat in Teams, copy the link from
                  {' '}<strong>More options → Copy link to chat</strong>, and paste it here.
                  Today's messages from this chat will appear in the Teams import panel.
                  {draft.teamsIntakeChatId && (
                    <><br /><span style={{ opacity: 0.7 }}>Stored ID: {draft.teamsIntakeChatId}</span></>
                  )}
                </p>
              </SettingsBlock>
            )}
          </>
        )}

      </div>{/* end settings-tab-content */}

      {/* Save bar — always visible */}
      <div className="settings-save-bar">
        {saved && (
          <span className="settings-saved-msg">
            <Icon name="check" size={13} /> Settings saved
          </span>
        )}
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !isDirty}
          style={{ marginLeft: 12 }}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

    </div>
  );
}
