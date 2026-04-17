import { useEffect, useState } from 'react';
import type { OutlookMessage } from '../types';
import type { ImportResult, ImportOutcome } from '../context/AppContext';
import * as tauriApi from '../lib/tauriCommands';
import Icon from './Icon';

interface Props {
  clientId: string;
  onClose: () => void;
  onImport: (msg: OutlookMessage) => Promise<ImportResult>;
  onForceCreate: (msg: OutlookMessage) => Promise<ImportResult>;
}

type MessageState = 'idle' | 'importing' | ImportOutcome;

export default function OutlookImport({ clientId, onClose, onImport, onForceCreate }: Props) {
  const [messages, setMessages] = useState<OutlookMessage[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [states, setStates]     = useState<Record<string, MessageState>>({});
  const [results, setResults]   = useState<Record<string, ImportResult>>({});

  async function fetchMessages() {
    setLoading(true);
    setError(null);
    setStates({});
    setResults({});
    try {
      const result = await tauriApi.getOutlookMessages(clientId);
      setMessages(result);
      // Auto-import all fetched messages concurrently; duplicates finish immediately.
      const initialStates: Record<string, MessageState> = {};
      result.forEach((m) => { initialStates[m.id] = 'importing'; });
      setStates(initialStates);
      await Promise.all(
        result.map(async (m) => {
          try {
            const r = await onImport(m);
            setResults((prev) => ({ ...prev, [m.id]: r }));
            setStates((prev) => ({ ...prev, [m.id]: r.outcome }));
          } catch {
            setStates((prev) => ({ ...prev, [m.id]: 'idle' }));
          }
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchMessages(); }, []);

  async function handleImport(msg: OutlookMessage) {
    setStates((prev) => ({ ...prev, [msg.id]: 'importing' }));
    try {
      const result = await onImport(msg);
      setResults((prev) => ({ ...prev, [msg.id]: result }));
      setStates((prev) => ({ ...prev, [msg.id]: result.outcome }));
    } catch {
      setStates((prev) => ({ ...prev, [msg.id]: 'idle' }));
    }
  }

  function duplicateLabel(msgId: string): string {
    const state = results[msgId]?.existingState;
    if (state === 'created')  return 'Already a task';
    if (state === 'analyzed') return 'In inbox (needs review)';
    if (state === 'rejected') return 'Previously rejected';
    return 'Already imported';
  }

  return (
    <div className="ms-import-panel">
      <div className="ms-import-header">
        <span className="ms-import-title">
          <Icon name="mail" size={16} />
          Import from Outlook
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={fetchMessages} disabled={loading}>
            <Icon name="refresh-cw" size={14} />
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      {loading && (
        <div className="ms-import-loading">
          <Icon name="loader" size={18} />
          Loading messages…
        </div>
      )}

      {error && (
        <div className="ms-import-error">
          <Icon name="alert-circle" size={14} />
          {error}
        </div>
      )}

      {!loading && !error && messages.length === 0 && (
        <div className="ms-import-empty">No recent messages.</div>
      )}

      {!loading && !error && messages.length > 0 && (
        <ul className="ms-import-list">
          {messages.map((msg) => {
            const state = states[msg.id] ?? 'idle';
            return (
              <li key={msg.id} className="ms-import-item">
                <div className="ms-import-item-subject">{msg.subject || '(no subject)'}</div>
                <div className="ms-import-item-meta">
                  {msg.fromName || msg.fromEmail} &middot;{' '}
                  {new Date(msg.receivedAt).toLocaleString()}
                </div>
                {msg.bodyPreview && (
                  <div className="ms-import-item-preview">{msg.bodyPreview}</div>
                )}
                <div className="ms-import-actions">
                  {state === 'idle' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleImport(msg)}
                    >
                      Import
                    </button>
                  )}
                  {state === 'importing' && (
                    <span className="ms-import-state ms-import-state--pending">
                      <Icon name="loader" size={12} /> Classifying…
                    </span>
                  )}
                  {state === 'created' && (
                    <span className="ms-import-state ms-import-state--created">
                      <Icon name="check" size={12} /> Task created
                    </span>
                  )}
                  {state === 'analyzed' && (
                    <span className="ms-import-state ms-import-state--analyzed">
                      <Icon name="inbox" size={12} /> Needs review
                    </span>
                  )}
                  {state === 'rejected' && (
                    <span className="ms-import-state ms-import-state--rejected" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="x" size={12} /> Skipped
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ marginLeft: 4 }}
                        onClick={async () => {
                          setStates((prev) => ({ ...prev, [msg.id]: 'importing' }));
                          try {
                            const r = await onForceCreate(msg);
                            setResults((prev) => ({ ...prev, [msg.id]: r }));
                            setStates((prev) => ({ ...prev, [msg.id]: r.outcome }));
                          } catch {
                            setStates((prev) => ({ ...prev, [msg.id]: 'rejected' }));
                          }
                        }}
                      >
                        Create Task
                      </button>
                    </span>
                  )}
                  {state === 'duplicate' && (
                    <span className="ms-import-state ms-import-state--duplicate">
                      <Icon name="check-square" size={12} /> {duplicateLabel(msg.id)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
