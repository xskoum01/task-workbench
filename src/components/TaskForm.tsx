import { useState } from 'react';
import type { Task, TaskSource, TaskStatus, TaskType } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';

interface TaskFormProps {
  onClose: () => void;
  /** When provided, the form edits the existing task instead of creating a new one. */
  initialTask?: Task;
}

interface FormState {
  title: string;
  customerId: string;
  taskType: TaskType;
  source: TaskSource;
  status: TaskStatus;
  confidence: string; // string while editing, converted on submit
  originalMessage: string;
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
  { value: 'deployment',label: 'Deployment' },
  { value: 'other',     label: 'Other'      },
];

const SOURCE_OPTIONS: { value: TaskSource; label: string }[] = [
  { value: 'manual', label: 'Manual'  },
  { value: 'email',  label: 'Email'   },
  { value: 'teams',  label: 'Teams'   },
];

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'new',              label: 'New'            },
  { value: 'analyzed',         label: 'Analyzed'       },
  { value: 'in-progress',      label: 'In Progress'    },
  { value: 'ready-for-review', label: 'For Review'     },
  { value: 'blocked',          label: 'Blocked'        },
  { value: 'done',             label: 'Done'           },
];

function blankForm(customers: { id: string }[], defaultConfidence: number): FormState {
  return {
    title:           '',
    customerId:      customers[0]?.id ?? '',
    taskType:        'other',
    source:          'manual',
    status:          'new',
    confidence:      String(defaultConfidence),
    originalMessage: '',
    ticketUrl:       '',
    devopsTaskUrl:   '',
    budgetHours:     '',
    budgetNote:      '',
  };
}

function taskToForm(task: Task): FormState {
  return {
    title:           task.title,
    customerId:      task.customerId,
    taskType:        task.taskType,
    source:          task.source,
    status:          task.status,
    confidence:      String(task.confidence),
    originalMessage: task.originalMessage,
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

  async function handleSubmit() {
    if (!form.title.trim()) {
      setValidationError('Title is required.');
      return;
    }
    if (!form.customerId) {
      setValidationError('Please select a customer.');
      return;
    }

    const confidence  = Math.min(100, Math.max(0, parseInt(form.confidence, 10) || 0));
    const budgetHours = form.budgetHours !== '' ? parseFloat(form.budgetHours) : undefined;

    const trackingFields = {
      ticketUrl:      form.ticketUrl.trim()    || undefined,
      devopsTaskUrl:  form.devopsTaskUrl.trim() || undefined,
      budgetHours:    budgetHours !== undefined && !isNaN(budgetHours) ? budgetHours : undefined,
      budgetNote:     form.budgetNote.trim()   || undefined,
    };

    setSaving(true);
    try {
      if (isEditing) {
        await updateTask(initialTask.id, {
          title:           form.title.trim(),
          customerId:      form.customerId,
          taskType:        form.taskType,
          source:          form.source,
          status:          form.status,
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
          status:          form.status,
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

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
        {saving ? (isEditing ? 'Saving…' : 'Creating…') : (isEditing ? 'Save Task' : 'Create Task')}
      </button>
    </>
  );

  return (
    <Modal title={isEditing ? 'Edit Task' : 'New Task'} onClose={onClose} footer={footer} size="lg">
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
