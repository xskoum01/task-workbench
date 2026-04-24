/**
 * AiReviewersSettingsPanel — Settings sub-panel for managing AI reviewer configs.
 *
 * Renders the merged list of reviewers (defaults + user overrides) and lets the
 * user select, edit, and save each one. Accepts external `configs` from the
 * parent's draft settings and emits `onChange` on every change.
 */
import { useState } from 'react';
import type { AiReviewerConfig } from '../types';
import { mergeWithDefaults } from '../lib/aiReviewers';
import AiReviewerEditor from './AiReviewerEditor';

interface Props {
  configs: AiReviewerConfig[] | undefined;
  onChange: (updated: AiReviewerConfig[]) => void;
}

export default function AiReviewersSettingsPanel({ configs, onChange }: Props) {
  const merged = mergeWithDefaults(configs);
  const [selectedId, setSelectedId] = useState<string>(merged[0]?.id ?? '');

  const selectedReviewer = merged.find((r) => r.id === selectedId) ?? merged[0];

  function handleReviewerChange(updated: AiReviewerConfig) {
    const next = merged.map((r) => (r.id === updated.id ? updated : r));
    onChange(next);
  }

  function handleAddNew() {
    const id = `custom-${Date.now()}`;
    const newConfig: AiReviewerConfig = {
      id,
      name: 'New Reviewer',
      description: '',
      instructions: '',
      quickPrompts: [],
      enabled: true,
      model: '',
      temperature: 0.2,
      appliesTo: { fileExtensions: [] },
    };
    onChange([...merged, newConfig]);
    setSelectedId(id);
  }

  function handleDelete(id: string) {
    const next = merged.filter((r) => r.id !== id);
    onChange(next);
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? '');
    }
  }

  return (
    <div className="ai-reviewers-panel">
      {/* Reviewer selector sidebar */}
      <div className="ai-reviewers-list">
        {merged.map((r) => (
          <button
            key={r.id}
            className={[
              'ai-reviewers-list-item',
              r.id === selectedId ? 'active' : '',
              !r.enabled ? 'disabled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setSelectedId(r.id)}
            type="button"
          >
            <div className="ai-reviewers-list-name">{r.name || 'Unnamed reviewer'}</div>
            <div className="ai-reviewers-list-exts">
              {r.appliesTo.fileExtensions.length > 0
                ? r.appliesTo.fileExtensions.map((e) => `.${e}`).join(', ')
                : 'no extensions'}
            </div>
          </button>
        ))}

        <button
          className="btn btn-ghost btn-sm ai-reviewers-add-btn"
          type="button"
          onClick={handleAddNew}
        >
          + Add Reviewer
        </button>
      </div>

      {/* Editor for selected reviewer */}
      <div className="ai-reviewers-editor-pane">
        {selectedReviewer ? (
          <>
            <AiReviewerEditor
              key={selectedReviewer.id}
              config={selectedReviewer}
              onChange={handleReviewerChange}
            />
            <div className="ai-reviewers-editor-actions">
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                style={{ color: 'var(--color-blocked)' }}
                onClick={() => handleDelete(selectedReviewer.id)}
                title="Remove this reviewer configuration"
              >
                Remove
              </button>
            </div>
          </>
        ) : (
          <div className="ai-reviewers-empty">
            Select a reviewer to edit or click Add Reviewer to create one.
          </div>
        )}
      </div>
    </div>
  );
}
