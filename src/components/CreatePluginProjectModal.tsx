/**
 * CreatePluginProjectModal — wizard for scaffolding a new plugin project from a local template.
 *
 * Copies <pluginTemplateFolder> → <pluginsDir>/<ProjectName>, replacing:
 *   __PROJECT_NAME__  in file content and file names
 *   __NAMESPACE__     in file content and file names
 *
 * Does NOT automate Visual Studio — it creates the directory structure on disk,
 * then optionally opens the .sln / .csproj from the created folder.
 * Solution and project are placed in the same directory (no nested subfolder).
 *
 * Naming convention:
 *   Assembly / Project:  Navertica.<BroaderAreaName>  e.g. Navertica.Project
 *   Plugin class:        specific action only,         e.g. MoveProjectBpfOnCreate
 */
import { useState } from 'react';
import type { Task, Customer } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface Props {
  task: Task;
  customer: Customer;
  pluginsDir: string;
  /** Existing plugin project folder names used as naming-convention hints. */
  existingPluginProjects?: string[];
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

/** Exported so callers like TaskDetail can derive the same default project/namespace. */
export { sanitize, inferPluginSuggestions };

/** Remove Czech/Slovak diacritics so words can be PascalCased safely. */
function removeDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Convert an arbitrary string to PascalCase, e.g. "sales order" → "SalesOrder". */
function toPascalCase(s: string): string {
  return removeDiacritics(s)
    .replace(/[_\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Ordered keyword → broader area name table (Czech + English, longer patterns first).
 * First match wins.
 */
const AREA_KEYWORDS: [RegExp, string][] = [
  [/bpf|business process/i,                      'Workflow'],
  [/workflow|pracovn[íi] postup/i,               'Workflow'],
  [/authori[sz]|autorizac/i,                     'Authorization'],
  [/approval|schválen[íi]|schvalen/i,            'Approval'],
  [/project|projekt/i,                           'Project'],
  [/opportunit|příležitost|prilezitost/i,        'Opportunity'],
  [/salesorder|objednávk|objednavk|order\b/i,    'SalesOrder'],
  [/quote|nabídka|nabidka/i,                     'Quote'],
  [/invoice|faktur/i,                            'Invoice'],
  [/incident|případ|pripad/i,                    'Incident'],
  [/activity|aktivita/i,                         'Activity'],
  [/interaction|interakc/i,                      'Interaction'],
  [/campaign|kampaň|kampan/i,                    'Campaign'],
  [/contract|smlouv/i,                           'Contract'],
  [/product|produkt/i,                           'Product'],
  [/pricelevel|ceník|cenik/i,                    'PriceList'],
  [/calendar|schůzk/i,                           'Calendar'],
  [/account\b|zákazník|zakaznik|firma\b/i,       'Account'],
  [/contact\b|kontakt/i,                         'Contact'],
  [/lead\b/i,                                    'Lead'],
  [/email\b|mail\b/i,                            'Email'],
  [/notification|oznámen/i,                      'Notification'],
  [/integration|integrac/i,                      'Integration'],
  [/import\b/i,                                  'Import'],
  [/report\b|sestav/i,                           'Report'],
  [/configurati|konfigurac/i,                    'Configuration'],
];

/** Extract the area segment from a Navertica.* project name, or return null. */
function areaFromNaverticaProject(projectName: string): string | null {
  if (!projectName.toLowerCase().startsWith('navertica.')) return null;
  return projectName.slice('navertica.'.length) || null;
}

/**
 * Determine the best Navertica.<Area> project name and matching namespace.
 *
 * Priority:
 *   1. Already-selected plugin project on the task (strong existing context)
 *   2. Keyword in task title
 *   3. Keyword in full task body
 *   4. Existing plugin project list matched by keyword
 *   5. Customer namespace base
 *   6. Generic Navertica.<PascalCustomerName>
 */
function inferPluginSuggestions(
  task: Task,
  customer: Customer,
  existingProjects: string[],
): { projectName: string; namespace: string } {
  const fullText = `${task.title} ${task.originalMessage ?? ''}`;

  // 1. Use existing selection on the task when it already follows the convention
  if (task.selectedPluginProject) {
    const area = areaFromNaverticaProject(task.selectedPluginProject);
    if (area) {
      const name = `Navertica.${area}`;
      return { projectName: name, namespace: name };
    }
  }

  // 2. Title keyword
  for (const [pattern, area] of AREA_KEYWORDS) {
    if (pattern.test(task.title)) {
      const name = `Navertica.${area}`;
      return { projectName: name, namespace: name };
    }
  }

  // 3. Full body keyword — also try to reuse an existing project folder with that area
  for (const [pattern, area] of AREA_KEYWORDS) {
    if (pattern.test(fullText)) {
      // Prefer an already-present project folder for this area to avoid naming drift
      const existing = existingProjects.find((p) => {
        const a = areaFromNaverticaProject(p);
        return a && a.toLowerCase() === area.toLowerCase();
      });
      const resolvedArea = existing ? areaFromNaverticaProject(existing)! : area;
      const name = `Navertica.${resolvedArea}`;
      return { projectName: name, namespace: name };
    }
  }

  // 4. Customer namespace without trailing ".Plugins"
  if (customer.namespace) {
    const base = customer.namespace.replace(/\.Plugins$/i, '');
    return { projectName: base, namespace: base };
  }

  // 5. Generic fallback
  const safeName = toPascalCase(customer.name) || 'Plugin';
  const name = `Navertica.${safeName}`;
  return { projectName: name, namespace: name };
}

export default function CreatePluginProjectModal({
  task,
  customer,
  pluginsDir,
  existingPluginProjects = [],
  onCreated,
  onClose,
}: Props) {
  const { settings } = useApp();
  const templateDir = settings.pluginTemplateFolder ?? '';

  // Smart defaults derived from task + customer + existing project context
  const suggested = inferPluginSuggestions(task, customer, existingPluginProjects);

  const [form, setForm] = useState<FormState>({
    projectName:        suggested.projectName,
    namespace:          suggested.namespace,
    // Default to false: the task-specific plugin class is created in the Generate Draft step.
    // Check this only if you want a generic starter class alongside the task-specific one.
    createInitialClass: false,
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
    // No check for templateDir — the backend falls back to the built-in stub when it is empty.
    setCreating(true);
    setError(null);
    try {
      const createdPath = await tauriApi.createPluginProjectFromTemplate(
        templateDir,
        pluginsDir,
        projectName,
        form.namespace.trim() || suggested.namespace,
        form.createInitialClass,
      );

      if (form.openAfterCreate) {
        // Try to open .sln; fall back to .csproj; fall back to folder
        // The Rust command returns the solution root. The .sln is at solutionRoot/ProjectName.sln
        // The .csproj is one level deeper: solutionRoot/ProjectName/ProjectName.csproj
        // Always use openWithShell so Visual Studio is used (not VS Code).
        const slns = await tauriApi.listDirectoryFiles(createdPath, 'sln').catch(() => [] as string[]);
        if (slns.length > 0) {
          await tauriApi.openWithShell(`${createdPath}/${slns[0]}`).catch(() => {});
        } else {
          // .sln not found — try .csproj in the nested project subfolder
          const projDir = `${createdPath}/${projectName}`;
          const csprojs = await tauriApi.listDirectoryFiles(projDir, 'csproj').catch(() => [] as string[]);
          if (csprojs.length > 0) {
            await tauriApi.openWithShell(`${projDir}/${csprojs[0]}`).catch(() => {});
          } else {
            await tauriApi.openWithShell(createdPath).catch(() => {});
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
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          No custom template configured — a built-in default Dataverse plugin stub will be used.
          Set a Plugin Template folder in Settings to use your own template instead.
        </div>
      )}
      {templateDir && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          Template: <code style={{ fontFamily: 'monospace' }}>{templateDir}</code>
        </div>
      )}

      {/* Target location — solution and project land in the same directory */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        Target: <code style={{ fontFamily: 'monospace' }}>{pluginsDir}/</code>
        <span style={{ fontWeight: 600 }}>{sanitize(form.projectName) || '<ProjectName>'}</span>
      </div>

      {/* Project name */}
      <div className="form-group">
        <label className="form-label form-label-required">Project / Assembly Name</label>
        <input
          className="form-input"
          type="text"
          placeholder="e.g. Navertica.Project"
          value={form.projectName}
          onChange={(e) => set('projectName', e.target.value)}
          autoFocus
        />
        <div className="form-hint">
          Convention: <code>Navertica.&lt;BroaderArea&gt;</code>. Used for the solution folder name,
          .sln, .csproj, and the <code>__PROJECT_NAME__</code> placeholder.
          Standard VS layout: <code>{sanitize(form.projectName) || 'ProjectName'}/{sanitize(form.projectName) || 'ProjectName'}/</code>.
        </div>
      </div>

      {/* Namespace */}
      <div className="form-group">
        <label className="form-label">Root Namespace</label>
        <input
          className="form-input"
          type="text"
          placeholder={suggested.namespace}
          value={form.namespace}
          onChange={(e) => set('namespace', e.target.value)}
        />
        <div className="form-hint">
          Replaces <code>__NAMESPACE__</code> in all template files. Defaults to the project name.
        </div>
      </div>

      {/* Options */}
      <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <label className="form-checkbox-row">
          <input
            type="checkbox"
            checked={form.createInitialClass}
            onChange={(e) => set('createInitialClass', e.target.checked)}
          />
          <span>
            Create generic starter plugin class
            <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              Leave unchecked — the task-specific class is generated by Generate Draft.
            </span>
          </span>
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
