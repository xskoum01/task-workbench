/**
 * AiReviewResultView
 * Renders structured AI code review output as a PR-style review.
 * Falls back to MarkdownView when only markdown is available.
 */
import React, { useCallback } from 'react';
import type { AiStructuredReview, AiReviewComment } from '../types';
import MarkdownView from './MarkdownView';

// ── Palette helpers ────────────────────────────────────────────────────────────

const VERDICT_COLOR: Record<AiStructuredReview['verdict'], string> = {
  pass:          '#3fb950',
  comment:       '#388bfd',
  needs_changes: '#d29922',
};

const VERDICT_LABEL: Record<AiStructuredReview['verdict'], string> = {
  pass:          'Bez zásadních připomínek',
  comment:       'Komentář',
  needs_changes: 'Vyžaduje úpravy',
};

const SEVERITY_COLOR: Record<AiReviewComment['severity'], string> = {
  critical:   '#f85149',
  major:      '#d29922',
  minor:      '#388bfd',
  suggestion: '#8b949e',
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict: AiStructuredReview['verdict'] }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: VERDICT_COLOR[verdict],
      border: `1px solid ${VERDICT_COLOR[verdict]}`,
      background: `color-mix(in srgb, ${VERDICT_COLOR[verdict]} 12%, var(--bg-surface))`,
    }}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: AiReviewComment['severity'] }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: SEVERITY_COLOR[severity],
      border: `1px solid ${SEVERITY_COLOR[severity]}`,
      background: `color-mix(in srgb, ${SEVERITY_COLOR[severity]} 10%, transparent)`,
    }}>
      {severity}
    </span>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      {label && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      )}
      <pre style={{
        margin: 0,
        padding: '6px 10px',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.55,
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        color: 'var(--text-secondary)',
        fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      }}>
        {code}
      </pre>
    </div>
  );
}

function CopyButton({ text, label = 'Kopírovat' }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={handleCopy}
      type="button"
      style={{ fontSize: 10, padding: '1px 6px', opacity: 0.7 }}
      title="Copy to clipboard"
    >
      {copied ? 'Zkopirováno' : label}
    </button>
  );
}

/**
 * Renders a problem/recommendation value.
 * If the value contains newline-separated bullet lines (starting with -, •, or *),
 * renders them as a <ul>. Otherwise renders as plain text.
 */
function ReviewText({ value }: { value: string }) {
  const lines = value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const bullets = lines.map((l) => l.replace(/^[-•*]\s*/, ''));

  if (bullets.length > 1) {
    return (
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{b}</li>
        ))}
      </ul>
    );
  }
  return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{value}</span>;
}

function ReviewCommentCard({ comment, fileName }: { comment: AiReviewComment; fileName: string }) {
  const hasLines = comment.lineStart != null;

  const lineLabel = hasLines
    ? `${fileName} řádky ${comment.lineStart}${comment.lineEnd && comment.lineEnd !== comment.lineStart ? `–${comment.lineEnd}` : ''}`
    : 'Obecný komentář';

  // Build a plain-text copy of this comment
  const commentText = [
    `[${comment.severity.toUpperCase()}] ${comment.title}`,
    `Location: ${lineLabel}`,
    `Problem: ${comment.problem}`,
    `Recommendation: ${comment.recommendation}`,
    comment.codeSnippet   ? `Snippet:\n${comment.codeSnippet}` : '',
    comment.suggestedCode ? `Suggested:\n${comment.suggestedCode}` : '',
  ].filter(Boolean).join('\n\n');

  return (
    <div style={{
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${SEVERITY_COLOR[comment.severity]}`,
      borderRadius: 4,
      background: 'var(--bg-overlay)',
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      {/* Card header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
      }}>
        <SeverityBadge severity={comment.severity} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>{lineLabel}</span>
        <CopyButton text={commentText} label="Copy" />
      </div>

      {/* Card body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {comment.title}
        </div>

        {comment.codeSnippet && (
          <CodeBlock code={comment.codeSnippet} label="Z souboru" />
        )}

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 10, marginRight: 4 }}>PROBLÉM</span>
          <ReviewText value={comment.problem} />
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 10, marginRight: 4 }}>DOPORUČENÍ</span>
          <ReviewText value={comment.recommendation} />
        </div>

        {comment.suggestedCode && (
          <CodeBlock code={comment.suggestedCode} label="Návrh kódu" />
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  structured?: AiStructuredReview;
  markdown?: string;
  /** Called when the user clicks the open button. */
  onOpenFile?: (filePath: string) => void;
  /** Label for the open button. Defaults to 'Otevřít soubor'. */
  openLabel?: string;
  /** Tooltip for the open button. */
  openTitle?: string;
}

export default function AiReviewResultView({ structured, markdown, onOpenFile, openLabel = 'Otevřít soubor', openTitle }: Props) {
  // Prefer structured output; fall back to markdown.
  if (!structured) {
    return markdown
      ? <div className="ai-review-modal-result"><MarkdownView markdown={markdown} /></div>
      : null;
  }

  const allText = [
    `AI Code Review — ${structured.fileName}`,
    `Recenzent: ${structured.reviewerName}`,
    `Výsledek: ${VERDICT_LABEL[structured.verdict]}`,
    '',
    structured.summary,
    '',
    ...structured.comments.map((c) => {
      const loc = c.lineStart != null
        ? `${structured.fileName} řádky ${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `–${c.lineEnd}` : ''}`
        : 'Obecný komentář';
      return [
        `[${c.severity.toUpperCase()}] ${c.title} (${loc})`,
        `Problém: ${c.problem}`,
        `Doporučení: ${c.recommendation}`,
        c.suggestedCode ? `Návrh:\n${c.suggestedCode}` : '',
      ].filter(Boolean).join('\n');
    }),
    '',
    structured.generalSuggestions.length > 0
      ? `Obecná doporučení:\n${structured.generalSuggestions.map((s) => `- ${s}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Header card */}
      <div style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 5,
        background: 'var(--bg-overlay)',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          {structured.fileName}
        </span>
        <VerdictBadge verdict={structured.verdict} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Recenzent: {structured.reviewerName}
        </span>
        {onOpenFile && structured.filePath && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onOpenFile(structured.filePath)}
            type="button"
            style={{ fontSize: 10, padding: '1px 6px' }}
            title={openTitle}
          >
            {openLabel}
          </button>
        )}
        <CopyButton text={allText} label="Kopírovat vše" />
      </div>

      {/* Summary */}
      <div style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 4,
        background: 'var(--bg-surface)',
        padding: '8px 12px',
        fontSize: 12,
        color: 'var(--text-secondary)',
        lineHeight: 1.55,
      }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>SHRNUTÍ</div>
        {structured.summary}
      </div>

      {/* Comments */}
      {structured.comments.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            KOMENTÁŘE ({structured.comments.length})
          </div>
          {structured.comments.map((c, i) => (
            <ReviewCommentCard key={i} comment={c} fileName={structured.fileName} />
          ))}
        </div>
      )}

      {/* General suggestions */}
      {structured.generalSuggestions.length > 0 && (
        <div style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          background: 'var(--bg-surface)',
          padding: '8px 12px',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
            OBECNÁ DOPORUČENÍ
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {structured.generalSuggestions.map((s, i) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>–</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* No issues case */}
      {structured.verdict === 'pass' && structured.comments.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '16px 0',
          color: 'var(--color-done)',
          fontSize: 13,
        }}>
          Žádné problémy nebyly nalezeny.
        </div>
      )}
    </div>
  );
}
