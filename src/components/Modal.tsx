import { useEffect } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Use 'lg' for wider forms, 'xl' for large reading-focused dialogs. Default is standard width. */
  size?: 'md' | 'lg' | 'xl';
  footer?: React.ReactNode;
}

export default function Modal({ title, onClose, children, size = 'md', footer }: ModalProps) {
  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        // Close when clicking the backdrop, not the modal itself
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${size === 'lg' ? ' modal-lg' : ''}${size === 'xl' ? ' modal-xl' : ''}`}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
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
    </div>
  );
}
