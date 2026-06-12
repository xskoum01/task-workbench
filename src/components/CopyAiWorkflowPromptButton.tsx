import { useState, useCallback } from 'react';
import type { Task } from '../types';
import Icon from './Icon';
import { buildAiWorkflowPrompt } from '../lib/aiWorkflowPrompt';

interface Props {
  task: Task;
  /** 'detail' shows the button with slightly higher baseline opacity; 'list' hides until row hover. */
  variant?: 'detail' | 'list';
  /** Called with the success message on copy, then with null after 2 s to allow auto-clear. */
  onSuccess?: (message: string | null) => void;
  /** Called with an error message when clipboard write fails. */
  onError?: (message: string) => void;
}

export default function CopyAiWorkflowPromptButton({
  task,
  variant = 'list',
  onSuccess,
  onError,
}: Props) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const prompt = buildAiWorkflowPrompt(task);
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
  }, [task, onSuccess, onError]);

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
