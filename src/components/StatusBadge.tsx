import type { TaskStatus, TaskSource, TaskType, ClassificationState } from '../types';

// --- Status badge ----------------------------------------------------------

export const STATUS_LABELS: Record<TaskStatus, string> = {
  'new':              'New',
  'analyzed':         'Analyzed',
  'in-progress':      'In Progress',
  'ready-for-review': 'For Review',
  'done':             'Done',
  'blocked':          'Blocked',
};

interface StatusBadgeProps {
  status: TaskStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge-status-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// --- Task type badge -------------------------------------------------------

export const TYPE_LABELS: Record<TaskType, string> = {
  'bug-fix':    'Bug Fix',
  'feature':    'Feature',
  'review':     'Review',
  'question':   'Question',
  'deployment': 'Deployment',
  'other':      'Other',
};

interface TypeBadgeProps {
  type: TaskType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  return (
    <span className={`badge badge-type-${type}`}>
      {TYPE_LABELS[type]}
    </span>
  );
}

// --- Source badge ----------------------------------------------------------

const SOURCE_LABELS: Record<TaskSource, string> = {
  email:  'Email',
  teams:  'Teams',
  manual: 'Manual',
};

interface SourceBadgeProps {
  source: TaskSource;
}

export function SourceBadge({ source }: SourceBadgeProps) {
  return (
    <span className={`badge badge-source-${source}`}>
      {SOURCE_LABELS[source]}
    </span>
  );
}

// --- Classification state badge --------------------------------------------

const CLASSIFICATION_LABELS: Record<ClassificationState, string> = {
  pending:  'Classifying',
  analyzed: 'Needs Review',
  rejected: 'Dismissed',
  created:  'Task',
};

interface ClassificationBadgeProps {
  state: ClassificationState;
}

export function ClassificationBadge({ state }: ClassificationBadgeProps) {
  return (
    <span className={`badge badge-classification-${state}`}>
      {CLASSIFICATION_LABELS[state]}
    </span>
  );
}
