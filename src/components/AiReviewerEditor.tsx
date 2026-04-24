/**
 * AiReviewerEditor — edits a single AiReviewerConfig inline.
 * Emits `onChange` on every field change; the parent owns save state.
 */
import { useState } from 'react';
import type { AiReviewerConfig } from '../types';
import Icon from './Icon';

interface Props {
  config: AiReviewerConfig;
  onChange: (updated: AiReviewerConfig) => void;
}

export default function AiReviewerEditor({ config, onChange }: Props) {
  const [newPrompt, setNewPrompt] = useState('');

  function set<K extends keyof AiReviewerConfig>(key: K, value: AiReviewerConfig[K]) {
    onChange({ ...config, [key]: value });
  }

  function setAppliesTo<K extends keyof AiReviewerConfig['appliesTo']>(
    key: K,
    value: AiReviewerConfig['appliesTo'][K],
  ) {
    onChange({ ...config, appliesTo: { ...config.appliesTo, [key]: value } });
  }

  function addPrompt() {
    const trimmed = newPrompt.trim();
    if (!trimmed) return;
    set('quickPrompts', [...config.quickPrompts, trimmed]);
    setNewPrompt('');
  }

  function removePrompt(idx: number) {
    set('quickPrompts', config.quickPrompts.filter((_, i) => i !== idx));
  }

  function updatePrompt(idx: number, value: string) {
    const copy = [...config.quickPrompts];
    copy[idx] = value;
    set('quickPrompts', copy);
  }

  return (
    <div className="ai-reviewer-editor">
      {/* Header row: name + enabled toggle */}
      <div className="ai-reviewer-editor-header">
        <input
          className="form-input ai-reviewer-name-input"
          type="text"
          placeholder="Reviewer name"
          value={config.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <label className="ai-reviewer-toggle" title="Enable or disable this reviewer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span>{config.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      {/* Description */}
      <div className="ai-reviewer-field">
        <label className="form-label">Description</label>
        <input
          className="form-input"
          type="text"
          placeholder="Short description of what this reviewer checks"
          value={config.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>

      {/* Instructions */}
      <div className="ai-reviewer-field">
        <label className="form-label">Reviewer Instructions</label>
        <textarea
          className="form-textarea ai-reviewer-instructions"
          placeholder="System instructions for the AI reviewer…"
          value={config.instructions}
          onChange={(e) => set('instructions', e.target.value)}
          rows={10}
        />
        <div className="settings-field-hint">
          These instructions are sent as the AI system prompt. Be specific about the target
          framework, coding standards, and output format.
        </div>
      </div>

      {/* Quick prompts */}
      <div className="ai-reviewer-field">
        <label className="form-label">Quick Prompts</label>
        <div className="ai-reviewer-prompts-list">
          {config.quickPrompts.map((p, idx) => (
            <div key={idx} className="ai-reviewer-prompt-row">
              <input
                className="form-input"
                type="text"
                value={p}
                onChange={(e) => updatePrompt(idx, e.target.value)}
              />
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => removePrompt(idx)}
                title="Remove quick prompt"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="ai-reviewer-prompt-add-row">
          <input
            className="form-input"
            type="text"
            placeholder="Add a quick prompt…"
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPrompt(); } }}
          />
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={addPrompt}
            disabled={!newPrompt.trim()}
          >
            Add
          </button>
        </div>
      </div>

      {/* Model override + temperature */}
      <div className="ai-reviewer-field ai-reviewer-model-row">
        <div style={{ flex: 1 }}>
          <label className="form-label">Model override</label>
          <input
            className="form-input"
            type="text"
            placeholder="Leave blank to use global AI model"
            value={config.model ?? ''}
            onChange={(e) => set('model', e.target.value)}
          />
        </div>
        <div style={{ width: 120 }}>
          <label className="form-label">Temperature</label>
          <input
            className="form-input"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={config.temperature ?? 0.2}
            onChange={(e) => set('temperature', parseFloat(e.target.value) || 0)}
            style={{ maxWidth: 90 }}
          />
        </div>
      </div>

      {/* File extension targeting */}
      <div className="ai-reviewer-field">
        <label className="form-label">Applies to file extensions</label>
        <input
          className="form-input"
          type="text"
          placeholder="cs, js, ts"
          value={config.appliesTo.fileExtensions.join(', ')}
          onChange={(e) =>
            setAppliesTo(
              'fileExtensions',
              e.target.value
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean),
            )
          }
          style={{ maxWidth: 240 }}
        />
        <div className="settings-field-hint">Comma-separated, without dots.</div>
      </div>

      {/* Dev target kind targeting */}
      <div className="ai-reviewer-field">
        <label className="form-label">Applies to dev target</label>
        <div className="ai-reviewer-devtarget-row">
          {(['plugin', 'script'] as const).map((kind) => {
            const checked = config.appliesTo.devTargetKinds?.includes(kind) ?? false;
            return (
              <label key={kind} className="ai-reviewer-devtarget-option">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const current = config.appliesTo.devTargetKinds ?? [];
                    const updated = e.target.checked
                      ? [...current, kind]
                      : current.filter((k) => k !== kind);
                    setAppliesTo('devTargetKinds', updated);
                  }}
                />
                <span>{kind === 'plugin' ? 'Plugin (C#)' : 'Script (JS/TS)'}</span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
