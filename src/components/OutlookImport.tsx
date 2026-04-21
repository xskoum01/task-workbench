import { useEffect, useRef, useState } from 'react';
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

  // In-flight guard. Set to true BEFORE the Tauri IPC call is dispatched,
  // cleared only when the fetch fully completes (or errors).
  //
  // Why a ref and NOT reset in useEffect cleanup:
  // React.StrictMode in development runs: mount → effect → cleanup → remount → effect.
  // The cleanup fires SYNCHRONOUSLY between the two effect calls, before the first
  // async Tauri/Graph call has returned. If cleanup cleared this flag, the second
  // StrictMode effect invocation would immediately pass the guard and dispatch a
  // second IPC call — which is exactly what we want to prevent.
  // By NOT resetting in cleanup, the second effect invocation finds inFlight=true
  // and returns immediately without touching the Rust/Graph layer.
  // Manual refresh resets the flag explicitly before calling fetchMessages().
  const inFlightRef = useRef(false);

  async function fetchMessages(trigger: 'mount' | 'refresh' = 'mount') {
    if (inFlightRef.current) {
      console.debug(`[outlook-load] skipped trigger=${trigger} reason=in-flight`);
      return;
    }
    inFlightRef.current = true;
    const requestId = Math.random().toString(36).slice(2, 8);
    console.debug(`[outlook-load] start requestId=${requestId} trigger=${trigger}`);
    setLoading(true);
    setError(null);
    setStates({});
    setResults({});
    try {
      const result = await tauriApi.getOutlookMessages(clientId);
      console.debug(`[outlook-load] fetched requestId=${requestId} count=${result.length}`);
      // Show flagged emails for manual import — do NOT auto-import.
      // Each item stays at 'idle' until the user clicks Import.
      setMessages(result);
      console.debug(`[outlook-load] completed requestId=${requestId} count=${result.length}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  // Auto-load on mount. No cleanup needed — the in-flight guard handles
  // StrictMode's double-invoke (second call finds inFlight=true and skips).
  useEffect(() => {
    fetchMessages('mount');
  }, []);

  function handleRefresh() {
    // Explicit user action: release the guard so a fresh load can start.
    inFlightRef.current = false;
    fetchMessages('refresh');
  }

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
          <button className="btn btn-ghost btn-sm" onClick={handleRefresh} disabled={loading}>
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

      {/* Scope note: source is flagged emails only */}
      <div className="ms-import-scope-note">
        {'Flagged emails only — flag an email in Outlook first, then refresh here to import it as a task.'}
      </div>

      {!loading && !error && messages.length === 0 && (
        <div className="ms-import-empty">No flagged emails. Flag an email in Outlook to import it.</div>
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
