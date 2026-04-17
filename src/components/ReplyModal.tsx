import { useState } from 'react';
import type { Task, Customer } from '../types';
import { TYPE_LABELS, STATUS_LABELS } from './StatusBadge';
import Modal from './Modal';

interface ReplyModalProps {
  task: Task;
  customer: Customer | undefined;
  onClose: () => void;
  /** AI-generated draft. When provided, overrides the local template. */
  initialText?: string;
}

/** Builds a context-aware reply template from local task data — no AI call. */
function buildReplyTemplate(task: Task, customer: Customer | undefined): string {
  const customerName = customer?.name ?? 'Hi';
  const typeLabel    = TYPE_LABELS[task.taskType];
  const statusLabel  = STATUS_LABELS[task.status];

  // Status-specific body paragraph
  let statusLine = '';
  switch (task.status) {
    case 'new':
      statusLine = 'I have received your request and will start reviewing it shortly.';
      break;
    case 'analyzed':
      statusLine = 'I have analysed the request and have a clear plan for how to proceed.';
      break;
    case 'in-progress':
      statusLine = 'I am currently working on this. I will keep you updated on progress.';
      break;
    case 'ready-for-review':
      statusLine = 'The implementation is complete and ready for your review. Please let me know if you have any feedback or require adjustments.';
      break;
    case 'done':
      statusLine = 'This has been completed. Please review the changes and let me know if anything needs further attention.';
      break;
    case 'blocked':
      statusLine = 'I need your help to proceed — please see the details below.';
      break;
    default:
      statusLine = 'I will review this and get back to you with an update.';
  }

  return [
    `Hi ${customerName},`,
    '',
    `Thank you for your ${typeLabel.toLowerCase()} request regarding:`,
    `"${task.title}"`,
    '',
    statusLine,
    '',
    task.status === 'blocked'
      ? `Current status: ${statusLabel}\n\nCould you please help with the following before I can continue?\n[Describe blocker here]`
      : `Current status: ${statusLabel}`,
    '',
    'Please don\'t hesitate to reach out if you have any questions.',
    '',
    'Best regards',
  ].join('\n');
}

export default function ReplyModal({ task, customer, onClose, initialText }: ReplyModalProps) {
  const [text, setText]     = useState(() => initialText ?? buildReplyTemplate(task, customer));
  const [copied, setCopied] = useState(false);
  const isAiGenerated = !!initialText;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  }

  const footer = (
    <>
      {copied && <span className="reply-copy-success">✓ Copied to clipboard</span>}
      <button className="btn btn-secondary" onClick={handleCopy}>
        Copy to Clipboard
      </button>
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
    </>
  );

  return (
    <Modal title="Generate Reply" onClose={onClose} footer={footer}>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
        {isAiGenerated
          ? 'AI-generated draft — review and edit before sending.'
          : 'Template generated from task context. Edit before sending.'}
      </p>
      <textarea
        className="form-textarea reply-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck
      />
    </Modal>
  );
}
