import type { WorkItem, WorkItemKind, WorkItemStatus } from './workItem';

export interface WorkItemCursor {
  updatedAt: string;
  id: string;
}

export interface WorkItemQuery {
  text?: string;
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  ownerId?: string;
  areaId?: string;
  dueBefore?: string;
  updatedAfter?: string;
  includeArchived?: boolean;
  cursor?: WorkItemCursor;
  limit?: number;
}

export interface WorkItemPage {
  items: WorkItem[];
  nextCursor?: WorkItemCursor;
}

export interface WorkItemMutation {
  expectedRevision: number;
  actorType: 'user' | 'system' | 'integration';
  actorName?: string;
}

export interface WorkItemRepository {
  get(id: string): Promise<WorkItem | null>;
  list(query?: WorkItemQuery): Promise<WorkItemPage>;
  create(item: WorkItem): Promise<WorkItem>;
  update(id: string, patch: Partial<WorkItem>, mutation: WorkItemMutation): Promise<WorkItem>;
}
