import { useState, useEffect } from 'react';
import type { AppSettings, M365ConnectionStatus, MicrosoftConnectionStatus } from '../types';
import { useApp } from '../context/AppContext';
import Icon from '../components/Icon';
import type { IconName } from '../components/Icon';
import * as tauriApi from '../lib/tauriCommands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a path string ends with a file extension — likely a file, not a directory. */
function isLikelyFilePath(path: string | undefined): boolean {
  const p = path?.trim() ?? '';
  return p.length > 0 && /\.(js|ts|cjs|mjs|py|exe|bat|ps1|sh|json|yaml|yml|xml|dll)$/i.test(p);
}

/** Returns the parent directory portion of a file path, or '' if not determinable. */
function getParentDir(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? filePath.trim().slice(0, idx) : '';
}

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

/** Label + control row inside a settings block.
 *
 * When `hint` is provided the children and hint text are wrapped in a
 * `.settings-field-control` column container so the hint appears below
 * the input rather than beside it in the flex row.
 */
function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-form-row">
      <label className="form-label">{label}</label>
      {hint ? (
        <div className="settings-field-control">
          {children}
          <div className="settings-field-hint">{hint}</div>
        </div>
      ) : (
        children
      )}
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
  // MCP connection test state
  const [mcpTestStatus, setMcpTestStatus] = useState<string | null>(null);
  const [mcpTestMessage, setMcpTestMessage] = useState<string>('');
  const [mcpTestUsedDraft, setMcpTestUsedDraft] = useState(false);
  const [mcpTesting, setMcpTesting] = useState(false);
  const [mcpTools, setMcpTools] = useState<Array<{ name: string; description: string; readOnly: boolean }> | null>(null);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);
  const [taskMcpBridgeLoading, setTaskMcpBridgeLoading] = useState(false);
  const [taskMcpBridge, setTaskMcpBridge] = useState<{
    active: boolean;
    host: string;
    port: number;
    serverPath: string;
    readOnlyMode: boolean;
    localWriteMode: boolean;
    readOnlyTools: Array<{ name: string; description: string; readOnly: boolean }>;
    localWriteTools: Array<{ name: string; description: string; readOnly: boolean }>;
    lastError?: string;
  } | null>(null);

  type SettingsTab = 'general' | 'workspace' | 'ai' | 'crm' | 'm365';
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  type McpSetupTool = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode-copilot' | 'windsurf' | 'codex';
  const [mcpSetupTab, setMcpSetupTab] = useState<McpSetupTool>('claude-code');

  const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
    { id: 'general',   label: 'General',       icon: 'settings'       },
    { id: 'workspace', label: 'Workspace',      icon: 'folder'         },
    { id: 'ai',        label: 'AI',             icon: 'search'         },
    { id: 'crm',       label: 'CRM Metadata',   icon: 'folder'         },
    { id: 'm365',      label: 'Microsoft 365',  icon: 'mail'           },
  ];

  useEffect(() => {
    setDraft(settings);
    setIsDirty(false);
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

  // --- Primarch MCP actions ------------------------------------------------

  async function handleTestPrimarchMcpConnection() {
    setMcpTesting(true);
    setMcpTestStatus(null);
    setMcpTestMessage('');
    setMcpTestUsedDraft(false);
    try {
      const usedDraft = isDirty;
      const result = await tauriApi.testPrimarchMcpConnection(draft);
      const status = String(result.status ?? 'error');
      const message = String(result.message ?? 'No response message.');
      setMcpTestStatus(status);
      setMcpTestMessage(message);
      setMcpTestUsedDraft(usedDraft);

      if (usedDraft) {
        setDraft((prev) => ({
          ...prev,
          primarchMcpLastStatus: status as AppSettings['primarchMcpLastStatus'],
          primarchMcpLastError: status === 'error' ? message : undefined,
        }));
        setIsDirty(true);
        setSaved(false);
      } else {
        await updateSettings({
          primarchMcpLastStatus: status as AppSettings['primarchMcpLastStatus'],
          primarchMcpLastError: status === 'error' ? message : undefined,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err) {
      const message = String(err);
      setMcpTestStatus('error');
      setMcpTestMessage(message);
      setDraft((prev) => ({
        ...prev,
        primarchMcpLastStatus: 'error',
        primarchMcpLastError: message,
      }));
      setIsDirty(true);
      setSaved(false);
    } finally {
      setMcpTesting(false);
    }
  }

    async function handleListPrimarchMcpTools() {
      setMcpToolsLoading(true);
      setMcpTools(null);
      try {
        if (isDirty) {
          await updateSettings(draft);
          setIsDirty(false);
        }
        const result = await tauriApi.listPrimarchMcpTools();
        const tools = Array.isArray(result.tools) ? result.tools : [];
        setMcpTools(tools);
        if (!tools.length && result.message) {
          setMcpTestStatus('not_configured');
          setMcpTestMessage(String(result.message));
        }
      } catch (err) {
        setMcpTestStatus('error');
        setMcpTestMessage(String(err));
        setMcpTools([]);
      } finally {
        setMcpToolsLoading(false);
      }
    }

  async function refreshTaskMcpBridgeStatus() {
    setTaskMcpBridgeLoading(true);
    try {
      const status = await tauriApi.getTaskMcpBridgeStatus();
      setTaskMcpBridge(status);
    } catch (err) {
      setTaskMcpBridge({
        active: false,
        host: '127.0.0.1',
        port: 38473,
        serverPath: 'mcp/task-workbench-mcp.mjs',
        readOnlyMode: false,
        localWriteMode: true,
        readOnlyTools: [],
        localWriteTools: [],
        lastError: String(err),
      });
    } finally {
      setTaskMcpBridgeLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab !== 'crm') return;
    void refreshTaskMcpBridgeStatus();
  }, [activeTab]);

  // Normalise to forward slashes for all snippet use.
  const taskMcpServerPath = (taskMcpBridge?.serverPath ?? 'mcp/task-workbench-mcp.mjs').replace(/\\/g, '/');

  const mcpJsonSnippet = JSON.stringify({
    mcpServers: {
      'task-workbench': {
        command: 'node',
        args: [taskMcpServerPath],
      },
    },
  }, null, 2);
  const claudeDesktopSnippet = mcpJsonSnippet;
  const cursorSnippet      = mcpJsonSnippet;
  const vsCodeCopilotSnippet = mcpJsonSnippet;
  const windsurfSnippet    = mcpJsonSnippet;
  const codexSnippet       = `codex mcp add task-workbench --command node --arg "${taskMcpServerPath}"`;
  const claudeCodeSnippet  = `claude mcp add task-workbench --command node --arg "${taskMcpServerPath}"`;

  type McpToolTab = { id: McpSetupTool; label: string; hint: string; snippet: string };
  const MCP_TOOL_TABS: McpToolTab[] = [
    { id: 'claude-code',    label: 'Claude Code',     hint: 'Run once in a terminal:',                                          snippet: claudeCodeSnippet },
    { id: 'claude-desktop', label: 'Claude Desktop',  hint: 'Add to claude_desktop_config.json under "mcpServers":',           snippet: claudeDesktopSnippet },
    { id: 'cursor',         label: 'Cursor',          hint: 'Add to .cursor/mcp.json or project .mcp.json:',                   snippet: cursorSnippet },
    { id: 'vscode-copilot', label: 'VS Code Copilot', hint: 'Add to .vscode/mcp.json or workspace .mcp.json:',                 snippet: vsCodeCopilotSnippet },
    { id: 'windsurf',       label: 'Windsurf',        hint: 'Add to .windsurf/mcp.json or project .mcp.json:',                 snippet: windsurfSnippet },
    { id: 'codex',          label: 'Codex CLI',       hint: 'Run once in a terminal:',                                          snippet: codexSnippet },
  ];
  const activeMcpTab = MCP_TOOL_TABS.find((t) => t.id === mcpSetupTab) ?? MCP_TOOL_TABS[0];

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

  const baseDir = draft.crmBaseDirectory ?? '';

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
              title="Linked Context"
              description="Optional local locations associated with customer and workspace context records"
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

          </>
        )}

        {/* ── AI ───────────────────────────────────────────────────────────── */}
        {activeTab === 'ai' && (
          <>
            <SettingsBlock
              icon="search"
              title="AI Configuration"
              description="Provider-aware AI configuration for analysis, draft generation, and reviews"
            >
              <SettingsField label="Active Provider">
                <select
                  className="form-select"
                  value={draft.activeAiProvider ?? 'openai'}
                  onChange={(e) => set('activeAiProvider', e.target.value as AppSettings['activeAiProvider'])}
                  style={{ maxWidth: 280 }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                </select>
              </SettingsField>

              <SettingsField
                label="OpenAI Model"
                hint="Some models (e.g. gpt-5.5, o1, o3) do not accept sampling parameters such as temperature. Unsupported parameters are omitted automatically."
              >
                <input
                  className="form-input"
                  type="text"
                  placeholder="gpt-4.1-mini"
                  value={draft.openaiModel ?? ''}
                  onChange={(e) => set('openaiModel', e.target.value)}
                />
              </SettingsField>

              <SettingsField label="OpenAI API Key">
                <input
                  className="form-input"
                  type="password"
                  placeholder="sk-…"
                  value={draft.openaiApiKey ?? ''}
                  onChange={(e) => set('openaiApiKey', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>

              <SettingsField label="Claude Model">
                <input
                  className="form-input"
                  type="text"
                  placeholder="claude-sonnet-4-5"
                  value={draft.anthropicModel ?? ''}
                  onChange={(e) => set('anthropicModel', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>

              <SettingsField label="Claude API Key">
                <input
                  className="form-input"
                  type="password"
                  placeholder="sk-ant-…"
                  value={draft.anthropicApiKey ?? ''}
                  onChange={(e) => set('anthropicApiKey', e.target.value)}
                  style={{ maxWidth: 280 }}
                />
              </SettingsField>

              <div className="settings-field-hint">
                Legacy <code>aiApiKey</code> and <code>aiModel</code> are preserved and used automatically as OpenAI fallback.
              </div>
            </SettingsBlock>

          </>
        )}

        {/* ── CRM Metadata / Primarch MCP ─────────────────────────────────── */}
        {activeTab === 'crm' && (
          <>
            <SettingsBlock
              icon="plug"
              title="Task MCP Bridge"
              description="Primarch-style local bridge used by mcp/task-workbench-mcp.mjs. Localhost only."
            >
              <div className="settings-inline-list" style={{ marginTop: 2, marginBottom: 8 }}>
                <span className={`repo-status-badge ${taskMcpBridge?.active ? 'repo-status-linked' : 'repo-status-missing'}`}>
                  {taskMcpBridge?.active ? 'Bridge Active' : 'Not running'}
                </span>
                <span className="repo-status-badge repo-status-linked">Task-data interface</span>
                <span className="repo-status-badge repo-status-linked">Execution blocked</span>
              </div>
              <div className="settings-field-hint" style={{ marginTop: 4 }}>
                AI clients can read and maintain task records, responsibility, deadlines, status, notes,
                summaries, estimates, waiting state, archive state, and structured history.
                The interface cannot orchestrate agents, execute tasks, modify repositories, deploy artifacts,
                or create pull requests.
              </div>

              <SettingsField label="Localhost endpoint">
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {taskMcpBridge?.host ?? '127.0.0.1'}:{taskMcpBridge?.port ?? 38473}
                </div>
              </SettingsField>

              <SettingsField label="MCP server path">
                <input
                  className="form-input"
                  type="text"
                  readOnly
                  value={taskMcpServerPath}
                  style={{ maxWidth: 700 }}
                />
              </SettingsField>

              <div className="settings-action-row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={refreshTaskMcpBridgeStatus}
                  disabled={taskMcpBridgeLoading}
                >
                  {taskMcpBridgeLoading ? <><span className="btn-spinner" /> Refreshing…</> : 'Refresh Bridge Status'}
                </button>
              </div>

              {taskMcpBridge?.lastError && (
                <div className="settings-field-hint" style={{ marginTop: 8 }}>
                  {taskMcpBridge.lastError}
                </div>
              )}

              {/* Setup instructions */}
              <div style={{ marginTop: 12 }}>
                <div className="settings-field-hint" style={{ marginBottom: 6, fontWeight: 600 }}>
                  Setup instructions
                </div>
                <ol style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <li>Task Workbench app must be running — the MCP bridge starts automatically on launch.</li>
                  <li>Verify the bridge status above — endpoint should show active.</li>
                  <li style={{ marginBottom: 6 }}>Add the MCP config to your AI tool:</li>
                </ol>

                {/* Tool selector */}
                <div className="planning-filter-bar" style={{ marginBottom: 8 }}>
                  {MCP_TOOL_TABS.map((t) => (
                    <button
                      key={t.id}
                      className={`planning-filter-chip${mcpSetupTab === t.id ? ' active' : ''}`}
                      onClick={() => setMcpSetupTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Active snippet */}
                <div className="settings-field-hint" style={{ marginBottom: 4 }}>{activeMcpTab.hint}</div>
                <div style={{ position: 'relative' }}>
                  <pre style={{
                    margin: 0, padding: '8px 56px 8px 10px',
                    fontSize: 11.5, fontFamily: 'var(--font-mono, Consolas, monospace)',
                    background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    color: 'var(--text-secondary)', lineHeight: 1.55,
                  }}>
                    {activeMcpTab.snippet}
                  </pre>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ position: 'absolute', top: 5, right: 5, fontSize: 11 }}
                    onClick={() => navigator.clipboard.writeText(activeMcpTab.snippet).catch(() => {})}
                    title="Copy to clipboard"
                  >
                    Copy
                  </button>
                </div>

                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  4. Restart or reload your AI tool after adding the config.
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="settings-field-hint" style={{ marginBottom: 4 }}>Available tools</div>
                <div className="detail-analysis-points" style={{ maxHeight: 260, overflow: 'auto' }}>
                  {(taskMcpBridge?.readOnlyTools ?? []).map((t) => (
                    <div key={`ro-${t.name}`} style={{ marginBottom: 4 }}>
                      <strong>{t.name}</strong> · read-only
                      {t.description ? <div className="settings-field-hint">{t.description}</div> : null}
                    </div>
                  ))}
                  {(taskMcpBridge?.localWriteTools ?? []).map((t) => (
                    <div key={`rw-${t.name}`} style={{ marginBottom: 4 }}>
                      <strong>{t.name}</strong> · local-write
                      {t.description ? <div className="settings-field-hint">{t.description}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock
              icon="folder"
              title="CRM Metadata / Primarch MCP"
              description="Optional read-only metadata context source. It cannot change Dataverse or execute work."
            >
              <SettingsField label="Enable CRM metadata assistant">
                <label className="checkbox-inline" style={{ marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!draft.crmMetadataEnabled}
                    onChange={(e) => set('crmMetadataEnabled', e.target.checked)}
                  />
                  Enabled
                </label>
              </SettingsField>

              <SettingsField label="MCP command">
                <input
                  className="form-input"
                  type="text"
                  placeholder="e.g. node"
                  value={draft.primarchMcpCommand ?? ''}
                  onChange={(e) => set('primarchMcpCommand', e.target.value)}
                  style={{ maxWidth: 520 }}
                />
              </SettingsField>

              <SettingsField label="MCP args">
                <input
                  className="form-input"
                  type="text"
                  placeholder="e.g. path/to/primarch-mcp-server.js"
                  value={draft.primarchMcpArgs ?? ''}
                  onChange={(e) => set('primarchMcpArgs', e.target.value)}
                  style={{ maxWidth: 520 }}
                />
              </SettingsField>

              <SettingsField label="Working directory">
                <input
                  className="form-input"
                  type="text"
                  placeholder="optional absolute path to a folder"
                  value={draft.primarchMcpWorkingDirectory ?? ''}
                  onChange={(e) => set('primarchMcpWorkingDirectory', e.target.value)}
                  style={{ maxWidth: 520 }}
                />
                <div className="settings-field-hint" style={{ marginTop: 3 }}>
                  Must be a folder, not a file. Usually the folder containing the MCP script.
                </div>
                {isLikelyFilePath(draft.primarchMcpWorkingDirectory) && (
                  <div className="settings-field-hint" style={{ marginTop: 3, color: 'var(--color-warning, #d29922)' }}>
                    This looks like a file path. Working directory must be a folder — use its parent directory instead.
                  </div>
                )}
                {isLikelyFilePath(draft.primarchMcpArgs) && !draft.primarchMcpWorkingDirectory?.trim() && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => set('primarchMcpWorkingDirectory', getParentDir(draft.primarchMcpArgs ?? ''))}
                      title="Set working directory to the folder containing the MCP script"
                    >
                      Use parent folder from MCP args
                    </button>
                  </div>
                )}
              </SettingsField>

              <div className="settings-inline-list" style={{ marginTop: 2 }}>
                <span className="repo-status-badge repo-status-linked">Read-only mode enforced</span>
              </div>

              <div className="settings-action-row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleTestPrimarchMcpConnection}
                  disabled={mcpTesting}
                >
                  {mcpTesting ? <><span className="btn-spinner" /> Testing…</> : 'Test Connection'}
                </button>

                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleListPrimarchMcpTools}
                  disabled={mcpToolsLoading}
                >
                  {mcpToolsLoading ? <><span className="btn-spinner" /> Loading…</> : 'List Read-only Tools'}
                </button>
              </div>

              {mcpTestMessage && (
                <div className="settings-field-hint" style={{ marginTop: 8 }}>
                  {mcpTestStatus ? `[${mcpTestStatus}] ` : ''}{mcpTestMessage}
                </div>
              )}

              {(isDirty || mcpTestUsedDraft) && (
                <div className="settings-field-hint" style={{ marginTop: 8 }}>
                  Connection test used unsaved draft values. Click Save Settings before using Verify.
                </div>
              )}

              {mcpTools && (
                <div style={{ marginTop: 8 }}>
                  <div className="settings-field-hint" style={{ marginBottom: 4 }}>
                    Tools returned by MCP server:
                  </div>
                  <div className="detail-analysis-points" style={{ maxHeight: 220, overflow: 'auto' }}>
                    {mcpTools.length === 0 && <div className="settings-field-hint">No tools returned.</div>}
                    {mcpTools.map((t) => (
                      <div key={t.name} style={{ marginBottom: 4 }}>
                        <strong>{t.name}</strong> {t.readOnly ? '· read-only' : '· blocked'}
                        {t.description ? <div className="settings-field-hint">{t.description}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
