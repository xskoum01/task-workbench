import { useState } from 'react';
import type { Customer, RepositoryStatus } from '../types';
import { useApp } from '../context/AppContext';
import CustomerForm from '../components/CustomerForm';
import { openPath } from '../lib/tauriCommands';
import { OTHER_CUSTOMER_ID } from '../data/mockData';

const REPO_STATUS_LABEL: Record<RepositoryStatus, string> = {
  linked: 'Linked context',
  missing: 'Location missing',
  not_created: 'Location unknown',
};

const REPO_STATUS_CLASS: Record<RepositoryStatus, string> = {
  linked: 'repo-status-linked',
  missing: 'repo-status-missing',
  not_created: 'repo-status-not-created',
};

export default function CustomersPage() {
  const {
    customers,
    tasks,
    settings,
    rescanRepositories,
    deleteCustomer,
  } = useApp();

  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const managedCustomers = customers.filter((customer) => customer.id !== OTHER_CUSTOMER_ID);
  const taskCounts = Object.fromEntries(
    managedCustomers.map((customer) => [
      customer.id,
      tasks.filter((task) => task.customerId === customer.id && !task.archivedAt).length,
    ]),
  );
  const crmBaseDir = settings.crmBaseDirectory;

  async function handleRescan() {
    setRescanning(true);
    try {
      await rescanRepositories();
    } finally {
      setRescanning(false);
    }
  }

  async function handleForgetCustomer(id: string) {
    await deleteCustomer(id);
    setConfirmDeleteId(null);
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Areas and context</div>
          <div className="page-subtitle">
            {managedCustomers.length === 0
              ? 'No responsibility areas recorded'
              : `${managedCustomers.length} area${managedCustomers.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {crmBaseDir && (
            <button
              className="btn btn-ghost"
              title="Open the configured context directory"
              onClick={() => openPath(crmBaseDir).catch(console.warn)}
            >
              Open Context Directory
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={handleRescan}
            disabled={rescanning}
            title="Refresh linked location status without changing its contents"
          >
            {rescanning ? 'Refreshing…' : 'Refresh context'}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowCreateForm(true)}>
            <span className="btn-icon">+</span>
            Add Context
          </button>
        </div>
      </div>

      {managedCustomers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-text">No responsibility context yet</div>
          <div className="empty-state-hint">
            Add a customer, team, project, or responsibility area so work keeps its related context.
          </div>
        </div>
      ) : (
        <div className="customer-list">
          {managedCustomers.map((customer) => {
            const contextPath = customer.resolvedRepositoryPath
              ?? customer.repositoryRoot
              ?? (crmBaseDir && customer.folderName
                ? `${crmBaseDir.replace(/[/\\]+$/, '')}/${customer.folderName}`
                : undefined);
            const taskCount = taskCounts[customer.id] ?? 0;
            const isPending = confirmDeleteId === customer.id;

            return (
              <div key={customer.id} className="customer-card-wrapper">
                <div className="customer-card">
                  <div className="customer-shortcode">{customer.shortCode}</div>
                  <div className="customer-info" style={{ flex: 1, minWidth: 0 }}>
                    <div className="customer-name">{customer.name}</div>
                    {contextPath && (
                      <div className="customer-path-row">
                        <span className="customer-path-value" style={{ fontSize: 11, opacity: 0.6 }}>
                          {contextPath}
                        </span>
                      </div>
                    )}
                    {customer.namespace && (
                      <div className="customer-path-row">
                        <span className="customer-path-label">Namespace</span>
                        <span className="customer-path-value">{customer.namespace}</span>
                      </div>
                    )}
                    {customer.notes && <div className="customer-notes">{customer.notes}</div>}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {taskCount} active task{taskCount === 1 ? '' : 's'}
                      </span>
                      {customer.repositoryStatus && (
                        <span className={`repo-status-badge ${REPO_STATUS_CLASS[customer.repositoryStatus]}`}>
                          {REPO_STATUS_LABEL[customer.repositoryStatus]}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {contextPath && customer.repositoryStatus === 'linked' && (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => openPath(contextPath).catch(console.warn)}
                          title="Open the linked context location"
                        >
                          Open
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => setEditTarget(customer)}
                      >
                        Edit
                      </button>
                      {!isPending ? (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 8px', fontSize: 11, color: 'var(--color-blocked)', opacity: 0.7 }}
                          title="Remove this context record; linked files are not changed"
                          onClick={() => setConfirmDeleteId(customer.id)}
                        >
                          Forget
                        </button>
                      ) : (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Forget context?</span>
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
              </div>
            );
          })}
        </div>
      )}

      {showCreateForm && <CustomerForm onClose={() => setShowCreateForm(false)} />}
      {editTarget && (
        <CustomerForm initialData={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}
