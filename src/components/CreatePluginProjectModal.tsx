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
  legacyStyle: boolean;
}

interface ScaffoldCheck { label: string; ok: boolean; path: string };

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
 * Determine the best project name and matching namespace for a new plugin project.
 *
 * Priority:
 *   0. Explicitly confirmed plugin project from workflow setup — never override the user's choice
 *   1a. Desired project name (preserved after a deleted project so the modal re-opens with the same name)
 *   1b. Already-selected plugin project on the task
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

  // 0. Confirmed plugin project from Confirm Setup — highest priority.
  //    The user explicitly chose this name; never override it with entity/keyword inference.
  if (task.workflowSetup?.pluginProject) {
    const name = task.workflowSetup.pluginProject;
    return { projectName: name, namespace: name, suggestionReason: 'confirmed setup' };
  }

  // 1a. Desired project name — preserved when a project was deleted so the modal re-opens
  //     with the same name the user previously intended, without running inference again.
  if (task.workflowSetup?.desiredPluginProject) {
    const dp = task.workflowSetup.desiredPluginProject;
    return { projectName: dp, namespace: dp, suggestionReason: 'previous project name' };
  }

  // 1b. Already-selected project on the task (any naming convention, not only Navertica.*).
  if (task.selectedPluginProject) {
    const name = task.selectedPluginProject;
    // If it follows the Navertica.* convention, keep that convention; otherwise use as-is.
    const area = areaFromNaverticaProject(name);
    const canonical = area ? `Navertica.${area}` : name;
    return { projectName: canonical, namespace: canonical, suggestionReason: 'existing project selection' };
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

  const suggested = inferPluginSuggestions(task, customer, existingPluginProjects);

  const [form, setForm] = useState<FormState>({
    projectName:        suggested.projectName,
    namespace:          suggested.namespace,
    createInitialClass: false,
    openAfterCreate:    true,
    // Default to legacy style for Dynamics 365 plugin development.
    // Custom templates ignore this flag and use the template as-is.
    legacyStyle:        true,
  });
  const [creating, setCreating]               = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [checks, setChecks]                   = useState<ScaffoldCheck[] | null>(null);
  const [showAdvanced, setShowAdvanced]       = useState(false);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
    setError(null);
    setChecks(null);
  }

  const isCustomTemplate = !!templateDir;
  const pn = sanitize(form.projectName.trim()) || '<ProjectName>';

  // Files that will be created (for preview)
  const previewFiles: string[] = [
    `${pn}.sln`,
    `${pn}/${pn}.csproj`,
    ...((!isCustomTemplate && form.legacyStyle)
      ? [`${pn}/packages.config`, `${pn}/app.config`, `${pn}/key.snk`, `${pn}/Properties/AssemblyInfo.cs`]
      : []),
    ...(form.createInitialClass ? [`${pn}/${pn.split('.').pop() ?? pn}Plugin.cs`] : []),
  ];

  async function handleCreate() {
    const projectName = sanitize(form.projectName.trim());
    if (!projectName) { setError('Project name is required.'); return; }
    setCreating(true);
    setError(null);
    setChecks(null);
    try {
      const createdPath = await tauriApi.createPluginProjectFromTemplate(
        templateDir,
        pluginsDir,
        projectName,
        form.namespace.trim() || suggested.namespace,
        form.createInitialClass,
        !isCustomTemplate && form.legacyStyle,
      );

      // Post-creation verification
      if (!isCustomTemplate && form.legacyStyle) {
        const projDir = `${createdPath}/${projectName}`;
        const checkItems: ScaffoldCheck[] = await Promise.all([
          { label: `${projectName}.sln`,              path: `${createdPath}/${projectName}.sln` },
          { label: `${projectName}.csproj`,           path: `${projDir}/${projectName}.csproj` },
          { label: 'packages.config',                 path: `${projDir}/packages.config` },
          { label: 'app.config',                      path: `${projDir}/app.config` },
          { label: 'key.snk',                         path: `${projDir}/key.snk` },
          { label: 'Properties/AssemblyInfo.cs',      path: `${projDir}/Properties/AssemblyInfo.cs` },
        ].map(async (item) => ({
          ...item,
          ok: await tauriApi.checkPathExists(item.path).catch(() => false),
        })));
        setChecks(checkItems);
      }

      if (form.openAfterCreate) {
        const slns = await tauriApi.listDirectoryFiles(createdPath, 'sln').catch(() => [] as string[]);
        if (slns.length > 0) {
          await tauriApi.openWithShell(`${createdPath}/${slns[0]}`).catch(() => {});
        } else {
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

      {/* ── Source / scaffold info ─────────────────────────────────────── */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        {isCustomTemplate ? (
          <>
            <span style={{ color: 'var(--color-done, #3fb950)', fontWeight: 600 }}>✓ </span>
            Using plugin template:{' '}
            <code style={{ fontFamily: 'monospace' }}>{templateDir}</code>
          </>
        ) : (
          <>
            No plugin template configured — using built-in legacy CRM plugin scaffold.
            {' '}<span style={{ color: 'var(--text-disabled, var(--text-muted))', opacity: 0.7 }}>
              Set Plugin Template Folder in Settings to use your Visual Studio plugin template.
            </span>
          </>
        )}
      </div>

      {/* ── Target location ───────────────────────────────────────────── */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        Target: <code style={{ fontFamily: 'monospace' }}>{pluginsDir}/</code>
        <span style={{ fontWeight: 600 }}>{pn}</span>
      </div>

      {/* ── Project name ──────────────────────────────────────────────── */}
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
          Convention: <code>Navertica.&lt;BroaderArea&gt;</code>. Used for folder name, .sln, .csproj.
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          Suggested from: {suggested.suggestionReason}
        </div>
      </div>

      {/* ── Namespace ─────────────────────────────────────────────────── */}
      <div className="form-group">
        <label className="form-label">Root Namespace</label>
        <input
          className="form-input"
          type="text"
          placeholder={suggested.namespace}
          value={form.namespace}
          onChange={(e) => set('namespace', e.target.value)}
        />
        <div className="form-hint">Replaces <code>__NAMESPACE__</code>. Defaults to project name.</div>
      </div>

      {/* ── Files preview ─────────────────────────────────────────────── */}
      <div className="form-group" style={{ marginTop: 4 }}>
        <label className="form-label">Files that will be created</label>
        {isCustomTemplate ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Files are copied from the configured template. The following are excluded:{' '}
            <code>.github</code>, <code>.vs</code>, <code>bin</code>, <code>obj</code>,{' '}
            <code>packages/</code>, <code>key.snk</code>.
            A fresh <code>key.snk</code> will be generated in the project folder.
            The template folder base name is replaced with the new project name.
          </div>
        ) : (
          <div style={{
            background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 11.5,
            fontFamily: 'var(--font-mono, Consolas, monospace)', lineHeight: 1.8,
            color: 'var(--text-muted)',
          }}>
            {previewFiles.map((f) => <div key={f}>{f}</div>)}
          </div>
        )}
      </div>

      {/* ── Primary option: open after create ─────────────────────────── */}
      <div style={{ marginTop: 4 }}>
        <label className="form-checkbox-row">
          <input type="checkbox" checked={form.openAfterCreate}
            onChange={(e) => set('openAfterCreate', e.target.checked)} />
          <span>Open project after creation</span>
        </label>
      </div>

      {/* ── Advanced ──────────────────────────────────────────────────── */}
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className="td-advanced-btn"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '▲ Hide advanced options' : '▼ Advanced options'}
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>

            {/* Starter class option */}
            <label className="form-checkbox-row">
              <input type="checkbox" checked={form.createInitialClass}
                onChange={(e) => set('createInitialClass', e.target.checked)} />
              <span>
                Create generic starter plugin class
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  Leave unchecked — Generate Draft creates the task-specific plugin class.
                </span>
              </span>
            </label>

            {/* Built-in scaffold style (shown only when no template configured) */}
            {!isCustomTemplate && (
              <div>
                <label className="form-label" style={{ marginBottom: 6 }}>Built-in scaffold style</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${form.legacyStyle ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => set('legacyStyle', true)}
                  >
                    Legacy packages.config
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${!form.legacyStyle ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => set('legacyStyle', false)}
                  >
                    SDK-style PackageReference
                  </button>
                </div>
                <div className="form-hint" style={{ marginTop: 4 }}>
                  {form.legacyStyle
                    ? 'Legacy: packages.config + app.config + key.snk + Properties/AssemblyInfo.cs. Recommended for CRM plugins.'
                    : 'SDK style: PackageReference in .csproj. Simpler, no packages.config, no assembly signing.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Post-creation verification results ───────────────────────── */}
      {checks && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 5, color: 'var(--text-muted)' }}>
            Verification
          </div>
          {checks.map((c) => (
            <div key={c.label} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 11.5, lineHeight: 1.7 }}>
              <span style={{ color: c.ok ? 'var(--color-done, #3fb950)' : 'var(--color-warning, #d29922)', fontWeight: 700 }}>
                {c.ok ? '✓' : '!'}
              </span>
              <span style={{ fontFamily: 'monospace', color: c.ok ? 'var(--text-muted)' : 'var(--color-warning, #d29922)' }}>
                {c.label}{!c.ok ? ' — missing' : ''}
              </span>
            </div>
          ))}
          {checks.some((c) => !c.ok) && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Missing files can be created manually. key.snk:{' '}
              <code style={{ fontFamily: 'monospace' }}>sn.exe -k key.snk</code>
            </div>
          )}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────── */}
      {error && <div className="detail-fs-error" style={{ marginTop: 12 }}>! {error}</div>}
    </Modal>
  );
}
