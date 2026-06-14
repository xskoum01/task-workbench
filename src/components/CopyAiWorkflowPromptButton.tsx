import { useState, useCallback } from 'react';
import type { Task, Customer } from '../types';
import Icon from './Icon';
import { buildAiWorkflowPrompt } from '../lib/aiWorkflowPrompt';
import { resolveCustomerForPrompt } from '../lib/resolveCustomerForPrompt';

interface Props {
  task: Task;
  customer?: Customer;
  /**
   * Global CRM base directory from app settings.
   * Required for the `folderName + crmBaseDirectory` path fallback when the
   * customer has no `resolvedRepositoryPath` or `repositoryRoot` set yet
   * (common when `rescanRepositories` hasn't run since last startup).
   */
  crmBaseDirectory?: string;
  /** 'detail' shows the button with slightly higher baseline opacity; 'list' hides until row hover. */
  variant?: 'detail' | 'list';
  /** Called with the success message on copy, then with null after 2 s to allow auto-clear. */
  onSuccess?: (message: string | null) => void;
  /** Called with an error message when clipboard write fails. */
  onError?: (message: string) => void;
}

export default function CopyAiWorkflowPromptButton({
  task,
  customer,
  crmBaseDirectory,
  variant = 'list',
  onSuccess,
  onError,
}: Props) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Enrich customer with resolvedRepositoryPath when only folderName is available
    // (covers the common case where rescanRepositories has not run since startup).
    const resolvedCustomer = resolveCustomerForPrompt(customer, crmBaseDirectory);
    const prompt = buildAiWorkflowPrompt(task, resolvedCustomer);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      if (onSuccess) {
        onSuccess('AI workflow prompt copied');
        setTimeout(() => onSuccess(null), 2000);
      }
    } catch {
      onError?.('Failed to copy AI workflow prompt');
    }
  }, [task, customer, crmBaseDirectory, onSuccess, onError]);

  return (
    <button
      type="button"
      className={`copy-ai-prompt-btn${variant === 'detail' ? ' copy-ai-prompt-btn--detail' : ''}`}
      onClick={handleClick}
      aria-label="Copy AI workflow prompt"
      title="Copy AI workflow prompt"
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  );
}
