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
 *
 * NOTE: "zákazník/zakaznik/customer" are intentionally NOT mapped to Account here.
 * Those words describe the customer context (who commissioned the work), NOT the
 * Dataverse Account entity/table. Only unambiguous entity/table terms trigger Account.
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
  // "account" only when used as entity/table term — NOT matched by zákazník/customer/firma alone.
  [/\baccount\b/i,                               'Account'],
  [/\bcontact\b|\bkontakt\b/i,                   'Contact'],
  [/\blead\b/i,                                  'Lead'],
  [/\bemail\b|\bmail\b/i,                        'Email'],
  [/notification|oznámen/i,                      'Notification'],
  [/integration|integrac/i,                      'Integration'],
  [/\bimport\b/i,                                'Import'],
  [/\breport\b|sestav/i,                         'Report'],
  [/configurati|konfigurac/i,                    'Configuration'],
];

/**
 * Dataverse logical entity name → PascalCase area mapping.
 * Used by explicit entity detection to normalise detected entity names.
 */
const ENTITY_AREA_MAP: Record<string, string> = {
  contact:       'Contact',
  account:       'Account',
  opportunity:   'Opportunity',
  lead:          'Lead',
  incident:      'Incident',
  case:          'Incident',
  quote:         'Quote',
  salesorder:    'SalesOrder',
  order:         'SalesOrder',
  invoice:       'Invoice',
  product:       'Product',
  task:          'Task',
  activity:      'Activity',
  email:         'Email',
  phonecall:     'PhoneCall',
  appointment:   'Appointment',
  contract:      'Contract',
  campaign:      'Campaign',
  pricelevel:    'PriceList',
};

/**
 * Attempts to extract an explicitly declared Dataverse entity from the text.
 * Matches Czech and English patterns such as:
 *   "entita je Contact" / "Entity is Contact" / "na entitě Account" / "For entity Lead"
 * Returns the PascalCase area name (e.g. "Contact") or null if nothing detected.
 */
function detectExplicitEntity(text: string): { area: string; reason: string } | null {
  // Czech and English entity declaration patterns — entity name follows the keyword
  const patterns = [
    /\bentit[ay]\s+je\s+(\w+)/i,          // "entita je Contact"
    /\bentit[au]:\s*(\w+)/i,              // "entita: Contact"
    /\bna\s+entit[ěe]\s+(\w+)/i,         // "na entitě Contact"
    /\bpro\s+entitu\s+(\w+)/i,           // "pro entitu Contact"
    /\bu\s+entity\s+(\w+)/i,             // "u entity Contact"
    /\bentity\s+is\s+(\w+)/i,            // "entity is Contact"
    /\bentity:\s*(\w+)/i,                // "entity: Contact"
    /\bfor\s+entity\s+(\w+)/i,           // "for entity Contact"
    /\bon\s+(\w+)\s+entity/i,            // "on Contact entity"
    /\b(\w+)\s+entity\b/i,              // "Contact entity" (looser)
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const detected = m[1].toLowerCase();
    const mapped = ENTITY_AREA_MAP[detected];
    if (mapped) return { area: mapped, reason: `explicit entity: ${mapped}` };
    // Unknown entity — PascalCase it as-is
    const pascal = detected.charAt(0).toUpperCase() + detected.slice(1);
    return { area: pascal, reason: `explicit entity: ${pascal}` };
  }
  return null;
}

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
 *   2. Explicit entity declaration in text ("entita je Contact", "entity is X", etc.)
 *   3. Keyword match in title
 *   4. Keyword match in full body — with existing-project reuse
 *   5. Customer namespace base
 *   6. Generic Navertica.<PascalCustomerName>
 */
function inferPluginSuggestions(
  task: Task,
  customer: Customer,
  existingProjects: string[],
): { projectName: string; namespace: string; suggestionReason: string } {
  const fullText = `${task.title} ${task.originalMessage ?? ''}`;

  // 1. Use existing selection on the task when it already follows the convention
  if (task.selectedPluginProject) {
    const area = areaFromNaverticaProject(task.selectedPluginProject);
    if (area) {
      const name = `Navertica.${area}`;
      return { projectName: name, namespace: name, suggestionReason: 'existing project selection' };
    }
  }

  // 2. Explicit entity declaration — highest-confidence signal, beats keyword matches.
  //    Check title first, then full body.
  const explicitTitle = detectExplicitEntity(task.title);
  const explicitBody  = detectExplicitEntity(fullText);
  const explicit = explicitTitle ?? explicitBody;
  if (explicit) {
    // Prefer an existing project with this area if one exists
    const existing = existingProjects.find((p) => {
      const a = areaFromNaverticaProject(p);
      return a && a.toLowerCase() === explicit.area.toLowerCase();
    });
    const resolvedArea = existing ? areaFromNaverticaProject(existing)! : explicit.area;
    const name = `Navertica.${resolvedArea}`;
    return { projectName: name, namespace: name, suggestionReason: explicit.reason };
  }

  // 3. Title keyword
  for (const [pattern, area] of AREA_KEYWORDS) {
    if (pattern.test(task.title)) {
      const name = `Navertica.${area}`;
      return { projectName: name, namespace: name, suggestionReason: 'task title keyword' };
    }
  }

  // 4. Full body keyword — also try to reuse an existing project folder with that area
  for (const [pattern, area] of AREA_KEYWORDS) {
    if (pattern.test(fullText)) {
      const existing = existingProjects.find((p) => {
        const a = areaFromNaverticaProject(p);
        return a && a.toLowerCase() === area.toLowerCase();
      });
      const resolvedArea = existing ? areaFromNaverticaProject(existing)! : area;
      const name = `Navertica.${resolvedArea}`;
      return { projectName: name, namespace: name, suggestionReason: existing ? 'existing project' : 'task keywords' };
    }
  }

  // 5. Customer namespace without trailing ".Plugins"
  if (customer.namespace) {
    const base = customer.namespace.replace(/\.Plugins$/i, '');
    return { projectName: base, namespace: base, suggestionReason: 'customer namespace' };
  }

  // 6. Generic fallback
  const safeName = toPascalCase(customer.name) || 'Plugin';
  const name = `Navertica.${safeName}`;
  return { projectName: name, namespace: name, suggestionReason: 'customer name' };
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
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
          Suggested from {suggested.suggestionReason}
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
