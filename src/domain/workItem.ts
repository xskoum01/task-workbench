import type { PlanningBucket, Task, TaskObligationKind, TaskStatus } from '../types';

export const WORK_ITEM_SCHEMA_VERSION = 1 as const;

export type WorkItemKind = 'task' | 'obligation';
export type ObligationMode = 'one_off' | 'ongoing' | 'recurring';
export type WorkItemStatus =
  | 'planned'
  | 'ready'
  | 'in_progress'
  | 'waiting'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'cancelled';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'critical';
export type WorkItemActorType = 'user' | 'system' | 'integration';

export interface PartyReference {
  id?: string;
  displayName: string;
}

export interface WorkItemContextEntry {
  id: string;
  type: 'note' | 'source' | 'reference' | 'decision';
  text?: string;
  url?: string;
  createdAt: string;
  actorType: WorkItemActorType;
  actorName?: string;
}

export interface ExternalReference {
  type: string;
  label: string;
  id?: string;
  url: string;
}

export interface WorkItemEvent {
  id: string;
  sequence?: number;
  at: string;
  actorType: WorkItemActorType;
  actorName?: string;
  action: string;
  summary: string;
  changes?: Array<{
    field: string;
    from?: unknown;
    to?: unknown;
  }>;
}

/**
 * Stable provider-neutral contract exposed by the application layer.
 *
 * The existing Task interface remains a compatibility/persistence format while
 * the UI and integrations are migrated. New product concepts belong here rather
 * than in the legacy Task aggregate.
 */
export interface WorkItem {
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION;
  id: string;
  kind: WorkItemKind;
  obligationMode?: ObligationMode;
  legacyObligationKind?: TaskObligationKind;
  title: string;
  description?: string;
  expectedOutcome?: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  owner?: PartyReference;
  accountableTo?: PartyReference;
  areaId?: string;
  parentId?: string;
  startAt?: string;
  dueAt?: string;
  completedAt?: string;
  nextReviewAt?: string;
  blockerReason?: string;
  source: string;
  sourceUrl?: string;
  planningBucket?: PlanningBucket;
  estimateMinutes?: number;
  externalReferences: ExternalReference[];
  tags: string[];
  context: WorkItemContextEntry[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  archivedAt?: string;
  history: WorkItemEvent[];
  metadata?: Record<string, unknown>;
}

const LEGACY_STATUS_MAP: Record<TaskStatus, WorkItemStatus> = {
  new: 'planned',
  analyzed: 'ready',
  'in-progress': 'in_progress',
  'ready-for-review': 'review',
  done: 'completed',
  blocked: 'blocked',
};

export function workItemKindFromLegacy(kind: TaskObligationKind | undefined): WorkItemKind {
  return !kind || kind === 'task' ? 'task' : 'obligation';
}

export function workItemStatusFromTask(task: Task): WorkItemStatus {
  if (task.waitingState) return 'waiting';
  if (task.attentionState === 'pr-comments') return 'review';
  return LEGACY_STATUS_MAP[task.status];
}

export function workItemPriorityFromTask(task: Task): WorkItemPriority {
  const score = task.priorityScore ?? 0;
  if (score >= 85) return 'critical';
  if (score >= 65) return 'high';
  if (score > 0 && score < 30) return 'low';
  return 'normal';
}

/** Lossless compatibility projection for active UI reads during migration. */
export function taskToWorkItem(task: Task): WorkItem {
  const createdAt = task.createdAt ?? task.receivedAt;
  const kind = workItemKindFromLegacy(task.obligationKind);
  const context: WorkItemContextEntry[] = [];

  if (task.notes?.trim()) {
    context.push({
      id: `legacy-note-${task.id}`,
      type: 'note',
      text: task.notes,
      createdAt: task.updatedAt ?? createdAt,
      actorType: 'user',
    });
  }
  if (task.originalMessage?.trim()) {
    context.push({
      id: `legacy-source-${task.id}`,
      type: 'source',
      text: task.originalMessage,
      url: task.sourceUrl,
      createdAt: task.receivedAt,
      actorType: 'integration',
    });
  }

  const projected: WorkItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    id: task.id,
    kind,
    ...(kind === 'obligation'
      ? {
          obligationMode: task.obligationKind === 'responsibility' ? 'ongoing' as const : 'one_off' as const,
          legacyObligationKind: task.obligationKind,
        }
      : {}),
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    status: workItemStatusFromTask(task),
    priority: workItemPriorityFromTask(task),
    ...(task.responsibleParty
      ? { owner: { displayName: task.responsibleParty } }
      : {}),
    ...(task.accountableTo
      ? { accountableTo: { displayName: task.accountableTo } }
      : {}),
    ...(task.customerId ? { areaId: task.customerId } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    source: task.source,
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    ...(task.planningBucket ? { planningBucket: task.planningBucket } : {}),
    externalReferences: [
      ...(task.devopsTaskUrl ? [{ type: 'azure_devops_work_item', label: 'Azure DevOps', url: task.devopsTaskUrl }] : []),
      ...(task.ticketUrl ? [{ type: 'ticket', label: 'Helpdesk ticket', url: task.ticketUrl }] : []),
    ],
    tags: [],
    context,
    createdAt,
    updatedAt: task.updatedAt ?? createdAt,
    revision: Math.max(1, task.revision ?? 1),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    history: (task.history ?? []).map((entry) => ({
      ...entry,
      changes: entry.changes?.map((change) => ({ ...change })),
    })),
  };
  const embedded = (task as Task & { _canonicalWorkItem?: WorkItem })._canonicalWorkItem;
  if (!embedded || embedded.id !== task.id || embedded.schemaVersion !== WORK_ITEM_SCHEMA_VERSION) {
    return projected;
  }
  const projectedContextIds = new Set(projected.context.map((entry) => entry.id));
  return {
    ...embedded,
    ...projected,
    expectedOutcome: embedded.expectedOutcome,
    parentId: embedded.parentId,
    startAt: embedded.startAt,
    nextReviewAt: embedded.nextReviewAt,
    blockerReason: embedded.blockerReason,
    tags: embedded.tags,
    context: [
      ...embedded.context.filter((entry) => !projectedContextIds.has(entry.id)),
      ...projected.context,
    ],
    metadata: embedded.metadata,
  };
}
