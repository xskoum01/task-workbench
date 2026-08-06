import { useState } from 'react';
import type { Task, Customer, OutlookMessage, TeamsChat, TeamsChatMessage } from '../types';
import { useApp } from '../context/AppContext';
import type { ImportResult } from '../context/AppContext';
import { generateTeamsTitle, detectTeamsUrgency, parseForwardedTeamsMessage, cleanTeamsBody } from '../lib/teamsHeuristics';
import { heuristicClassify } from '../lib/heuristicClassify';
import { parseAdoEmail, resolveCustomerFromCrmCode } from '../lib/adoParsing';
import { SourceBadge, ClassificationBadge } from '../components/StatusBadge';
import TaskRecordDetail from '../components/TaskRecordDetail';
import TaskForm from '../components/TaskForm';
import OutlookImport from '../components/OutlookImport';
import TeamsImport from '../components/TeamsImport';
import Icon from '../components/Icon';

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


// ---------------------------------------------------------------------------
// CustomerPicker — inline dropdown for assigning a customer to an inbox item.
// Shows existing customers first, then unregistered CRM folders.
// ---------------------------------------------------------------------------

interface CustomerPickerProps {
  customers: Customer[];
  crmFolders: string[];
  onSelect: (value: string) => void;
}

function CustomerPicker({ customers, crmFolders, onSelect }: CustomerPickerProps) {
  // CRM folders that already have a Customer record (by folderName)
  const knownFolderNames = new Set(
    customers.map((c) => (c.folderName ?? '').toLowerCase()),
  );
  // Only show CRM folders that don't already have a customer record
  const extraFolders = crmFolders.filter(
    (f) => !knownFolderNames.has(f.toLowerCase()),
  );

  if (customers.length === 0 && extraFolders.length === 0) return null;

  return (
    <select
      className="inline-customer-select"
      value=""
      title="Assign customer"
      onChange={(e) => {
        if (e.target.value) onSelect(e.target.value);
      }}
    >
      <option value="" disabled>Assign customer&#x2026;</option>
      {customers.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
      {extraFolders.map((f) => (
        <option key={`crm:${f}`} value={`crm:${f}`}>{f}</option>
      ))}
    </select>
  );
}

export default function InboxPage() {
  const { tasks, customers, crmFolders, settings, getCustomerById, updateTask, importMessage, resolveOrCreateCustomerByFolder, updateSettings } = useApp();
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showOutlook, setShowOutlook]   = useState(false);
  const [showTeams, setShowTeams]       = useState(false);

  // Inbox shows only review items awaiting a user decision.
  // Pending = transient classifying state, invisible to user.
  // Created/rejected = handled elsewhere (Tasks page / silent internal record).
  const inboxItems = tasks.filter((t) => !t.archivedAt && t.classificationState === 'analyzed');

  // Debug — visible in browser/Tauri dev tools console
  console.debug(
    `[Inbox] total=${tasks.length}  review=${inboxItems.length}` +
    `  created=${tasks.filter((t) => t.classificationState === 'created').length}` +
    `  rejected=${tasks.filter((t) => t.classificationState === 'rejected').length}` +
    `  pending=${tasks.filter((t) => t.classificationState === 'pending').length}`,
  );

  const selectedTask  = tasks.find((t) => t.id === selectedId) ?? null;

  const isConnected = settings?.microsoftConnectionStatus === 'connected';
  const clientId    = settings?.microsoftClientId ?? '';

  /**
   * Called when the Outlook/Teams panel detects that the Microsoft refresh token
   * is expired or invalid (MICROSOFT_RECONNECT_REQUIRED). Clears the connection
   * status in persisted settings so Settings page reflects the expired state.
   */
  async function handleReconnectRequired() {
    try {
      await updateSettings({
        microsoftConnectionStatus: 'disconnected',
        outlookStatus:  'not_configured',
        teamsStatus:    'not_configured',
      });
    } catch (e) {
      console.warn('[InboxPage] failed to update microsoftConnectionStatus after reconnect required:', e);
    }
  }

  async function handleOutlookImport(msg: OutlookMessage, forceCreate = false): Promise<ImportResult> {
    // Prefer the full body (HTML-stripped) when available; fall back to bodyPreview.
    const bodyText = msg.bodyFull ?? msg.bodyPreview;

    // Try deterministic Azure DevOps parsing first.
    const adoParsed = parseAdoEmail(msg.subject, msg.fromEmail, bodyText);

    // Non-actionable PR events (approved, completed, merged) — skip deterministically.
    // forceCreate overrides this: if the user manually clicks "Create Task", honour it.
    if (adoParsed.shouldSkip && !forceCreate) {
      return { outcome: 'rejected', reason: adoParsed.skipReason ?? 'Non-actionable ADO notification' };
    }

    if (adoParsed.isAdoEmail && adoParsed.title) {
      // Try to resolve customer from CRM_<Name> pattern before calling importMessage.
      const preResolvedCustomerId = adoParsed.adoContext?.crmProjectCode
        ? resolveCustomerFromCrmCode(adoParsed.adoContext.crmProjectCode, customers)
        : undefined;

      // PR comment/review → this_week (code review is not urgent, but should be done soon).
      // Work items (bug/task/story) → today (direct assignment from ADO implies current sprint).
      const adoBucket = adoParsed.adoContext?.type === 'pr-comment' ? 'this_week' : 'today';
      // PR comments: still high-confidence actionable (88) — bucket is what changes.
      // Work items: high confidence, bucket = today (current sprint assignment).
      const adoPriority = adoParsed.adoContext?.type === 'pr-comment' ? 88 : 85;

      console.debug(
        `[ADO] "${adoParsed.title?.slice(0, 60)}"`,
        `type=${adoParsed.adoContext?.type ?? 'other'}`,
        `bucket=${adoBucket} priority=${adoPriority}`,
      );

      return importMessage({
        externalMessageId:   msg.id,
        source:              'email',
        title:               adoParsed.title,
        senderName:          msg.fromName,
        senderEmail:         msg.fromEmail,
        content:             adoParsed.description ?? bodyText,
        receivedAt:          msg.receivedAt,
        sourceUrl:           msg.webLink,
        preResolvedCustomerId,
        adoContext:          adoParsed.adoContext ?? undefined,
        heuristicBucket:     adoBucket,
        heuristicPriority:   adoPriority,
        heuristicReason:     adoParsed.classificationLabel,
        // ADO work items and PR comments are deterministic — AI enriches but must not gatekeep.
        captureMode:         'explicit',
        emailBodyHtml:       msg.bodyHtml,
        forceCreate,
      });
    }

    // Generic email — run heuristic classifier for a meaningful confidence score.
    const h = heuristicClassify(msg.subject || '', bodyText, 'email');
    return importMessage({
      externalMessageId:  msg.id,
      source:             'email',
      title:              msg.subject || '(no subject)',
      senderName:         msg.fromName,
      senderEmail:        msg.fromEmail,
      content:            `From: ${msg.fromName} <${msg.fromEmail}>\n\n${bodyText}`,
      receivedAt:         msg.receivedAt,
      sourceUrl:          msg.webLink,
      heuristicBucket:    h.bucket,
      heuristicPriority:  h.confidence,
      heuristicReason:    h.reason,
      // Explicit user intent: user opened the Outlook panel and triggered this import.
      // AI enriches metadata but no longer gatekeeps task candidacy.
      // Future: when isFlagged is available from Graph, only flagged emails reach here.
      captureMode:        'explicit',
      emailBodyHtml:      msg.bodyHtml,
      forceCreate,
    });
  }

  async function handleTeamsImport(chat: TeamsChat, msg: TeamsChatMessage, forceCreate = false): Promise<ImportResult> {
    // Priority order for effective sender/body:
    //  1. Linked original message (resolved from a pasted "Copy link" URL — most reliable)
    //  2. Forwarded-card metadata (parsed from HTML/attachments by Rust)
    //  3. Frontend heuristic parser fallback
    //  4. Normal intake message fields
    //
    // Rust already merges 1 and 2 into isForwarded/original* fields, giving linked
    // messages priority. We only need the frontend heuristic as a last resort.
    const rustFwd = msg.isForwarded && (msg.originalSenderName || msg.originalContent)
      ? {
          senderName:  msg.originalSenderName ?? '',
          senderEmail: msg.originalSenderEmail,
          sentAt:      msg.originalSentAt,
          content:     msg.originalContent ?? '',
        }
      : null;
    const fwdFallback = !rustFwd
      ? parseForwardedTeamsMessage(msg.content, msg.senderName, msg.senderEmail, msg.sentAt)
      : null;
    const fwd = rustFwd ?? fwdFallback;

    const effectiveSenderName  = fwd?.senderName  || msg.senderName;
    const effectiveSenderEmail = fwd?.senderEmail || msg.senderEmail;
    const effectiveSentAt      = fwd?.sentAt      || msg.sentAt;
    const effectiveBody        = fwd?.content     || msg.content;

    // Build the full content block first so heuristics can read the message body.
    // For resolved original messages (linked or forwarded) use a clean format that
    // does NOT include the intake-chat wrapper noise (sender = forwarder, Chat = intake).
    const hasOriginal = !!fwd;
    const cleanBody = hasOriginal ? cleanTeamsBody(effectiveBody) : effectiveBody;
    const fullContent = hasOriginal
      ? `From: ${effectiveSenderName}\n\n${cleanBody}`
      : `From: ${effectiveSenderName} <${effectiveSenderEmail}>\nChat: ${chat.topic || chat.membersSummary}\n\n${effectiveBody}`;

    // Generate a meaningful title instead of using raw participant names
    const title = generateTeamsTitle(effectiveSenderName, fullContent);

    // heuristicClassify drives the confidence/priority score.
    const h = heuristicClassify(title, fullContent, 'teams');
    const urgency = detectTeamsUrgency(effectiveBody);

    return importMessage({
      externalMessageId:  msg.id,
      sourceThreadId:     chat.id,
      source:             'teams',
      title,
      senderName:         effectiveSenderName,
      senderEmail:        effectiveSenderEmail,
      content:            fullContent,
      receivedAt:         effectiveSentAt,
      heuristicBucket:    h.bucket !== 'this_week' ? h.bucket : urgency.bucket,
      heuristicPriority:  h.confidence,
      heuristicReason:    h.reason,
      captureMode:        'explicit',
      forceCreate,
    });
  }

  async function handlePromoteToTask(task: Task) {
    await updateTask(task.id, { classificationState: 'created' });
  }

  async function handleRejectItem(task: Task) {
    await updateTask(task.id, { classificationState: 'rejected' });
    if (selectedId === task.id) setSelectedId(null);
  }

  return (
    <>
      <div className="page-content">
        <div className="page-header">
          <div>
            <div className="page-title">Inbox</div>
            <div className="page-subtitle">
              {inboxItems.length} item{inboxItems.length !== 1 ? 's' : ''} to review
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {isConnected && (
              <>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Import from Outlook"
                  onClick={() => { setShowOutlook(true); setShowTeams(false); }}
                >
                  <Icon name="mail" size={14} />
                  Outlook
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Import from Teams"
                  onClick={() => { setShowTeams(true); setShowOutlook(false); }}
                >
                  <Icon name="message-square" size={14} />
                  Teams
                </button>
              </>
            )}
            <button className="btn btn-secondary" onClick={() => setShowTaskForm(true)}>
              <span className="btn-icon">+</span>
              New Task
            </button>
          </div>
        </div>

        {/* Import panels */}
        {showOutlook && (
          <OutlookImport
            clientId={clientId}
            onClose={() => setShowOutlook(false)}
            onImport={handleOutlookImport}
            onForceCreate={(msg) => handleOutlookImport(msg, true)}
            onReconnectRequired={handleReconnectRequired}
          />
        )}
        {showTeams && (
          <TeamsImport
            clientId={clientId}
            intakeChatId={settings?.teamsIntakeChatId}
            onClose={() => setShowTeams(false)}
            onImport={handleTeamsImport}
            onForceCreate={(chat, msg) => handleTeamsImport(chat, msg, true)}
          />
        )}

        {inboxItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="inbox" size={32} /></div>
            <div className="empty-state-text">Inbox is empty</div>
          </div>
        ) : (
          <div className="task-list">
            {inboxItems.map((task) => {
              const customer    = getCustomerById(task.customerId);
              const isSelected  = selectedId === task.id;

              return (
                <div key={task.id} className="task-list-group task-list-group--inbox">
                  <button
                    className={`task-list-item task-list-item--inbox${isSelected ? ' selected' : ''}`}
                    onClick={() => setSelectedId(isSelected ? null : task.id)}
                  >
                    <div className="task-list-item-main">
                      <div className="task-list-item-title">{task.title}</div>
                      <div className="task-list-item-meta">
                        <SourceBadge source={task.source} />
                        {task.senderName && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-customer">{task.senderName}</span>
                          </>
                        )}
                        {customer && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-customer">{customer.name}</span>
                          </>
                        )}
                        {!customer && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-label task-list-item-label--warn">No customer</span>
                          </>
                        )}
                        <span className="task-meta-sep">·</span>
                        <span className="task-list-item-time">
                          {formatRelativeTime(task.importedAt ?? task.receivedAt)}
                        </span>
                        {task.priorityReason && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-label">{task.priorityReason}</span>
                          </>
                        )}
                        {!task.priorityReason && task.classificationLabel && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-label">{task.classificationLabel}</span>
                          </>
                        )}
                      </div>
                      {task.analysisResult?.summary && (
                        <div className="task-list-item-summary">{task.analysisResult.summary}</div>
                      )}
                    </div>
                    <div className="task-list-item-side">
                      <ClassificationBadge state={task.classificationState!} />
                    </div>
                  </button>

                  {/* Inline actions for review items */}
                  <div className="task-list-item-actions">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handlePromoteToTask(task)}
                      title="Create as task"
                    >
                      <Icon name="check" size={12} /> Create Task
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleRejectItem(task)}
                      title="Dismiss — not relevant"
                    >
                      <Icon name="x" size={12} /> Dismiss
                    </button>
                    {/* Quick customer assignment for unresolved items */}
                    {!task.customerId && (
                      <CustomerPicker
                        customers={customers}
                        crmFolders={crmFolders}
                        onSelect={async (value) => {
                          if (value.startsWith('crm:')) {
                            const folderName = value.slice(4);
                            const customerId = await resolveOrCreateCustomerByFolder(folderName);
                            updateTask(task.id, { customerId });
                          } else {
                            updateTask(task.id, { customerId: value });
                          }
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedTask && (
        <TaskRecordDetail task={selectedTask} onClose={() => setSelectedId(null)} />
      )}

      {showTaskForm && (
        <TaskForm onClose={() => setShowTaskForm(false)} />
      )}
    </>
  );
}
