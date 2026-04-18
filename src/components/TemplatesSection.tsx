/**
 * TemplatesSection — manages Plugin and Script templates in Settings.
 *
 * Templates are persisted as part of AppSettings.templates[].
 * Each template has a type ('plugin' | 'script'), a source kind
 * ('zip' | 'folder'), and a source path. Only one default per type is allowed.
 */

import { useState, useEffect } from 'react';
import type { AppTemplate, AppTemplateType } from '../types';
import * as tauriApi from '../lib/tauriCommands';
import Icon from './Icon';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortPath(full: string): string {
  // Show only last 2–3 path segments to keep it compact
  const sep = full.includes('\\') ? '\\' : '/';
  const parts = full.split(sep).filter(Boolean);
  return parts.slice(-3).join(sep);
}

function generateId(): string {
  return `tpl-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// ---------------------------------------------------------------------------
// TemplateRow
// ---------------------------------------------------------------------------

interface TemplateRowProps {
  template: AppTemplate;
  isOnlyDefault: boolean;
  onSetDefault: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  pathExists: boolean | null; // null = not yet checked
}

function TemplateRow({
  template,
  onSetDefault,
  onRename,
  onRemove,
  pathExists,
}: TemplateRowProps) {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(template.name);

  function commitRename() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== template.name) {
      onRename(template.id, trimmed);
    } else {
      setNameInput(template.name);
    }
    setEditing(false);
  }

  return (
    <div className="tmpl-row">
      {/* Left: name + badges */}
      <div className="tmpl-row-info">
        {editing ? (
          <input
            className="form-input tmpl-rename-input"
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setNameInput(template.name); setEditing(false); }
            }}
          />
        ) : (
          <span className="tmpl-row-name">{template.name}</span>
        )}

        <span className={`tmpl-badge tmpl-badge--kind`}>
          {template.sourceKind === 'zip' ? 'ZIP' : 'Folder'}
        </span>

        {template.isDefault && (
          <span className="tmpl-badge tmpl-badge--default">Default</span>
        )}

        {pathExists === false && (
          <span className="tmpl-badge tmpl-badge--missing">Missing</span>
        )}
      </div>

      {/* Middle: path */}
      <span className="tmpl-row-path" title={template.sourcePath}>
        {shortPath(template.sourcePath)}
      </span>

      {/* Right: actions */}
      <div className="tmpl-row-actions">
        {!template.isDefault && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onSetDefault(template.id)}
            title="Set as default template for this type"
          >
            Set default
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => { setNameInput(template.name); setEditing(true); }}
          title="Rename this template"
        >
          Rename
        </button>
        <button
          className="btn btn-ghost btn-sm tmpl-btn-remove"
          onClick={() => onRemove(template.id)}
          title="Remove this template"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateGroup — one panel for 'plugin' or 'script'
// ---------------------------------------------------------------------------

interface TemplateGroupProps {
  type: AppTemplateType;
  label: string;
  templates: AppTemplate[];
  pathExistsMap: Record<string, boolean | null>;
  onAdd: (type: AppTemplateType, sourceKind: 'zip' | 'folder', name: string, path: string) => void;
  onSetDefault: (id: string, type: AppTemplateType) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

function TemplateGroup({
  type,
  label,
  templates,
  pathExistsMap,
  onAdd,
  onSetDefault,
  onRename,
  onRemove,
}: TemplateGroupProps) {
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState('');

  async function handlePickZip() {
    setAddError('');
    try {
      const path = await tauriApi.pickFile('ZIP Archives', ['zip']);
      if (!path) return;
      const name = addName.trim() || deriveNameFromPath(path);
      onAdd(type, 'zip', name, path);
      setAdding(false);
      setAddName('');
    } catch (err) {
      setAddError('Could not open file picker.');
    }
  }

  async function handlePickFolder() {
    setAddError('');
    try {
      const path = await tauriApi.pickFolder();
      if (!path) return;
      const name = addName.trim() || deriveNameFromPath(path);
      onAdd(type, 'folder', name, path);
      setAdding(false);
      setAddName('');
    } catch (err) {
      setAddError('Could not open folder picker.');
    }
  }

  function deriveNameFromPath(p: string): string {
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.split(sep).filter(Boolean);
    const base = parts[parts.length - 1] ?? p;
    // Strip .zip extension
    return base.replace(/\.zip$/i, '');
  }

  const defaultCount = templates.filter((t) => t.isDefault).length;

  return (
    <div className="tmpl-group">
      <div className="tmpl-group-header">
        <span className="tmpl-group-label">{label}</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => { setAdding((v) => !v); setAddName(''); setAddError(''); }}
        >
          <Icon name="folder" size={12} /> Add template
        </button>
      </div>

      {/* Add-template inline form */}
      {adding && (
        <div className="tmpl-add-form">
          <input
            className="form-input"
            placeholder="Template name (optional — derived from path if blank)"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <div className="settings-action-row" style={{ flexShrink: 0 }}>
            <button className="btn btn-secondary btn-sm" onClick={handlePickZip}>
              Choose ZIP
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handlePickFolder}>
              Choose Folder
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setAddName(''); setAddError(''); }}>
              Cancel
            </button>
          </div>
          {addError && <span className="tmpl-add-error">{addError}</span>}
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !adding && (
        <div className="tmpl-empty">No {label.toLowerCase()} added yet.</div>
      )}

      {templates.map((tpl) => (
        <TemplateRow
          key={tpl.id}
          template={tpl}
          isOnlyDefault={defaultCount === 1 && tpl.isDefault}
          pathExists={pathExistsMap[tpl.id] ?? null}
          onSetDefault={(id) => onSetDefault(id, type)}
          onRename={onRename}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplatesSection — exported, placed inside the Settings card body
// ---------------------------------------------------------------------------

interface Props {
  templates: AppTemplate[];
  onChange: (updated: AppTemplate[]) => void;
}

export default function TemplatesSection({ templates, onChange }: Props) {
  // Track whether each path exists (checked lazily on first render / mount)
  const [pathExistsMap, setPathExistsMap] = useState<Record<string, boolean | null>>({});

  // Check path existence for all templates (best-effort; non-blocking)
  async function checkPaths(tpls: AppTemplate[]) {
    const results: Record<string, boolean | null> = {};
    await Promise.all(
      tpls.map(async (t) => {
        try {
          results[t.id] = await tauriApi.checkPathExists(t.sourcePath);
        } catch {
          results[t.id] = null;
        }
      }),
    );
    setPathExistsMap(results);
  }

  // Check path existence for all templates once on mount / when templates change
  useEffect(() => {
    if (templates.length > 0) {
      checkPaths(templates);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  // --- mutations ---

  function handleAdd(
    type: AppTemplateType,
    sourceKind: 'zip' | 'folder',
    name: string,
    sourcePath: string,
  ) {
    const newTpl: AppTemplate = {
      id: generateId(),
      name,
      type,
      sourceKind,
      sourcePath,
      // First template of a type auto-becomes default
      isDefault: templates.filter((t) => t.type === type).length === 0,
    };
    const updated = [...templates, newTpl];
    onChange(updated);
    // Check the new path
    tauriApi.checkPathExists(sourcePath).then((exists) => {
      setPathExistsMap((prev) => ({ ...prev, [newTpl.id]: exists }));
    }).catch(() => {});
  }

  function handleSetDefault(id: string, type: AppTemplateType) {
    onChange(
      templates.map((t) =>
        t.type === type ? { ...t, isDefault: t.id === id } : t,
      ),
    );
  }

  function handleRename(id: string, name: string) {
    onChange(templates.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function handleRemove(id: string) {
    const remaining = templates.filter((t) => t.id !== id);
    // If the removed template was default, promote the next one of the same type
    const removed = templates.find((t) => t.id === id);
    if (removed?.isDefault) {
      const sameType = remaining.filter((t) => t.type === removed.type);
      if (sameType.length > 0) {
        const firstId = sameType[0].id;
        onChange(remaining.map((t) => (t.id === firstId ? { ...t, isDefault: true } : t)));
        return;
      }
    }
    onChange(remaining);
  }

  const pluginTemplates = templates.filter((t) => t.type === 'plugin');
  const scriptTemplates = templates.filter((t) => t.type === 'script');

  return (
    <div className="tmpl-section">
      <TemplateGroup
        type="plugin"
        label="Plugin Templates"
        templates={pluginTemplates}
        pathExistsMap={pathExistsMap}
        onAdd={handleAdd}
        onSetDefault={handleSetDefault}
        onRename={handleRename}
        onRemove={handleRemove}
      />
      <TemplateGroup
        type="script"
        label="Script Templates"
        templates={scriptTemplates}
        pathExistsMap={pathExistsMap}
        onAdd={handleAdd}
        onSetDefault={handleSetDefault}
        onRename={handleRename}
        onRemove={handleRemove}
      />
    </div>
  );
}
