import { useState } from 'react';
import type { Task, TaskObligationKind, TaskSource, TaskStatus, TaskType } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';

interface TaskFormProps {
  onClose: () => void;
  /** When provided, the form edits the existing task instead of creating a new one. */
  initialTask?: Task;
}

interface FormState {
  title: string;
  description: string;
  customerId: string;
  taskType: TaskType;
  obligationKind: TaskObligationKind;
  responsibleParty: string;
  accountableTo: string;
  source: TaskSource;
  status: TaskStatus;
  confidence: string; // string while editing, converted on submit
  originalMessage: string;
  dueAt: string;
  estimatedEffort: string;
  // Tracking
  ticketUrl: string;
  devopsTaskUrl: string;
  budgetHours: string; // string while editing
  budgetNote: string;
}

const TASK_TYPE_OPTIONS: { value: TaskType; label: string }[] = [
  { value: 'bug-fix',    label: 'Bug Fix'    },
  { value: 'feature',   label: 'Feature'    },
  { value: 'review',    label: 'Review'     },
  { value: 'question',  label: 'Question'   },
  { value: 'deployment',label: 'Delivery'   },
  { value: 'other',     label: 'Other'      },
];

const SOURCE_OPTIONS: { value: TaskSource; label: string }[] = [
  { value: 'manual', label: 'Manual'  },
  { value: 'email',  label: 'Email'   },
  { value: 'teams',  label: 'Teams'   },
];

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'new', label: 'Planned' },
  { value: 'analyzed', label: 'Ready' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'ready-for-review', label: 'Review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Completed' },
];

function blankForm(customers: { id: string }[], defaultConfidence: number): FormState {
  return {
    title:           '',
    description:     '',
    customerId:      customers[0]?.id ?? '',
    taskType:        'other',
    obligationKind:  'task',
    responsibleParty:'',
    accountableTo:   '',
    source:          'manual',
    status:          'new',
    confidence:      String(defaultConfidence),
    originalMessage: '',
    dueAt:           '',
    estimatedEffort: '',
    ticketUrl:       '',
    devopsTaskUrl:   '',
    budgetHours:     '',
    budgetNote:      '',
  };
}

function taskToForm(task: Task): FormState {
  return {
    title:           task.title,
    description:     task.description ?? '',
    customerId:      task.customerId,
    taskType:        task.taskType,
    obligationKind:  task.obligationKind ?? 'task',
    responsibleParty:task.responsibleParty ?? '',
    accountableTo:   task.accountableTo ?? '',
    source:          task.source,
    status:          task.status,
    confidence:      String(task.confidence),
    originalMessage: task.originalMessage,
    dueAt:           task.dueAt ? task.dueAt.slice(0, 10) : '',
    estimatedEffort: task.estimatedEffort !== undefined ? String(task.estimatedEffort) : '',
    ticketUrl:       task.ticketUrl ?? '',
    devopsTaskUrl:   task.devopsTaskUrl ?? '',
    budgetHours:     task.budgetHours !== undefined ? String(task.budgetHours) : '',
    budgetNote:      task.budgetNote ?? '',
  };
}

export default function TaskForm({ onClose, initialTask }: TaskFormProps) {
  const { customers, settings, createTask, updateTask } = useApp();
  const isEditing = !!initialTask;

  const [form, setForm] = useState<FormState>(
    isEditing ? taskToForm(initialTask) : blankForm(customers, settings.defaultTaskConfidence)
  );
  const [saving, setSaving]               = useState(false);
  const [validationError, setValidationError] = useState('');

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setValidationError('');
  }

  async function performSave() {
    const confidence  = Math.min(100, Math.max(0, parseInt(form.confidence, 10) || 0));
    const budgetHours = form.budgetHours !== '' ? parseFloat(form.budgetHours) : undefined;
    const estimatedEffort = form.estimatedEffort !== '' ? parseFloat(form.estimatedEffort) : undefined;
    const dueAt = form.dueAt ? new Date(`${form.dueAt}T23:59:59`).toISOString() : undefined;

    const trackingFields = {
      description:    form.description.trim() || undefined,
      obligationKind: form.obligationKind,
      responsibleParty: form.responsibleParty.trim() || undefined,
      accountableTo:  form.accountableTo.trim() || undefined,
      dueAt,
      estimatedEffort: estimatedEffort !== undefined && !isNaN(estimatedEffort) ? estimatedEffort : undefined,
      estimatedEffortConfirmed: estimatedEffort !== undefined && !isNaN(estimatedEffort),
      ticketUrl:      form.ticketUrl.trim()    || undefined,
      devopsTaskUrl:  form.devopsTaskUrl.trim() || undefined,
      budgetHours:    budgetHours !== undefined && !isNaN(budgetHours) ? budgetHours : undefined,
      budgetNote:     form.budgetNote.trim()   || undefined,
    };

    setSaving(true);
    try {
      if (initialTask) {
        await updateTask(initialTask.id, {
          title:           form.title.trim(),
          customerId:      form.customerId,
          taskType:        form.taskType,
          source:          form.source,
          status:           form.status,
          confidence,
          originalMessage: form.originalMessage.trim(),
          ...trackingFields,
        });
      } else {
        await createTask({
          title:           form.title.trim(),
          customerId:      form.customerId,
          taskType:        form.taskType,
          source:          form.source,
          status:           form.status,
          confidence,
          originalMessage: form.originalMessage.trim(),
          ...trackingFields,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (!form.title.trim()) {
      setValidationError('Title is required.');
      return;
    }
    if (!form.customerId) {
      setValidationError('Please select a customer.');
      return;
    }

    await performSave();
  }

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
        {saving ? (isEditing ? 'Saving…' : 'Creating…') : (isEditing ? 'Save record' : 'Create record')}
      </button>
    </>
  );

  return (
    <Modal title={isEditing ? 'Edit work item' : 'New work item'} onClose={onClose} footer={footer} size="lg">
      {/* Title */}
      <div className="form-group">
        <label className="form-label form-label-required">Title</label>
        <input
          className="form-input"
          type="text"
          placeholder="Describe the task…"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          autoFocus={!isEditing}
        />
      </div>

      {/* Customer + Task Type */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label form-label-required">Customer</label>
          <select
            className="form-select"
            value={form.customerId}
            onChange={(e) => set('customerId', e.target.value)}
          >
            {customers.length === 0 && (
              <option value="">No customers defined</option>
            )}
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Task Type</label>
          <select
            className="form-select"
            value={form.taskType}
            onChange={(e) => set('taskType', e.target.value as TaskType)}
          >
            {TASK_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Description / expected outcome</label>
        <textarea
          className="form-textarea"
          placeholder="What must be true for this obligation to be complete?"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          style={{ minHeight: 84 }}
        />
      </div>

      <div className="form-section-divider" />
      <div className="form-section-title">Responsibility</div>

      <div className="form-row-3">
        <div className="form-group">
          <label className="form-label">Obligation kind</label>
          <select
            className="form-select"
            value={form.obligationKind}
            onChange={(e) => set('obligationKind', e.target.value as TaskObligationKind)}
          >
            <option value="task">Task</option>
            <option value="responsibility">Responsibility</option>
            <option value="commitment">Commitment</option>
            <option value="follow-up">Follow-up</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Responsible party</label>
          <input
            className="form-input"
            type="text"
            placeholder="Person, team, or system"
            value={form.responsibleParty}
            onChange={(e) => set('responsibleParty', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Accountable to</label>
          <input
            className="form-input"
            type="text"
            placeholder="Stakeholder or customer"
            value={form.accountableTo}
            onChange={(e) => set('accountableTo', e.target.value)}
          />
        </div>
      </div>

      {/* Source + Status + Confidence */}
      <div className="form-row-3">
        <div className="form-group">
          <label className="form-label">Source</label>
          <select
            className="form-select"
            value={form.source}
            onChange={(e) => set('source', e.target.value as TaskSource)}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Status</label>
          <select
            className="form-select"
            value={form.status}
            onChange={(e) => set('status', e.target.value as TaskStatus)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Confidence %</label>
          <input
            className="form-input"
            type="number"
            min={0}
            max={100}
            value={form.confidence}
            onChange={(e) => set('confidence', e.target.value)}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Deadline</label>
          <input
            className="form-input"
            type="date"
            value={form.dueAt}
            onChange={(e) => set('dueAt', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Estimated effort (hours)</label>
          <input
            className="form-input"
            type="number"
            min={0}
            step={0.25}
            placeholder="e.g. 2.5"
            value={form.estimatedEffort}
            onChange={(e) => set('estimatedEffort', e.target.value)}
          />
        </div>
      </div>

      {/* Original message */}
      <div className="form-group">
        <label className="form-label">Original Message</label>
        <textarea
          className="form-textarea"
          placeholder="Paste the original email, Teams message, or request here…"
          value={form.originalMessage}
          onChange={(e) => set('originalMessage', e.target.value)}
          style={{ minHeight: 140 }}
        />
      </div>

      {/* ── Tracking ── */}
      <div className="form-section-divider" />
      <div className="form-section-title">Tracking</div>

      {/* Ticket URL + DevOps Task URL */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Ticket URL</label>
          <input
            className="form-input"
            type="url"
            placeholder="https://helpdesk.example.com/tickets/…"
            value={form.ticketUrl}
            onChange={(e) => set('ticketUrl', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Azure DevOps Task URL</label>
          <input
            className="form-input"
            type="url"
            placeholder="https://dev.azure.com/org/…"
            value={form.devopsTaskUrl}
            onChange={(e) => set('devopsTaskUrl', e.target.value)}
          />
        </div>
      </div>

      {/* Budget Hours + Budget Note */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Budget (hours)</label>
          <input
            className="form-input"
            type="number"
            min={0}
            step={0.5}
            placeholder="e.g. 4"
            value={form.budgetHours}
            onChange={(e) => set('budgetHours', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Budget Note</label>
          <input
            className="form-input"
            type="text"
            placeholder="Optional budget context…"
            value={form.budgetNote}
            onChange={(e) => set('budgetNote', e.target.value)}
          />
        </div>
      </div>

      {/* Validation error */}
      {validationError && (
        <div style={{ fontSize: 12, color: 'var(--color-blocked)' }}>
          {validationError}
        </div>
      )}
    </Modal>
  );
}
