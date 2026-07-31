import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Use 'lg' for wider forms, 'xl' for large reading-focused dialogs. Default is standard width. */
  size?: 'md' | 'lg' | 'xl';
  footer?: React.ReactNode;
}

export default function Modal({ title, onClose, children, size = 'md', footer }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusableSelector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    if (dialog && !dialog.contains(document.activeElement)) {
      const firstControl = dialog.querySelector<HTMLElement>(focusableSelector);
      (firstControl ?? dialog).focus();
    }

    function isTopmostDialog(): boolean {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      return dialogs.length > 0 && dialogs[dialogs.length - 1] === dialog;
    }

    function handleKey(e: KeyboardEvent) {
      if (!dialog || !isTopmostDialog()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.offsetParent !== null);
      if (controls.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  // Render at document.body so the overlay is never hidden by a collapsed
  // <details> element or any display:none ancestor in the component tree.
  return createPortal(
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        // Close when clicking the backdrop, not the modal itself
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal${size === 'lg' ? ' modal-lg' : ''}${size === 'xl' ? ' modal-xl' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span className="modal-title" id={titleId}>{title}</span>
          <button className="modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close dialog">×</button>
        </div>

        <div className="modal-body">
          {children}
        </div>

        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
