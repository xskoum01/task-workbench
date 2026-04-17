import { useEffect, useState } from 'react';
import type { TeamsFlatMessage, TeamsChat, TeamsChatMessage } from '../types';
import type { ImportResult, ImportOutcome } from '../context/AppContext';
import * as tauriApi from '../lib/tauriCommands';
import Icon from './Icon';

interface Props {
  clientId: string;
  onClose: () => void;
  /** Called with reconstructed chat + message objects so InboxPage.handleTeamsImport stays unchanged. */
  onImport: (chat: TeamsChat, msg: TeamsChatMessage) => Promise<ImportResult>;
  onForceCreate: (chat: TeamsChat, msg: TeamsChatMessage) => Promise<ImportResult>;
}

type MessageState = 'idle' | 'importing' | ImportOutcome;

/** Classify a Rust/Graph error string into a user-visible message and icon. */
function classifyError(err: string): { label: string; icon: string } {
  if (err.includes('Missing Teams permissions') || err.includes('AccessDenied') || err.includes('Authorization_RequestDenied')) {
    return { label: `Missing Teams permissions \u2014 the app may not be granted Chat.Read in Azure. Details: ${err}`, icon: 'shield-off' };
  }
  if (err.includes('connection expired') || err.includes('InvalidAuthenticationToken') || err.includes('AuthenticationError')) {
    return { label: 'Microsoft connection expired. Disconnect and reconnect in Settings.', icon: 'log-in' };
  }
  if (err.includes('Not authenticated') || err.includes('Please sign in')) {
    return { label: 'Not signed in to Microsoft. Connect your account in Settings.', icon: 'log-in' };
  }
  if (err.includes('Network request failed')) {
    return { label: `Network error \u2014 check your internet connection. Details: ${err}`, icon: 'wifi-off' };
  }
  return { label: `Teams import failed: ${err}`, icon: 'alert-circle' };
}

/** Derive a compact chat label from a flat message item. */
function chatLabel(item: TeamsFlatMessage): string {
  return item.chatTopic.trim() || item.chatMembersSummary || 'Chat';
}

/** Convert a TeamsFlatMessage back to the (TeamsChat, TeamsChatMessage) pair
 *  expected by InboxPage.handleTeamsImport. No data is lost. */
function toImportArgs(item: TeamsFlatMessage): [TeamsChat, TeamsChatMessage] {
  const chat: TeamsChat = {
    id:                 item.chatId,
    topic:              item.chatTopic,
    chatType:           item.chatType,
    membersSummary:     item.chatMembersSummary,
    lastMessagePreview: item.content.slice(0, 100),
    lastUpdatedAt:      item.sentAt,
  };
  const msg: TeamsChatMessage = {
    id:          item.id,
    senderName:  item.senderName,
    senderEmail: item.senderEmail,
    sentAt:      item.sentAt,
    content:     item.content,
  };
  return [chat, msg];
}

export default function TeamsImport({ clientId, onClose, onImport, onForceCreate }: Props) {
  const [messages, setMessages] = useState<TeamsFlatMessage[]>([]);
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
      const items = await tauriApi.getTeamsRecentMessages(clientId);
      setMessages(items);
      // Auto-import all fetched messages concurrently; duplicates finish immediately.
      const initialStates: Record<string, MessageState> = {};
      items.forEach((m) => { initialStates[m.id] = 'importing'; });
      setStates(initialStates);
      await Promise.all(
        items.map(async (item) => {
          try {
            const [chat, msg] = toImportArgs(item);
            const r = await onImport(chat, msg);
            setResults((prev) => ({ ...prev, [item.id]: r }));
            setStates((prev) => ({ ...prev, [item.id]: r.outcome }));
          } catch {
            setStates((prev) => ({ ...prev, [item.id]: 'idle' }));
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

  const errorInfo = error ? classifyError(error) : null;

  async function handleImport(item: TeamsFlatMessage) {
    setStates((prev) => ({ ...prev, [item.id]: 'importing' }));
    try {
      const [chat, msg] = toImportArgs(item);
      const result = await onImport(chat, msg);
      setResults((prev) => ({ ...prev, [item.id]: result }));
      setStates((prev) => ({ ...prev, [item.id]: result.outcome }));
    } catch {
      setStates((prev) => ({ ...prev, [item.id]: 'idle' }));
    }
  }

  function duplicateLabel(id: string): string {
    const state = results[id]?.existingState;
    if (state === 'created')  return 'Already a task';
    if (state === 'analyzed') return 'In inbox (needs review)';
    if (state === 'rejected') return 'Previously rejected';
    return 'Already imported';
  }

  return (
    <div className="ms-import-panel">
      <div className="ms-import-header">
        <span className="ms-import-title">
          <Icon name="message-square" size={16} />
          Import from Teams
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={fetchMessages} disabled={loading} title="Refresh">
            <Icon name="refresh-cw" size={14} />
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      {/* Scope disclaimer — always visible so users know what this covers */}
      <div className="ms-import-scope-note">
        {'Latest messages from recent chats \u2014 channel messages are not supported.'}
      </div>

      {errorInfo && (
        <div className="ms-import-error">
          <Icon name={errorInfo.icon as 'alert-circle'} size={14} />
          {errorInfo.label}
        </div>
      )}

      {loading && (
        <div className="ms-import-loading">
          <Icon name="loader" size={18} />
          {'Loading recent messages\u2026'}
        </div>
      )}

      {!loading && messages.length === 0 && !error && (
        <div className="ms-import-empty">
          <div>No recent messages found.</div>
          <div className="ms-import-empty-sub">
            Searched the latest messages from your recent personal and group chats.
          </div>
        </div>
      )}

      {!loading && messages.length > 0 && (
        <ul className="ms-import-list">
          {messages.map((item) => {
            const state = states[item.id] ?? 'idle';
            return (
              <li key={item.id} className="ms-import-item">
                {/* Sender · Chat · Timestamp */}
                <div className="ms-import-item-meta">
                  <strong>{item.senderName || '(unknown)'}</strong>
                  <span className="ms-import-meta-sep"> {'\u00b7'} </span>
                  <span className="ms-import-chat-source">{chatLabel(item)}</span>
                  <span className="ms-import-meta-sep"> {'\u00b7'} </span>
                  <span>{new Date(item.sentAt).toLocaleString()}</span>
                </div>
                {/* Message body preview */}
                <div className="ms-import-item-preview">{item.content}</div>
                {/* Import action */}
                <div className="ms-import-actions">
                  {state === 'idle' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleImport(item)}
                    >
                      Import
                    </button>
                  )}
                  {state === 'importing' && (
                    <span className="ms-import-state ms-import-state--pending">
                      <Icon name="loader" size={12} /> {'Classifying\u2026'}
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
                          setStates((prev) => ({ ...prev, [item.id]: 'importing' }));
                          try {
                            const [chat, msg] = toImportArgs(item);
                            const r = await onForceCreate(chat, msg);
                            setResults((prev) => ({ ...prev, [item.id]: r }));
                            setStates((prev) => ({ ...prev, [item.id]: r.outcome }));
                          } catch {
                            setStates((prev) => ({ ...prev, [item.id]: 'rejected' }));
                          }
                        }}
                      >
                        Create Task
                      </button>
                    </span>
                  )}
                  {state === 'duplicate' && (
                    <span className="ms-import-state ms-import-state--duplicate">
                      <Icon name="check-square" size={12} /> {duplicateLabel(item.id)}
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
