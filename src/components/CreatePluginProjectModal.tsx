/**
 * CreatePluginProjectModal — wizard for scaffolding a new plugin project from a local template.
 *
 * Copies <pluginTemplateFolder> → <pluginsDir>/<ProjectName>, replacing:
 *   __PROJECT_NAME__  in file content and file names
 *   __NAMESPACE__     in file content and file names
 *
 * Does NOT automate Visual Studio — it creates the directory structure on disk,
 * then optionally opens the .sln / .csproj from the created folder.
 */
import { useState } from 'react';
import type { Customer } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface Props {
  customer: Customer;
  pluginsDir: string;
  /** Called with the created project folder path when creation succeeds. */
  onCreated: (projectPath: string) => void;
  onClose: () => void;
}

interface FormState {
  projectName: string;
  namespace: string;
  createInitialClass: boolean;
  openAfterCreate: boolean;
}

function sanitize(name: string): string {
  // PascalCase-safe: strip forbidden filesystem chars
  return name.replace(/[^a-zA-Z0-9._-]/g, '');
}

export default function CreatePluginProjectModal({ customer, pluginsDir, onCreated, onClose }: Props) {
  const { settings } = useApp();
  const templateDir = settings.pluginTemplateFolder ?? '';

  const defaultNamespace = customer.namespace ?? `${sanitize(customer.name)}.Plugins`;

  const [form, setForm] = useState<FormState>({
    projectName:        '',
    namespace:          defaultNamespace,
    createInitialClass: true,
    openAfterCreate:    true,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  async function handleCreate() {
    const projectName = sanitize(form.projectName.trim());
    if (!projectName) { setError('Project name is required.'); return; }
    if (!templateDir) {
      setError('Plugin template folder is not configured. Set it in Settings → Plugin Template.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const createdPath = await tauriApi.createPluginProjectFromTemplate(
        templateDir,
        pluginsDir,
        projectName,
        form.namespace.trim() || defaultNamespace,
        form.createInitialClass,
      );

      if (form.openAfterCreate) {
        // Try to open .sln; fall back to .csproj; fall back to folder
        const slns = await tauriApi.listDirectoryFiles(createdPath, 'sln').catch(() => [] as string[]);
        if (slns.length > 0) {
          await tauriApi.openWithShell(`${createdPath}/${slns[0]}`).catch(() => {});
        } else {
          const csprojs = await tauriApi.listDirectoryFiles(createdPath, 'csproj').catch(() => [] as string[]);
          if (csprojs.length > 0) {
            await tauriApi.openInVscode(`${createdPath}/${csprojs[0]}`).catch(() => {});
          } else {
            await tauriApi.openInVscode(createdPath).catch(() => {});
          }
        }
      }

      onCreated(createdPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={creating}>Cancel</button>
      <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !form.projectName.trim()}>
        {creating ? 'Creating…' : 'Create Project'}
      </button>
    </>
  );

  return (
    <Modal title="Create Plugin Project" onClose={onClose} footer={footer} size="md">

      {/* Template status */}
      {!templateDir && (
        <div className="detail-fs-error" style={{ marginBottom: 12 }}>
          No plugin template folder configured. Open Settings and set a Plugin Template folder path.
        </div>
      )}
      {templateDir && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          Template: <code style={{ fontFamily: 'monospace' }}>{templateDir}</code>
        </div>
      )}

      {/* Target location */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        Target: <code style={{ fontFamily: 'monospace' }}>{pluginsDir}/</code>
        <span style={{ fontWeight: 600 }}>{sanitize(form.projectName) || '<ProjectName>'}</span>
      </div>

      {/* Project name */}
      <div className="form-group">
        <label className="form-label form-label-required">Project Name</label>
        <input
          className="form-input"
          type="text"
          placeholder="e.g. Contoso.CRM.Accounting"
          value={form.projectName}
          onChange={(e) => set('projectName', e.target.value)}
          autoFocus
        />
        <div className="form-hint">Used for the folder name, .csproj, and __PROJECT_NAME__ placeholder.</div>
      </div>

      {/* Namespace */}
      <div className="form-group">
        <label className="form-label">Namespace</label>
        <input
          className="form-input"
          type="text"
          placeholder={defaultNamespace}
          value={form.namespace}
          onChange={(e) => set('namespace', e.target.value)}
        />
        <div className="form-hint">Replaces __NAMESPACE__ in all template files.</div>
      </div>

      {/* Options */}
      <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <label className="form-checkbox-row">
          <input
            type="checkbox"
            checked={form.createInitialClass}
            onChange={(e) => set('createInitialClass', e.target.checked)}
          />
          <span>Create initial plugin class file</span>
        </label>
        <label className="form-checkbox-row">
          <input
            type="checkbox"
            checked={form.openAfterCreate}
            onChange={(e) => set('openAfterCreate', e.target.checked)}
          />
          <span>Open project after creation</span>
        </label>
      </div>

      {/* Error */}
      {error && (
        <div className="detail-fs-error" style={{ marginTop: 12 }}>! {error}</div>
      )}
    </Modal>
  );
}
