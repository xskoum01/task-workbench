import { useEffect, useRef, useState } from 'react';
import type { OutlookMessage } from '../types';
import type { ImportResult, ImportOutcome } from '../context/AppContext';
import * as tauriApi from '../lib/tauriCommands';
import Icon from './Icon';

/** Classify a Graph/Outlook error string into a user-visible message and icon. */
function classifyOutlookError(err: string): { label: string; icon: string } {
  if (err.includes('Missing Microsoft permissions') || err.includes('AccessDenied') || err.includes('Authorization_RequestDenied')) {
    return { label: `Missing Outlook permissions — the app may not be granted Mail.Read in Azure. Details: ${err}`, icon: 'shield-off' };
  }
  if (err.includes('connection expired') || err.includes('InvalidAuthenticationToken') || err.includes('AuthenticationError')) {
    return { label: 'Microsoft connection expired. Disconnect and reconnect in Settings.', icon: 'log-in' };
  }
  if (err.includes('Not authenticated') || err.includes('Please sign in')) {
    return { label: 'Not signed in to Microsoft. Connect your account in Settings.', icon: 'log-in' };
  }
  if (err.includes('Network request failed') || err.includes('timed out')) {
    return { label: `Network error or timeout — check your internet connection. Details: ${err}`, icon: 'wifi-off' };
  }
  return { label: `Outlook import failed: ${err}`, icon: 'alert-circle' };
}

interface Props {
  clientId: string;
  onClose: () => void;
  onImport: (msg: OutlookMessage) => Promise<ImportResult>;
  onForceCreate: (msg: OutlookMessage) => Promise<ImportResult>;
}

type MessageState = 'idle' | 'importing' | ImportOutcome;

const RECENCY_OPTIONS: { label: string; days: number }[] = [
  { label: 'Today',      days: 1 },
  { label: '7 days',     days: 7 },
  { label: '14 days',    days: 14 },
  { label: '30 days',    days: 30 },
  { label: 'All flagged', days: 0 },
];
const DEFAULT_DAYS_BACK = 14;

export default function OutlookImport({ clientId, onClose, onImport, onForceCreate }: Props) {
  const [messages, setMessages] = useState<OutlookMessage[]>([]);
  const [fetchedCount, setFetchedCount] = useState(0);
  const [daysBack, setDaysBack] = useState(DEFAULT_DAYS_BACK);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [states, setStates]     = useState<Record<string, MessageState>>({});
  const [results, setResults]   = useState<Record<string, ImportResult>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

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

  async function fetchMessages(trigger: 'mount' | 'refresh' = 'mount', overrideDays?: number) {
    if (inFlightRef.current) {
      console.debug(`[outlook-load] skipped trigger=${trigger} reason=in-flight`);
      return;
    }
    inFlightRef.current = true;
    const activeDays = overrideDays ?? daysBack;
    const requestId = Math.random().toString(36).slice(2, 8);
    console.debug(`[outlook-load] start requestId=${requestId} trigger=${trigger} daysBack=${activeDays}`);
    setLoading(true);
    setError(null);
    setStates({});
    setResults({});
    try {
      // Lightweight fetch: no body field, no ADO parsing — panel loads quickly.
      // Full body is fetched lazily in handleImportWithFullFetch when the user clicks Import.
      const { messages: result, fetchedCount: fetched } = await tauriApi.getOutlookFlaggedList(clientId, activeDays);
      console.debug(`[outlook-load] fetched requestId=${requestId} fetched=${fetched} shown=${result.length}`);
      setMessages(result);
      setFetchedCount(fetched);
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
    inFlightRef.current = false;
    fetchMessages('refresh');
  }

  function handleDaysChange(days: number) {
    setDaysBack(days);
    inFlightRef.current = false;
    fetchMessages('refresh', days);
  }

  /** Lazy-fetch full body for one message, then hand off to the import pipeline. */
  async function handleImportWithFullFetch(msg: OutlookMessage, force = false) {
    setStates((prev) => ({ ...prev, [msg.id]: 'importing' }));
    setItemErrors((prev) => { const n = { ...prev }; delete n[msg.id]; return n; });
    try {
      const fullMsg = await tauriApi.getOutlookMessageFull(clientId, msg.id);
      console.log(
        `[email-html] full fetch: msgId=${msg.id.slice(0, 12)}`,
        `htmlPresent=${!!fullMsg.bodyHtml}`,
        `length=${fullMsg.bodyHtml?.length ?? 0}`,
      );
      const result = await (force ? onForceCreate(fullMsg) : onImport(fullMsg));
      setResults((prev) => ({ ...prev, [msg.id]: result }));
      setStates((prev) => ({ ...prev, [msg.id]: result.outcome }));
    } catch (err) {
      const label = classifyOutlookError(err instanceof Error ? err.message : String(err)).label;
      setItemErrors((prev) => ({ ...prev, [msg.id]: label }));
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Recency filter */}
          <select
            className="ms-import-recency-select"
            value={daysBack}
            onChange={(e) => handleDaysChange(Number(e.target.value))}
            disabled={loading}
            title="Recency filter"
          >
            {RECENCY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>{o.label}</option>
            ))}
          </select>
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

      {error && (() => {
        const info = classifyOutlookError(error);
        return (
          <div className="ms-import-error">
            <Icon name={info.icon as 'alert-circle'} size={14} />
            {info.label}
          </div>
        );
      })()}

      {/* Scope note: source is flagged emails only */}
      <div className="ms-import-scope-note">
        {'Flagged emails only — flag an email in Outlook first, then refresh here to import it as a task.'}
        {!loading && (
          <span style={{ marginLeft: 8, opacity: 0.65 }}>
            {fetchedCount === 0
              ? (daysBack > 0 ? `No flagged emails in the last ${daysBack} day${daysBack !== 1 ? 's' : ''}.` : 'No flagged emails.')
              : messages.length < fetchedCount
              ? `Showing latest ${messages.length} of ${fetchedCount} fetched (last ${daysBack > 0 ? `${daysBack}d` : 'all'}).`
              : `${fetchedCount} flagged email${fetchedCount !== 1 ? 's' : ''} (last ${daysBack > 0 ? `${daysBack}d` : 'all'}).`}
          </span>
        )}
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
                  {itemErrors[msg.id] && (
                    <div className="ms-import-item-error">{itemErrors[msg.id]}</div>
                  )}
                  {state === 'idle' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleImportWithFullFetch(msg)}
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
                        onClick={() => handleImportWithFullFetch(msg, true)}
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
