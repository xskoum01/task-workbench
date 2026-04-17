import { useState } from 'react';
import type { Customer, RepositoryStatus, CreateRepoResult, GitInitStatus, CreateRepoOptions } from '../types';
import { useApp } from '../context/AppContext';
import CustomerForm from '../components/CustomerForm';
import CreateRepoWizard from '../components/CreateRepoWizard';
import { openPath, openInVscode } from '../lib/tauriCommands';

const REPO_STATUS_LABEL: Record<RepositoryStatus, string> = {
  linked:      'Linked',
  missing:     'Not cloned',
  not_created: 'Not local',
};

const REPO_STATUS_CLASS: Record<RepositoryStatus, string> = {
  linked:      'repo-status-linked',
  missing:     'repo-status-missing',
  not_created: 'repo-status-not-created',
};

const GIT_INIT_LABEL: Record<GitInitStatus, string> = {
  skipped:        'Git: skipped',
  already_exists: 'Git: already initialized',
  success:        'Git: initialized',
  failed:         'Git: init failed',
  git_not_found:  'Git: not found in PATH',
};

const GIT_INIT_CLASS: Record<GitInitStatus, string> = {
  skipped:        'git-status-skipped',
  already_exists: 'git-status-ok',
  success:        'git-status-ok',
  failed:         'git-status-warn',
  git_not_found:  'git-status-warn',
};

interface CreateOutcome {
  result?: CreateRepoResult;
  error?: string;
}

export default function CustomersPage() {
  const {
    customers, tasks, settings,
    createRepositoryFromTemplate, rescanRepositories,
    deleteCustomer,
  } = useApp();

  const [editTarget, setEditTarget]         = useState<Customer | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [wizardCustomer, setWizardCustomer] = useState<Customer | null>(null);
  const [outcomes, setOutcomes]             = useState<Record<string, CreateOutcome>>({});
  const [rescanning, setRescanning]         = useState(false);
  // ID of customer pending a delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const taskCounts = Object.fromEntries(
    customers.map((c) => [c.id, tasks.filter((t) => t.customerId === c.id).length]),
  );

  const hasTemplate =
    (settings.repositoryTemplateType ?? 'none') !== 'none' &&
    !!settings.repositoryTemplatePath &&
    !!settings.crmBaseDirectory;

  const crmBaseDir = settings.crmBaseDirectory;

  async function handleRescan() {
    setRescanning(true);
    try {
      await rescanRepositories();
    } finally {
      setRescanning(false);
    }
  }

  async function handleCreateRepo(customer: Customer, options: CreateRepoOptions): Promise<CreateRepoResult> {
    const result = await createRepositoryFromTemplate(customer, options);
    setOutcomes((prev) => ({ ...prev, [customer.id]: { result } }));
    return result;
  }

  function dismissOutcome(customerId: string) {
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[customerId];
      return next;
    });
  }

  async function handleForgetCustomer(id: string) {
    await deleteCustomer(id);
    setConfirmDeleteId(null);
  }

  const linkedCount  = customers.filter((c) => c.repositoryStatus === 'linked').length;
  const missingCount = customers.filter((c) => c.repositoryStatus === 'missing').length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Workspaces</div>
          <div className="page-subtitle">
            {customers.length === 0
              ? crmBaseDir
                ? 'No workspaces found \u2014 click Sync to discover folders'
                : 'Configure a CRM base directory in Settings to auto-discover workspaces'
              : `${customers.length} workspace${customers.length !== 1 ? 's' : ''}\u2003${linkedCount} linked${missingCount > 0 ? `, ${missingCount} not cloned` : ''}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {crmBaseDir && (
            <button
              className="btn btn-ghost"
              title={`Open CRM directory: ${crmBaseDir}`}
              onClick={() => openPath(crmBaseDir).catch(console.warn)}
            >
              Open Directory
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={handleRescan}
            disabled={rescanning}
            title="Sync from CRM base directory and refresh repository status"
          >
            {rescanning ? 'Syncing\u2026' : 'Sync'}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowCreateForm(true)}>
            <span className="btn-icon">+</span>
            Add Workspace
          </button>
        </div>
      </div>

      {/* Empty state */}
      {customers.length === 0 && (
        <div className="empty-state">
          {crmBaseDir ? (
            <>
              <div className="empty-state-text">No workspaces discovered yet</div>
              <div className="empty-state-hint">
                Click <strong>Sync</strong> to scan <code>{crmBaseDir}</code> for folders.
              </div>
            </>
          ) : (
            <>
              <div className="empty-state-text">No CRM base directory configured</div>
              <div className="empty-state-hint">
                Set a <strong>CRM Base Directory</strong> in Settings. The app will
                automatically discover workspace folders from there.
              </div>
            </>
          )}
        </div>
      )}

      {/* Workspace list */}
      {customers.length > 0 && (
        <div className="customer-list">
          {customers.map((customer) => {
            const outcome  = outcomes[customer.id];
            const repoPath = customer.resolvedRepositoryPath ?? customer.repositoryRoot;
            const crmPath  =
              crmBaseDir && customer.folderName
                ? `${crmBaseDir.replace(/[/\\]+$/, '')}/${customer.folderName}`
                : undefined;
            const displayPath = repoPath ?? crmPath ?? customer.folderName;
            const openPath_   = repoPath ?? crmPath;
            const taskCount   = taskCounts[customer.id] ?? 0;
            const isPending   = confirmDeleteId === customer.id;

            return (
              <div key={customer.id} className="customer-card-wrapper">
                <div className="customer-card">
                  {/* Short code badge */}
                  <div className="customer-shortcode">{customer.shortCode}</div>

                  {/* Main info */}
                  <div className="customer-info" style={{ flex: 1, minWidth: 0 }}>
                    <div className="customer-name">{customer.name}</div>
                    {displayPath && (
                      <div className="customer-path-row">
                        <span className="customer-path-value" style={{ fontSize: 11, opacity: 0.6 }}>
                          {displayPath}
                        </span>
                      </div>
                    )}
                    {customer.namespace && (
                      <div className="customer-path-row">
                        <span className="customer-path-label">NS</span>
                        <span className="customer-path-value">{customer.namespace}</span>
                      </div>
                    )}
                    {customer.notes && (
                      <div className="customer-notes">{customer.notes}</div>
                    )}
                  </div>

                  {/* Right column: meta + actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {taskCount} task{taskCount !== 1 ? 's' : ''}
                      </span>
                      {customer.repositoryStatus && (
                        <span className={`repo-status-badge ${REPO_STATUS_CLASS[customer.repositoryStatus]}`}>
                          {REPO_STATUS_LABEL[customer.repositoryStatus]}
                        </span>
                      )}
                    </div>

                    {/* Actions row */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {openPath_ && customer.repositoryStatus === 'linked' && (
                        <>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            onClick={() => openPath(openPath_).catch(console.warn)}
                            title="Open folder in Explorer"
                          >
                            Open
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            onClick={() => openInVscode(openPath_).catch(console.warn)}
                            title="Open in VS Code"
                          >
                            VS Code
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => setEditTarget(customer)}
                      >
                        Edit
                      </button>

                      {/* Forget / confirm */}
                      {!isPending ? (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 8px', fontSize: 11, color: 'var(--color-blocked)', opacity: 0.7 }}
                          title="Remove this workspace from the app (does not delete the folder)"
                          onClick={() => setConfirmDeleteId(customer.id)}
                        >
                          Forget
                        </button>
                      ) : (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Forget workspace?</span>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '2px 8px', fontSize: 11, color: 'var(--color-blocked)' }}
                            onClick={() => handleForgetCustomer(customer.id)}
                          >
                            Yes
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Missing-repo guidance */}
                {(customer.repositoryStatus === 'missing' || customer.repositoryStatus === 'not_created') && !outcome?.result && (
                  <div className="repo-missing-block">
                    <div className="repo-missing-body">
                      {customer.repositoryStatus === 'missing' ? (
                        <>
                          <span className="repo-missing-title">Repository not found locally</span>
                          {repoPath && (
                            <span className="repo-missing-path">
                              Expected at: <code>{repoPath}</code>
                            </span>
                          )}
                          <span className="repo-missing-hint">
                            Clone the repository into the path above, then sync.
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="repo-missing-title">Path not resolved</span>
                          <span className="repo-missing-hint">
                            Set a <strong>Folder Name</strong> in Edit so the app can resolve a path.
                          </span>
                        </>
                      )}
                    </div>
                    <div className="repo-missing-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleRescan}
                        disabled={rescanning}
                      >
                        {rescanning ? 'Syncing\u2026' : 'Sync'}
                      </button>
                      {crmBaseDir && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => openPath(crmBaseDir).catch(console.warn)}
                        >
                          Open Directory
                        </button>
                      )}
                      {hasTemplate && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--text-muted)' }}
                          onClick={() => setWizardCustomer(customer)}
                          title="Scaffold from template"
                        >
                          Scaffold{'\u2026'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Scaffold outcome banner */}
                {outcome && (
                  <div className={`create-repo-outcome ${outcome.error ? 'create-repo-outcome-error' : 'create-repo-outcome-ok'}`}>
                    <div className="create-repo-outcome-body">
                      {outcome.error ? (
                        <span><strong>Scaffold failed:</strong> {outcome.error}</span>
                      ) : outcome.result ? (
                        <div className="create-repo-outcome-lines">
                          <span>{'\u2713'} Repository created at <code>{outcome.result.targetPath}</code></span>
                          <span className={GIT_INIT_CLASS[outcome.result.gitInit]}>
                            {GIT_INIT_LABEL[outcome.result.gitInit]}
                            {outcome.result.gitMessage ? ` \u2014 ${outcome.result.gitMessage}` : ''}
                            {outcome.result.initialCommitCreated ? ' + initial commit' : ''}
                          </span>
                          {outcome.result.targetPath && (
                            <div className="create-repo-outcome-actions">
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => openPath(outcome.result!.targetPath).catch(console.warn)}
                              >
                                Open Folder
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => openInVscode(outcome.result!.targetPath).catch(console.warn)}
                              >
                                Open in VS Code
                              </button>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 'auto', fontSize: 11, flexShrink: 0 }}
                      onClick={() => dismissOutcome(customer.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {wizardCustomer && (
        <CreateRepoWizard
          customer={wizardCustomer}
          settings={settings}
          onClose={() => setWizardCustomer(null)}
          onCreateRepo={handleCreateRepo}
        />
      )}

      {showCreateForm && (
        <CustomerForm onClose={() => setShowCreateForm(false)} />
      )}

      {editTarget && (
        <CustomerForm
          initialData={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
