import { useState, useEffect, useRef } from 'react';
import type { Customer } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import { checkPathExists } from '../lib/tauriCommands';

interface CustomerFormProps {
  /** If provided, the form operates in edit mode for this customer. */
  initialData?: Customer;
  onClose: () => void;
}

type FormState = {
  name:           string;
  shortCode:      string;
  folderName:     string;
  repositoryName: string;
  repositoryRoot: string;
  pluginFolder:   string;
  scriptFolder:   string;
  namespace:      string;
  notes:          string;
};

function blankForm(): FormState {
  return {
    name:           '',
    shortCode:      '',
    folderName:     '',
    repositoryName: '',
    repositoryRoot: '',
    pluginFolder:   '',
    scriptFolder:   '',
    namespace:      '',
    notes:          '',
  };
}

function customerToForm(c: Customer): FormState {
  return {
    name:           c.name,
    shortCode:      c.shortCode,
    folderName:     c.folderName      ?? '',
    repositoryName: c.repositoryName  ?? '',
    repositoryRoot: c.repositoryRoot  ?? '',
    pluginFolder:   c.pluginFolder    ?? '',
    scriptFolder:   c.scriptFolder    ?? '',
    namespace:      c.namespace       ?? '',
    notes:          c.notes           ?? '',
  };
}

/** Converts empty strings to undefined for optional fields before saving. */
function formToCustomer(form: FormState): Omit<Customer, 'id'> {
  const opt = (v: string) => v.trim() || undefined;
  return {
    name:           form.name.trim(),
    shortCode:      form.shortCode.trim().toUpperCase(),
    folderName:     opt(form.folderName),
    repositoryName: opt(form.repositoryName),
    repositoryRoot: opt(form.repositoryRoot),
    pluginFolder:   opt(form.pluginFolder),
    scriptFolder:   opt(form.scriptFolder),
    namespace:      opt(form.namespace),
    notes:          opt(form.notes),
  };
}

/** Resolves the expected repository path from baseDir + folderName. */
function resolveRepoPath(baseDir: string, folderName: string): string {
  if (!baseDir || !folderName) return '';
  return `${baseDir.replace(/[/\\]+$/, '')}/${folderName.trim()}`;
}

/** Derives a short code from a folder name (strips CRM_ prefix, takes first 6 alphanum). */
function deriveShortCode(folderName: string): string {
  const stripped = folderName.replace(/^CRM_/i, '');
  return stripped.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6) || '';
}

export default function CustomerForm({ initialData, onClose }: CustomerFormProps) {
  const { createCustomer, updateCustomer, settings } = useApp();
  const isEditing = !!initialData;

  const [form, setForm]       = useState<FormState>(
    isEditing ? customerToForm(initialData!) : blankForm(),
  );
  const [saving, setSaving]   = useState(false);
  const [validationError, setValidationError] = useState('');
  const [showAdvanced, setShowAdvanced]       = useState(false);

  // --- Repository path preview ---
  const baseDir     = settings.crmBaseDirectory ?? '';
  const resolvedPath = resolveRepoPath(baseDir, form.folderName);
  const [pathExists, setPathExists] = useState<boolean | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPathExists(null);
    if (!resolvedPath) return;

    // Debounce the Tauri call while the user is typing
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(async () => {
      try {
        const exists = await checkPathExists(resolvedPath);
        setPathExists(exists);
      } catch {
        setPathExists(null);
      }
    }, 400);

    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [resolvedPath]);

  // Auto-derive shortCode from folderName when not manually edited
  const shortCodeManualRef = useRef(isEditing);
  useEffect(() => {
    if (shortCodeManualRef.current) return;
    if (form.folderName) {
      setForm((prev) => ({ ...prev, shortCode: deriveShortCode(form.folderName) }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.folderName]);

  function set<K extends keyof FormState>(key: K, value: string) {
    if (key === 'shortCode') shortCodeManualRef.current = true;
    setForm((prev) => ({ ...prev, [key]: value }));
    setValidationError('');
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      setValidationError('Name is required.');
      return;
    }
    if (!form.shortCode.trim()) {
      setValidationError('Short code is required.');
      return;
    }
    if (form.shortCode.trim().length > 6) {
      setValidationError('Short code must be 6 characters or fewer.');
      return;
    }

    setSaving(true);
    try {
      const data = formToCustomer(form);
      if (isEditing) {
        await updateCustomer(initialData!.id, data);
      } else {
        await createCustomer(data);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  // --- Path preview status ---
  const pathPreviewStatus =
    !resolvedPath           ? 'none' :
    pathExists === null     ? 'checking' :
    pathExists              ? 'exists' : 'free';

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
        {saving ? 'Saving\u2026' : isEditing ? 'Save Changes' : 'Create Workspace'}
      </button>
    </>
  );

  return (
    <Modal
      title={isEditing ? `Edit \u2014 ${initialData!.name}` : 'New Workspace'}
      onClose={onClose}
      size="lg"
      footer={footer}
    >
      {/* Basic info */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label form-label-required">Display Name</label>
          <input
            className="form-input"
            type="text"
            placeholder="Contoso Ltd."
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            autoFocus
          />
        </div>

        <div className="form-group">
          <label className="form-label form-label-required">Short Code</label>
          <input
            className="form-input"
            type="text"
            placeholder="CTG"
            maxLength={6}
            value={form.shortCode}
            onChange={(e) => set('shortCode', e.target.value.toUpperCase())}
          />
          <span className="form-hint">{'2\u20136 uppercase characters'}</span>
        </div>
      </div>

      <div className="form-section-divider" />
      <div className="form-section-title">Folder / Path</div>

      {/* Folder name + namespace */}
      <div className="form-row">
        <div className="form-group" style={{ flex: 2 }}>
          <label className="form-label">Folder Name</label>
          <input
            className="form-input"
            type="text"
            placeholder="CRM_Contoso"
            value={form.folderName}
            onChange={(e) => set('folderName', e.target.value)}
          />
          <span className="form-hint">Subfolder inside the CRM base directory</span>
        </div>

        <div className="form-group">
          <label className="form-label">.NET Namespace</label>
          <input
            className="form-input"
            type="text"
            placeholder="Contoso.CRM"
            value={form.namespace ?? ''}
            onChange={(e) => set('namespace', e.target.value)}
          />
        </div>
      </div>

      {/* Repository path preview */}
      {resolvedPath && (
        <div className="repo-preview-row">
          <span className="repo-preview-label">Resolved path</span>
          <code className="repo-preview-path">{resolvedPath}</code>
          <span className={`repo-preview-badge repo-preview-${pathPreviewStatus}`}>
            {pathPreviewStatus === 'checking' ? '\u2026' :
             pathPreviewStatus === 'exists'   ? 'Exists' :
             pathPreviewStatus === 'free'     ? 'Not found locally' : ''}
          </span>
        </div>
      )}
      {!baseDir && form.folderName && (
        <p className="form-hint" style={{ color: 'var(--color-overdue)' }}>
          {'CRM base directory is not configured \u2014 set it in Settings to resolve the path.'}
        </p>
      )}

      {/* Advanced overrides */}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 11, padding: '2px 8px', opacity: 0.7 }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '\u25bc' : '\u25ba'} Advanced overrides
        </button>
      </div>

      {showAdvanced && (
        <>
          <div className="form-section-divider" />
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Repository Root Override</label>
              <input
                className="form-input"
                type="text"
                placeholder="C:/Dev/repos/contoso-crm"
                value={form.repositoryRoot ?? ''}
                onChange={(e) => set('repositoryRoot', e.target.value)}
              />
              <span className="form-hint">Overrides base directory resolution</span>
            </div>
            <div className="form-group">
              <label className="form-label">Repository Name</label>
              <input
                className="form-input"
                type="text"
                placeholder="contoso-crm"
                value={form.repositoryName ?? ''}
                onChange={(e) => set('repositoryName', e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Plugin Folder</label>
              <input
                className="form-input"
                type="text"
                placeholder={'\u2026/src/Plugins'}
                value={form.pluginFolder ?? ''}
                onChange={(e) => set('pluginFolder', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Script Folder</label>
              <input
                className="form-input"
                type="text"
                placeholder={'…/Scripts  (leave blank to use <repo>/Scripts)'}
                value={form.scriptFolder ?? ''}
                onChange={(e) => set('scriptFolder', e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <div className="form-section-divider" />

      {/* Notes */}
      <div className="form-group">
        <label className="form-label">Notes</label>
        <textarea
          className="form-textarea"
          placeholder={'Contact person, project background, special considerations\u2026'}
          value={form.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)}
        />
      </div>


      {validationError && (
        <div style={{ fontSize: 12, color: 'var(--color-blocked)' }}>
          {validationError}
        </div>
      )}
    </Modal>
  );
}

