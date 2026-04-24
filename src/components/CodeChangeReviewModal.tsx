/**
 * CodeChangeReviewModal — fallback UI shown when no Git diff is available.
 *
 * The user can:
 *  - paste changed code / a diff manually into the textarea.
 *  - reload the Git diff (e.g. after saving their changes).
 *  - paste from clipboard.
 *  - run the AI review on whatever is in the textarea.
 */
import { useRef } from 'react';
import Modal from './Modal';
import Icon from './Icon';

export interface CodeChangeReviewModalProps {
  /** Pre-filled diff text. Empty string triggers the "no diff found" hint. */
  diff: string;
  onChange: (value: string) => void;
  /** File name shown in the header (for context only). */
  fileName: string;
  /** Whether the Load Git Diff action is in progress. */
  loadingDiff: boolean;
  /** Whether the Run AI Review action is in progress. */
  runningReview: boolean;
  onLoadGitDiff: () => void;
  onRunReview: () => void;
  onClose: () => void;
}

export default function CodeChangeReviewModal({
  diff,
  onChange,
  fileName,
  loadingDiff,
  runningReview,
  onLoadGitDiff,
  onRunReview,
  onClose,
}: CodeChangeReviewModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isRunning   = loadingDiff || runningReview;
  const canReview   = diff.trim().length > 0 && !isRunning;
  const isEmpty     = diff.trim().length === 0;

  async function handlePasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      onChange(text);
      textareaRef.current?.focus();
    } catch {
      // Clipboard access may be denied — ignore silently.
    }
  }

  return (
    <Modal
      title={`AI recenze změn${fileName ? ` — ${fileName}` : ''}`}
      size="lg"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onLoadGitDiff}
            disabled={isRunning}
            title="Run git diff again and fill the textarea"
          >
            {loadingDiff
              ? <><span className="btn-spinner" /> Načítám diff…</>
              : <><Icon name="refresh-cw" size={13} /> Načíst Git diff</>}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handlePasteClipboard}
            disabled={isRunning}
            title="Paste from clipboard"
          >
            Vložit ze schránky
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={isRunning}
          >
            Zrušit
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onRunReview}
            disabled={!canReview}
            title={isEmpty ? 'Zadejte diff nebo kód ke kontrole' : 'Spustit AI recenzi nad zadaným difem'}
          >
            {runningReview
              ? <><span className="btn-spinner" /> Recenzuji…</>
              : <><Icon name="search" size={13} /> Spustit AI recenzi</>}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {isEmpty && (
          <div style={{
            padding: '8px 12px',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}>
            {fileName
              ? <>Žádné Git změny pro <strong>{fileName}</strong>. Ujistěte se, že soubor je uložen a patří do zvoleného repozitáře, pak klikněte na <strong>Načíst Git diff</strong>.</>
              : <>Nebyly nalezeny žádné Git změny. Uložte soubor a klikněte na <strong>Načíst Git diff</strong>.</>}
            {' '}Nebo vložte diff ručně níže.
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="detail-notes-textarea"
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            minHeight: 320,
            resize: 'vertical',
            whiteSpace: 'pre',
            overflowX: 'auto',
          }}
          value={diff}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'Vložte diff nebo změněný kód sem…\n\nPříklad:\n--- a/MyPlugin.cs\n+++ b/MyPlugin.cs\n@@ -10,6 +10,8 @@\n ...'}
          spellCheck={false}
          disabled={isRunning}
        />
      </div>
    </Modal>
  );
}
