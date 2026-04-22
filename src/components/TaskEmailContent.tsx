/**
 * TaskEmailContent — shared email rendering component.
 *
 * Used in both TaskDetail and InlineTaskPanel so both show the same
 * full email view (iframe for HTML, thread-parsed plain-text fallback).
 *
 * Extracted from TaskDetail.tsx. Do not add component-specific state here.
 */
import type { Task } from '../types';
import EmailHtmlFrame from './EmailHtmlFrame';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

const EMAIL_HEADER_FIELDS = ['From', 'Sent', 'Date', 'To', 'Cc', 'Bcc', 'Subject'] as const;
type EmailHeaderField = typeof EMAIL_HEADER_FIELDS[number];

const GMAIL_TRUST_BANNER_RE = /You don['']t often get email from\s+\S+\.?\s*Learn why this is important\.?\s*/gi;
const HEADER_LINE_RE = /^(?:From|To|Cc|Bcc|Date|Sent|Subject):\s*.+/i;
const MIN_BODY_LENGTH = 20;

interface ParsedSegment {
  headers: Partial<Record<EmailHeaderField, string>>;
  body: string;
}

function parseSegmentLines(raw: string): ParsedSegment {
  const headers: Partial<Record<EmailHeaderField, string>> = {};
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') { i++; break; }
    const m = line.match(/^(From|Sent|Date|To|Cc|Bcc|Subject):\s*(.+)/i);
    if (m) { headers[m[1] as EmailHeaderField] = m[2].trim(); i++; }
    else break;
  }
  return { headers, body: lines.slice(i).join('\n').trim() };
}

function splitLastHeaderFromBody(
  field: EmailHeaderField,
  value: string,
): { headerVal: string; body: string } {
  const sentenceMatch = value.match(/^(.*?[.!?])\s+(?![A-Za-z]+:\s)(.+)$/s);
  if (sentenceMatch) return { headerVal: sentenceMatch[1].trim(), body: sentenceMatch[2].trim() };
  if (field === 'From') {
    const nameBodyMatch = value.match(/^((?:[A-Z]\S*(?:\s+|$))+)([a-z].*)$/);
    if (nameBodyMatch) return { headerVal: nameBodyMatch[1].trim(), body: nameBodyMatch[2].trim() };
  }
  return { headerVal: value, body: '' };
}

function parseSegmentInline(raw: string): ParsedSegment {
  const headers: Partial<Record<EmailHeaderField, string>> = {};
  const fieldPattern = EMAIL_HEADER_FIELDS.join('|');
  const fullPattern = new RegExp(
    `(${fieldPattern}):\\s*((?:(?!(?:${fieldPattern}):)[\\s\\S])*?)(?=(?:${fieldPattern}):|$)`,
    'gi',
  );
  const matches = [...raw.matchAll(fullPattern)];
  if (matches.length === 0) return { headers, body: raw.trim() };
  for (const m of matches) {
    const val = m[2].replace(/\s+/g, ' ').trim();
    if (val) headers[m[1] as EmailHeaderField] = val;
  }
  const last = matches[matches.length - 1];
  let body = raw.slice((last.index ?? 0) + last[0].length).trim();
  const lastKey = last[1] as EmailHeaderField;
  const lastVal = headers[lastKey] ?? '';
  const split = splitLastHeaderFromBody(lastKey, lastVal);
  if (split.body) {
    headers[lastKey] = split.headerVal;
    body = body ? `${split.body} ${body}` : split.body;
  }
  return { headers, body };
}

function parseSegment(raw: string): ParsedSegment {
  return raw.includes('\n') ? parseSegmentLines(raw) : parseSegmentInline(raw);
}

function isReplyHeaderStart(line: string, lines: string[], idx: number): boolean {
  if (!/^From:\s+.+/i.test(line)) return false;
  const COMPANION = /^(?:Sent|Date|To|Cc|Subject):\s+/i;
  for (let j = idx + 1; j < Math.min(idx + 5, lines.length); j++) {
    const t = lines[j].trim();
    if (COMPANION.test(t)) return true;
    if (t === '' && j > idx + 1) break;
  }
  return false;
}

function splitMultilineThread(text: string): string[] {
  const lines = text.split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isReplyHeaderStart(lines[i].trim(), lines, i)) {
      const seg = current.join('\n').trim();
      if (seg) segments.push(seg);
      current = [lines[i]];
    } else {
      current.push(lines[i]);
    }
  }
  const last = current.join('\n').trim();
  if (last) segments.push(last);
  return segments.length > 0 ? segments : [text];
}

function splitInlineThread(text: string): string[] {
  const FROM_RE = /\bFrom:\s+/gi;
  const COMPANION = /(?:Date|Sent|To|Cc|Subject):/i;
  const splitPoints: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = FROM_RE.exec(text)) !== null) {
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
    if (COMPANION.test(window)) splitPoints.push(m.index);
  }
  if (splitPoints.length === 0) return [text];
  const segments: string[] = [];
  let last = 0;
  for (const pos of splitPoints) {
    if (pos > last) segments.push(text.slice(last, pos).trim());
    last = pos;
  }
  segments.push(text.slice(last).trim());
  return segments.filter(Boolean);
}

function splitEmailThread(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [''];
  return trimmed.includes('\n') ? splitMultilineThread(trimmed) : splitInlineThread(trimmed);
}

function getDisplayMessageBody(raw: string, senderName?: string, senderEmail?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let result = trimmed;
  result = result.replace(GMAIL_TRUST_BANNER_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  const knownSender = senderName ?? senderEmail;
  if (knownSender) {
    const escaped = knownSender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`^From:\\s+${escaped}\\s*`, 'i'), '').trim();
  }
  if (result.includes('\n')) {
    const lines = result.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (HEADER_LINE_RE.test(line)) { i++; }
      else if (line === '') { i++; break; }
      else break;
    }
    if (i > 0) {
      const stripped = lines.slice(i).join('\n').trim();
      if (stripped) result = stripped;
    }
  }
  if (result.length < MIN_BODY_LENGTH && trimmed.length > MIN_BODY_LENGTH) return trimmed;
  return result || trimmed;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QuotedSegment({ raw }: { raw: string }) {
  const { headers, body } = parseSegment(raw);
  const hasHeaders = Object.keys(headers).length > 0;
  return (
    <div className="email-segment email-segment--dimmed">
      {hasHeaders && (
        <div className="email-headers">
          {EMAIL_HEADER_FIELDS.filter((f) => headers[f]).map((f) => (
            <div key={f} className="email-header-row">
              <span className="email-header-key">{f}</span>
              <span className="email-header-val">{headers[f]}</span>
            </div>
          ))}
        </div>
      )}
      {body && <div className="email-body">{body}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface TaskEmailContentProps {
  task: Task;
}

/**
 * Renders the full email content for a task.
 * Uses an iframe for HTML emails (task.emailBodyHtml), falls back to the
 * plain-text thread parser for older plain-text messages.
 * Identical rendering in TaskDetail and InlineTaskPanel.
 */
export default function TaskEmailContent({ task }: TaskEmailContentProps) {
  const segments = splitEmailThread(task.originalMessage ?? '');
  const newestBody = getDisplayMessageBody(segments[0], task.senderName, task.senderEmail);
  const quotedSegments = segments.slice(1);
  const hasMeta = task.senderName || task.senderEmail || task.receivedAt;
  const useIframe = !!task.emailBodyHtml;

  return (
    <div className="email-card">
      {hasMeta && (
        <div className="email-card-meta">
          {task.senderName && (
            <div className="email-card-meta-row">
              <span className="email-card-meta-key">Od</span>
              <span className="email-card-meta-val">{task.senderName}</span>
            </div>
          )}
          {task.senderEmail && (
            <div className="email-card-meta-row">
              <span className="email-card-meta-key">Email</span>
              <span className="email-card-meta-val">{task.senderEmail}</span>
            </div>
          )}
          {task.receivedAt && (
            <div className="email-card-meta-row">
              <span className="email-card-meta-key">Přijato</span>
              <span className="email-card-meta-val">{formatDate(task.receivedAt)}</span>
            </div>
          )}
        </div>
      )}

      {useIframe ? (
        <EmailHtmlFrame html={task.emailBodyHtml!} />
      ) : (
        newestBody && <div className="email-card-body">{newestBody}</div>
      )}

      {!useIframe && quotedSegments.length > 0 && (
        <div className="email-thread-older">
          {quotedSegments.map((seg, i) => (
            <div key={i}>
              <div className="email-thread-sep" />
              <QuotedSegment raw={seg} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
