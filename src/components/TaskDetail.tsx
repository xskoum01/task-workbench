import { useState, useEffect } from 'react';
import type { Task, TaskStatus, PlanningBucket, SkeletonPreview } from '../types';
import { useApp } from '../context/AppContext';
import { TypeBadge, SourceBadge, STATUS_LABELS } from './StatusBadge';
import ReplyModal from './ReplyModal';
import SkeletonPreviewModal from './SkeletonPreviewModal';
import ScriptAssistantPanel from './ScriptAssistantPanel';
import TaskForm from './TaskForm';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import { BUCKET_META, BUCKET_ORDER, computePlanning, effectiveBucket } from '../lib/planning';
import { isOverdue, formatRelativeDate } from '../lib/dates';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

type AiAction = 'analyze' | 'reply' | 'skeleton';

// All statuses in the progression order shown in the selector
const STATUS_OPTIONS: TaskStatus[] = [
  'new',
  'analyzed',
  'in-progress',
  'ready-for-review',
  'done',
  'blocked',
];

function confidenceClass(value: number): string {
  if (value >= 80) return '';
  if (value >= 60) return 'medium';
  return 'low';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

function formatEffort(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours === 1) return '1h';
  return `${hours}h`;
}

// ---------------------------------------------------------------------------
// Email message rendering helpers
// ---------------------------------------------------------------------------

const EMAIL_HEADER_FIELDS = ['From', 'Sent', 'Date', 'To', 'Cc', 'Bcc', 'Subject'] as const;
type EmailHeaderField = typeof EMAIL_HEADER_FIELDS[number];

// Gmail safety trust banner — appears inline when HTML is stripped.
const GMAIL_TRUST_BANNER_RE = /You don['']t often get email from\s+\S+\.?\s*Learn why this is important\.?\s*/gi;

// A header line at the start of a line — requires colon so "From what I know" is safe.
const HEADER_LINE_RE = /^(?:From|To|Cc|Bcc|Date|Sent|Subject):\s*.+/i;

const MIN_BODY_LENGTH = 20;

// ---------------------------------------------------------------------------
// Single-segment parser (line-by-line — accurate for multiline, regex for single-line)
// ---------------------------------------------------------------------------

interface ParsedSegment {
  headers: Partial<Record<EmailHeaderField, string>>;
  body: string;
}

/**
 * Parses a quoted email segment using a line-by-line approach.
 * Stops reading headers as soon as it hits a blank line or a non-header line.
 * This is accurate and never consumes body text as a header value.
 */
function parseSegmentLines(raw: string): ParsedSegment {
  const headers: Partial<Record<EmailHeaderField, string>> = {};
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') { i++; break; }
    const m = line.match(/^(From|Sent|Date|To|Cc|Bcc|Subject):\s*(.+)/i);
    if (m) {
      headers[m[1] as EmailHeaderField] = m[2].trim();
      i++;
    } else {
      break;
    }
  }

  return { headers, body: lines.slice(i).join('\n').trim() };
}

/**
 * In single-line email parsing the last header value absorbs body text because
 * there is no structural line separator. This function splits them apart.
 *
 * Heuristics (applied in order):
 *   1. Subject / generic: first sentence-end (.!?) followed by whitespace + any word
 *      that is NOT another "Word:" header pattern → body starts there.
 *      Covers: "Subject: RE: portal komentar 7. aha ok" → Subject="RE: portal komentar 7."
 *   2. From field: leading CamelCase name words, then first lowercase word = body.
 *      Covers: "From: Jaroslav Barták ok, super" → From="Jaroslav Barták", body="ok, super"
 *
 * Applied ALWAYS to the last parsed header (not only when trailing body is empty).
 * When uncertain, leaves value intact and returns empty body — never wrongly trims.
 */
function splitLastHeaderFromBody(
  field: EmailHeaderField,
  value: string,
): { headerVal: string; body: string } {
  // Heuristic 1: sentence-end followed by whitespace + text that does NOT look
  // like a new "Word: " header continuation (e.g. "RE: foo"). This is safe for
  // Subject lines like "RE: portal komentar 7. aha ok to ma nenapadlo".
  // We require the post-sentence text to NOT match "^\s*[A-Za-z]+:\s" (header start).
  const sentenceMatch = value.match(/^(.*?[.!?])\s+(?![A-Za-z]+:\s)(.+)$/s);
  if (sentenceMatch) {
    return { headerVal: sentenceMatch[1].trim(), body: sentenceMatch[2].trim() };
  }
  // Heuristic 2 (From field): capitalised name words, then first lowercase word = body.
  if (field === 'From') {
    const nameBodyMatch = value.match(/^((?:[A-Z]\S*(?:\s+|$))+)([a-z].*)$/);
    if (nameBodyMatch) {
      return { headerVal: nameBodyMatch[1].trim(), body: nameBodyMatch[2].trim() };
    }
  }
  return { headerVal: value, body: '' };
}

/**
 * Parses a quoted segment that may be on a single line (old stored data).
 * Uses a greedy lookahead regex — only call this when there are no newlines.
 */
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

  // Always attempt to split body out of the last header value.
  // The last field's regex group greedily absorbs body text when there is no
  // following header to stop it — so we must split regardless of whether there
  // is trailing text after the match.
  const lastKey = last[1] as EmailHeaderField;
  const lastVal = headers[lastKey] ?? '';
  const split = splitLastHeaderFromBody(lastKey, lastVal);
  if (split.body) {
    headers[lastKey] = split.headerVal;
    // Prepend any newly found body to whatever (if anything) followed the matches.
    body = body ? `${split.body} ${body}` : split.body;
  }

  return { headers, body };
}

function parseSegment(raw: string): ParsedSegment {
  return raw.includes('\n') ? parseSegmentLines(raw) : parseSegmentInline(raw);
}

// ---------------------------------------------------------------------------
// Thread splitter
// ---------------------------------------------------------------------------

/**
 * Returns true when `line` looks like the start of a quoted-reply header block
 * (i.e. "From: <something>") AND at least one companion field appears within
 * the next 4 lines. This avoids splitting on "From:" inside normal sentences.
 */
function isReplyHeaderStart(line: string, lines: string[], idx: number): boolean {
  if (!/^From:\s+.+/i.test(line)) return false;
  const COMPANION = /^(?:Sent|Date|To|Cc|Subject):\s+/i;
  for (let j = idx + 1; j < Math.min(idx + 5, lines.length); j++) {
    const t = lines[j].trim();
    if (COMPANION.test(t)) return true;
    if (t === '' && j > idx + 1) break; // blank line gap without companion — stop
  }
  return false;
}

/**
 * Splits a multiline email body into thread segments.
 * [0] is the newest message body; subsequent entries are older quoted replies.
 */
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

/**
 * Splits a single-line (legacy stored) email body into thread segments.
 * Only splits on "From: " that has a companion header field within 200 chars.
 */
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

/** Splits an email body into thread segments; handles both multiline and flat formats. */
function splitEmailThread(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [''];
  return trimmed.includes('\n')
    ? splitMultilineThread(trimmed)
    : splitInlineThread(trimmed);
}

// ---------------------------------------------------------------------------
// Body cleaning for the newest message
// ---------------------------------------------------------------------------

/**
 * Cleans the newest message segment for display:
 *   1. Strips Gmail trust banner
 *   2. Strips leading "From: <sender>" prefix when sender is known
 *   3. Strips leading header-line block (multiline format)
 * Falls back to original if stripping removes too much.
 */
function getDisplayMessageBody(raw: string, senderName?: string, senderEmail?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let result = trimmed;

  // Step 1: strip Gmail trust banner wherever it appears
  result = result.replace(GMAIL_TRUST_BANNER_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();

  // Step 2: strip leading "From: <sender>" prefix (single-line format)
  const knownSender = senderName ?? senderEmail;
  if (knownSender) {
    const escaped = knownSender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`^From:\\s+${escaped}\\s*`, 'i'), '').trim();
  }

  // Step 3: strip leading header-line block (multiline format)
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
// Rendering components
// ---------------------------------------------------------------------------

/** One dimmed quoted-reply block with its own parsed header. */
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

/** Email card: top metadata + newest body + dimmed quoted replies. */
function EmailCard({ task }: { task: Task }) {
  const segments = splitEmailThread(task.originalMessage);
  const newestBody = getDisplayMessageBody(segments[0], task.senderName, task.senderEmail);
  const quotedSegments = segments.slice(1);
  const hasMeta = task.senderName || task.senderEmail || task.receivedAt;

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

      {newestBody && <div className="email-card-body">{newestBody}</div>}

      {quotedSegments.length > 0 && (
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

// ---------------------------------------------------------------------------
// Bilingual analysis block
// ---------------------------------------------------------------------------

interface AnalysisLangBlockProps {
  lang: 'CZ' | 'EN';
  summary?: string;
  problems?: string[];
  actions?: string[];
  nextStep?: string;
  labelProblem: string;
  labelAction: string;
  labelNext: string;
}

function AnalysisLangBlock({
  lang, summary, problems, actions, nextStep,
  labelProblem, labelAction, labelNext,
}: AnalysisLangBlockProps) {
  const isCz       = lang === 'CZ';
  const hasProblems = problems && problems.length > 0;
  const hasActions  = actions  && actions.length  > 0;
  if (!summary && !hasProblems && !hasActions && !nextStep) return null;

  return (
    <div className="analysis-lang-block">
      <div className="analysis-lang-header">
        <span className={`detail-analysis-lang-badge${isCz ? ' detail-analysis-lang-badge--cz' : ''}`}>
          {lang}
        </span>
        {summary && <p className="detail-analysis-summary">{summary}</p>}
      </div>

      {hasProblems && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelProblem}</span>
          <ul className="detail-analysis-points">
            {problems!.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {hasActions && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelAction}</span>
          <ul className="detail-analysis-points">
            {actions!.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      {nextStep && (
        <div className="detail-analysis-next">
          <span className="detail-analysis-next-label">{labelNext}:</span>
          {nextStep}
        </div>
      )}
    </div>
  );
}

/** Detects whether a TaskAnalysis has real Czech bilingual data (not just legacy English). */
function hasCzBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryCz ||
    (ar.problemPointsCz && ar.problemPointsCz.length > 0) ||
    (ar.actionPointsCz  && ar.actionPointsCz.length  > 0) ||
    ar.nextStepCz
  );
}

/** Detects whether a TaskAnalysis has real English bilingual data. */
function hasEnBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryEn ||
    (ar.problemPointsEn && ar.problemPointsEn.length > 0) ||
    (ar.actionPointsEn  && ar.actionPointsEn.length  > 0) ||
    ar.nextStepEn
  );
}

/**
 * Renders the AI analysis block in one of three modes:
 *   - Bilingual: CZ block + EN block (when fresh analysis is present)
 *   - Partial:   only the language block that has data
 *   - Legacy:    one English-only block + re-run hint (old stored tasks)
 */
function AnalysisBlock({ result }: { result: NonNullable<Task['analysisResult']> }) {
  const hasCz = hasCzBilingualData(result);
  const hasEn = hasEnBilingualData(result);
  const hasBilingual = hasCz || hasEn;

  if (hasBilingual) {
    return (
      <div className="detail-analysis-block">
        {hasCz && (
          <AnalysisLangBlock
            lang="CZ"
            summary={result.summaryCz}
            problems={result.problemPointsCz}
            actions={result.actionPointsCz}
            nextStep={result.nextStepCz}
            labelProblem="Problém"
            labelAction="Co udělat"
            labelNext="Další krok"
          />
        )}
        {hasCz && hasEn && <div className="detail-analysis-divider" />}
        {hasEn && (
          <AnalysisLangBlock
            lang="EN"
            summary={result.summaryEn}
            problems={result.problemPointsEn}
            actions={result.actionPointsEn}
            nextStep={result.nextStepEn}
            labelProblem="Problem"
            labelAction="What to do"
            labelNext="Next step"
          />
        )}
      </div>
    );
  }

  // Legacy mode — old task with English-only analysis
  return (
    <div className="detail-analysis-block">
      <div className="analysis-legacy-block">
        {result.summary && <p className="detail-analysis-summary">{result.summary}</p>}
        {result.problemPoints && result.problemPoints.length > 0 && (
          <div className="analysis-subsection">
            <span className="analysis-subsection-label">Problem</span>
            <ul className="detail-analysis-points">
              {result.problemPoints.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
        {result.nextStep && (
          <div className="detail-analysis-next">
            <span className="detail-analysis-next-label">Next step:</span>
            {result.nextStep}
          </div>
        )}
      </div>
      <p className="analysis-rerun-hint">
        Click Analyze to generate a new analysis.
      </p>
    </div>
  );
}

interface PlanningSectionProps {
  task: Task;
}

function PlanningSection({ task }: PlanningSectionProps) {
  const computed  = computePlanning(task);
  const score     = task.priorityScore  ?? computed.priorityScore;
  const reason    = task.priorityReason ?? computed.priorityReason;
  const bucket    = effectiveBucket(task);
  const suggested = task.suggestedPlanningBucket ?? computed.suggestedPlanningBucket;

  // Whether the user manually overrode the suggestion
  const isManual   = !!task.isPlanningLocked;
  // Whether the manual choice differs from the current suggestion
  const isMismatch = isManual && task.planningBucket && task.planningBucket !== suggested;
  // Overdue check
  const taskOverdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;

  const scoreClass = score >= 80
    ? 'planning-score--high'
    : score >= 50
      ? 'planning-score--mid'
      : 'planning-score--low';

  return (
    <div className="detail-section detail-planning-section">
      <span className="detail-section-label">Planning</span>

      {/* Due date + effort row */}
      {(task.dueAt || task.estimatedEffort !== undefined) && (
        <div className="detail-planning-meta">
          {task.dueAt && (
            <div className={`detail-planning-meta-item${taskOverdue ? ' detail-planning-meta-item--overdue' : ''}`}>
              <Icon name="due" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Due</span>
              <span className="detail-planning-meta-value">
                {formatRelativeDate(task.dueAt, task.status)}
                {taskOverdue && <span className="overdue-badge overdue-badge--inline">overdue</span>}
              </span>
            </div>
          )}
          {task.estimatedEffort !== undefined && (
            <div className="detail-planning-meta-item">
              <Icon name="effort" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Effort</span>
              <span className="detail-planning-meta-value">{formatEffort(task.estimatedEffort)}</span>
            </div>
          )}
        </div>
      )}

      {/* Effective bucket + lock / suggestion indicators */}
      <div className="detail-planning-bucket-row">
        <span className={`planning-bucket-pill planning-bucket-pill--${bucket}`}>
          <Icon name={BUCKET_META[bucket].icon} size={11} />
          {BUCKET_META[bucket].label}
        </span>
        {isManual ? (
          <span className="detail-planning-locked" title="Planning manually locked">
            <Icon name="pin" size={11} /> manual
          </span>
        ) : (
          <span className="detail-planning-auto" title="Auto-suggested by rule engine">
            <Icon name="bolt" size={11} /> auto
          </span>
        )}
        {isMismatch && suggested && (
          <span className="detail-planning-suggestion" title="Auto-suggestion differs from manual choice">
            → suggested: {BUCKET_META[suggested].label}
          </span>
        )}
      </div>

      {/* Priority score */}
      <div className="detail-planning-score-row">
        <span className="detail-planning-score-label">Priority</span>
        <div className="detail-planning-score-bar-wrap">
          <div className={`detail-planning-score-bar ${scoreClass}`} style={{ width: `${score}%` }} />
        </div>
        <span className={`detail-planning-score-num ${scoreClass}`}>{score}</span>
      </div>
      {reason && (
        <span className="detail-planning-reason">{reason}</span>
      )}
    </div>
  );
}

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const { updateTask, deleteTask, getCustomerById, customers, settings, crmFolders, resolveOrCreateCustomerByFolder } = useApp();
  const customer = getCustomerById(task.customerId);

  // Effective VS Code path: prefer explicit paths, fall back to crmBaseDirectory + folderName.
  const crmFolderPath = (settings?.crmBaseDirectory && customer?.folderName)
    ? `${settings.crmBaseDirectory}/${customer.folderName}`
    : undefined;
  const effectiveVscodePath = customer?.pluginFolder ?? customer?.repositoryRoot ?? crmFolderPath;

  // Inline feedback message (e.g. "Analysis recorded")
  const [feedback, setFeedback] = useState<string | null>(null);
  // Filesystem error message
  const [fsError, setFsError]   = useState<string | null>(null);
  // AI error message
  const [aiError, setAiError]   = useState<string | null>(null);
  // Which AI action is currently running
  const [aiLoading, setAiLoading] = useState<AiAction | null>(null);
  // Reply modal
  const [showReply, setShowReply]         = useState(false);
  const [generatedReply, setGeneratedReply] = useState<string | null>(null);
  // Skeleton preview modal
  const [showSkeleton, setShowSkeleton]       = useState(false);
  const [skeletonPreview, setSkeletonPreview] = useState<SkeletonPreview | null>(null);
  // Edit task form
  const [showEditForm, setShowEditForm] = useState(false);
  // Delete confirmation step
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Notes — local state, saved on blur
  const [notes, setNotes] = useState(task.notes ?? '');
  // Keep notes in sync when task changes (e.g. different task selected)
  useEffect(() => { setNotes(task.notes ?? ''); }, [task.id, task.notes]);

  async function handleDelete() {
    await deleteTask(task.id);
    onClose();
  }

  async function handleNotesSave() {
    if (notes !== (task.notes ?? '')) {
      await updateTask(task.id, { notes });
    }
  }

  // Auto-clear feedback / error messages after a delay
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  useEffect(() => {
    if (!fsError) return;
    const t = setTimeout(() => setFsError(null), 6000);
    return () => clearTimeout(t);
  }, [fsError]);

  useEffect(() => {
    if (!aiError) return;
    const t = setTimeout(() => setAiError(null), 8000);
    return () => clearTimeout(t);
  }, [aiError]);

  // --- Status change ---

  async function handleStatusChange(status: TaskStatus) {
    await updateTask(task.id, { status });
  }

  // --- Workflow actions ---

  async function handleAnalyze() {
    setAiLoading('analyze');
    setAiError(null);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      await updateTask(task.id, {
        status:         'analyzed',
        analysisResult: result,
        confidence:     result.confidence,
      });
      setFeedback('AI analysis complete — status set to Analyzed');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(null);
    }
  }

  async function handleDoIt() {
    // Set in-progress and open the best available dev path in VS Code
    await updateTask(task.id, { status: 'in-progress' });
    const devPath = customer?.pluginFolder ?? customer?.repositoryRoot;
    if (devPath) {
      try {
        await tauriApi.openInVscode(devPath);
      } catch (e) {
        setFsError(String(e));
      }
    } else {
      setFeedback('Status set to In Progress. Configure customer paths to open VS Code automatically.');
    }
  }

  async function handleCreateSkeleton() {
    setAiLoading('skeleton');
    setAiError(null);
    try {
      const preview = await tauriApi.generateSkeletonPreview(task, customer ?? null);
      setSkeletonPreview(preview);
      setShowSkeleton(true);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(null);
    }
  }

  async function handleValidate() {
    await updateTask(task.id, { status: 'ready-for-review' });
    setFeedback('Status set to Ready for Review');
  }

  // --- Communication ---

  async function handleGenerateReply() {
    setAiLoading('reply');
    setAiError(null);
    try {
      const draft = await tauriApi.generateReply(task, customer ?? null);
      await updateTask(task.id, { generatedReply: draft });
      setGeneratedReply(draft);
    } catch (e) {
      // Fall back to local template — open modal anyway
      setGeneratedReply(null);
      setAiError(String(e));
    } finally {
      setAiLoading(null);
      setShowReply(true);
    }
  }

  // --- Planning actions ---

  async function handleSetBucket(bucket: PlanningBucket) {
    const planning = computePlanning(task);
    await updateTask(task.id, {
      planningBucket:          bucket,
      suggestedPlanningBucket: planning.suggestedPlanningBucket,
      priorityScore:           planning.priorityScore,
      priorityReason:          planning.priorityReason,
      isPlanningLocked:        true,
    });
    setFeedback(`Planned for: ${BUCKET_META[bucket].label}`);
  }

  async function handleToggleLock() {
    const next = !task.isPlanningLocked;
    await updateTask(task.id, { isPlanningLocked: next });
    setFeedback(next ? 'Planning locked to manual choice' : 'Planning unlocked — auto-suggest active');
  }

  // --- URL actions ---

  function handleOpenUrl(url: string | undefined) {
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    tauriApi.openUrl(href).catch((err) => {
      console.warn('openUrl failed, falling back to window.open:', err);
      window.open(href, '_blank', 'noopener,noreferrer');
    });
  }

  // --- Filesystem actions ---

  async function handleOpenPath(path: string | undefined, label: string) {
    if (!path) {
      setFsError(`No ${label} configured for this customer.`);
      return;
    }
    try {
      await tauriApi.openPath(path);
    } catch (e) {
      setFsError(String(e));
    }
  }

  async function handleOpenVscode(path: string | undefined) {
    if (!path) {
      setFsError('No repository root configured for this customer.');
      return;
    }
    try {
      await tauriApi.openInVscode(path);
    } catch (e) {
      setFsError(String(e));
    }
  }

  // Determine which filesystem buttons are relevant
  const hasRepo    = !!customer?.repositoryRoot;
  const hasPlugin  = !!customer?.pluginFolder;
  const hasScript  = !!customer?.scriptFolder;
  // Show VS Code button whenever any path is resolvable (including CRM folder)
  const hasVscodePath = !!effectiveVscodePath;
  const hasAnyPath = hasRepo || hasPlugin || hasScript || hasVscodePath;

  return (
    <>
      <aside className="detail-panel">

        {/* ---- Header ---- */}
        <div className="detail-panel-header">
          <div className="detail-panel-header-content">
            <div className="detail-panel-title">{task.title}</div>

            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Inline status selector — styled to match the badge palette */}
              <select
                className={`detail-status-select detail-status-${task.status}`}
                value={task.status}
                onChange={(e) => handleStatusChange(e.target.value as TaskStatus)}
                title="Change status"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>

              <TypeBadge type={task.taskType} />
              {task.analysisResult && (
                <span className="detail-ai-badge">AI</span>
              )}
            </div>
          </div>

          <button
            className="detail-panel-back"
            onClick={onClose}
            title="Back to list"
          >
            <Icon name="arrow-left" size={14} /> Back
          </button>

          <button
            className="detail-panel-edit"
            onClick={() => setShowEditForm(true)}
            title="Edit task"
          >
            <Icon name="pencil" size={14} />
          </button>
          {confirmDelete ? (
            <>
              <button
                className="btn btn-danger btn-sm"
                onClick={handleDelete}
                title="Confirm delete"
              >
                Delete
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmDelete(false)}
                title="Cancel delete"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="detail-panel-delete"
              onClick={() => setConfirmDelete(true)}
              title="Delete task"
            >
              <Icon name="trash-2" size={14} />
            </button>
          )}
        </div>

        {/* ---- Two-column inner layout ---- */}
        <div className="detail-panel-inner">

        {/* ---- Body ---- */}
        <div className="detail-panel-body">

          {/* Meta grid */}
          <div className="detail-meta-grid">
            <div className="detail-section">
              <span className="detail-section-label">Source</span>
              <SourceBadge source={task.source} />
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Received</span>
              <span className="detail-section-value">
                {formatDate(task.receivedAt)}
              </span>
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Customer</span>
              {customer ? (
                <span className="detail-section-value">{customer.name}</span>
              ) : (
                <div className="detail-customer-unresolved">
                  <span className="detail-customer-missing">No customer assigned</span>
                  {(customers.length > 0 || crmFolders.length > 0) && (
                    <select
                      className="detail-customer-select"
                      value=""
                      title="Assign customer"
                      onChange={async (e) => {
                        const val = e.target.value;
                        if (!val) return;
                        let customerId: string;
                        if (val.startsWith('crm:')) {
                          customerId = await resolveOrCreateCustomerByFolder(val.slice(4));
                        } else {
                          customerId = val;
                        }
                        await updateTask(task.id, { customerId });
                      }}
                    >
                      <option value="" disabled>Assign customer…</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      {crmFolders
                        .filter((f) => !customers.some((c) => c.folderName?.toLowerCase() === f.toLowerCase()))
                        .map((f) => (
                          <option key={`crm:${f}`} value={`crm:${f}`}>{f}</option>
                        ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Task Type</span>
              <TypeBadge type={task.taskType} />
            </div>
          </div>

          {/* Confidence */}
          <div className="detail-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="detail-section-label">Confidence</span>
              <span className="detail-confidence-value">{task.confidence}%</span>
            </div>
            <div className="detail-confidence-bar">
              <div
                className={`detail-confidence-fill ${confidenceClass(task.confidence)}`}
                style={{ width: `${task.confidence}%` }}
              />
            </div>
          </div>

          {/* Customer repository info */}
          {customer && (hasRepo || hasPlugin || hasScript || customer.namespace) && (
            <div className="detail-section">
              <span className="detail-section-label">Repository</span>
              <div className="detail-repo-block">
                {customer.repositoryName && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Name</span>
                    <span className="detail-repo-value">{customer.repositoryName}</span>
                  </div>
                )}
                {customer.namespace && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">NS</span>
                    <span className="detail-repo-value">{customer.namespace}</span>
                  </div>
                )}
                {customer.repositoryRoot && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Root</span>
                    <span className="detail-repo-value">{customer.repositoryRoot}</span>
                  </div>
                )}
                {customer.pluginFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Plugin</span>
                    <span className="detail-repo-value">{customer.pluginFolder}</span>
                  </div>
                )}
                {customer.scriptFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Scripts</span>
                    <span className="detail-repo-value">{customer.scriptFolder}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Original message */}
          <div className="detail-section">
            <span className="detail-section-label">Original Message</span>
            {task.originalMessage ? (
              task.source === 'email' ? (
                <EmailCard task={task} />
              ) : (
                <div className="detail-message">
                  <div className="email-body" style={{ padding: 'var(--gap-md) var(--gap-lg)' }}>
                    {task.originalMessage}
                  </div>
                </div>
              )
            ) : (
              <span className="detail-empty-inline">No message provided</span>
            )}
          </div>

          {/* Notes */}
          <div className="detail-section">
            <span className="detail-section-label">Notes</span>
            <textarea
              className="detail-notes-textarea"
              value={notes}
              placeholder="Write notes, context, or reminders…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={handleNotesSave}
            />
          </div>

          {/* Azure DevOps context — shown for ADO-sourced tasks with parsed metadata */}
          {task.adoContext && task.adoContext.type !== 'other' && (
            <div className="detail-section detail-ado-section">
              <span className="detail-section-label">
                {task.adoContext.type === 'pr-comment' ? 'PR Review Context' : 'Work Item Context'}
              </span>
              <div className="detail-ado-block">
                {/* PR comment fields */}
                {task.adoContext.type === 'pr-comment' && (
                  <>
                    {task.adoContext.prNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">PR</span>
                        <span className="detail-ado-value">#{task.adoContext.prNumber}</span>
                      </div>
                    )}
                    {task.adoContext.reviewerName && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Reviewer</span>
                        <span className="detail-ado-value">{task.adoContext.reviewerName}</span>
                      </div>
                    )}
                    {task.adoContext.commentedFile && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">File</span>
                        <span className="detail-ado-value detail-ado-value--code">{task.adoContext.commentedFile}</span>
                      </div>
                    )}
                    {task.adoContext.reviewComment && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Comment:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.reviewComment}</div>
                      </div>
                    )}
                  </>
                )}
                {/* Work item fields */}
                {task.adoContext.type === 'work-item' && (
                  <>
                    {task.adoContext.workItemNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">{task.adoContext.workItemType ?? 'Item'}</span>
                        <span className="detail-ado-value">#{task.adoContext.workItemNumber}</span>
                      </div>
                    )}
                    {task.adoContext.workItemState && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">State</span>
                        <span className="detail-ado-value">{task.adoContext.workItemState}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAssignedTo && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Assigned</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAssignedTo}</span>
                      </div>
                    )}
                    {task.adoContext.workItemPriority && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Priority</span>
                        <span className="detail-ado-value">{task.adoContext.workItemPriority}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAreaPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Area</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAreaPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemIterationPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Iteration</span>
                        <span className="detail-ado-value">{task.adoContext.workItemIterationPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemDescription && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Description:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.workItemDescription}</div>
                      </div>
                    )}
                    {task.adoContext.workItemUrl && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">DevOps</span>
                        <button
                          className="detail-tracking-link"
                          onClick={() => handleOpenUrl(task.adoContext!.workItemUrl)}
                        >
                          Open in Azure DevOps ↗
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* AI Analysis result */}
          {task.analysisResult && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">AI analýza / analysis</span>
              <AnalysisBlock result={task.analysisResult} />
            </div>
          )}

          {/* Legacy suggested steps — hidden when bilingual action bullets cover them */}
          {!(task.analysisResult?.actionPointsCz?.length) && !(task.analysisResult?.actionPointsEn?.length) &&
           (task.analysisResult?.suggestedActions ?? task.suggestedActions).length > 0 && (
            <div className="detail-section">
              <span className="detail-section-label">
                {task.analysisResult ? 'Navrhované kroky' : 'Suggested Steps'}
              </span>
              <div className="detail-suggestions">
                {(task.analysisResult?.suggestedActions ?? task.suggestedActions).map((sa, i) => (
                  <div key={sa.id} className="detail-suggestion-item">
                    <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{i + 1}.</span>
                    {sa.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tracking section — only rendered when at least one field is set */}
          {(task.ticketUrl || task.devopsTaskUrl || task.budgetHours !== undefined || task.budgetNote) && (
            <div className="detail-section">
              <span className="detail-section-label">Tracking</span>
              <div className="detail-tracking-block">
                {task.ticketUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Ticket</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.ticketUrl)}
                      title={task.ticketUrl}
                    >
                      Open Ticket ↗
                    </button>
                  </div>
                )}
                {task.devopsTaskUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">DevOps</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.devopsTaskUrl)}
                      title={task.devopsTaskUrl}
                    >
                      Open DevOps Task ↗
                    </button>
                  </div>
                )}
                {task.budgetHours !== undefined && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Budget</span>
                    <span className="detail-tracking-value">
                      {task.budgetHours}h
                    </span>
                  </div>
                )}
                {task.budgetNote && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Note</span>
                    <span className="detail-tracking-value detail-tracking-note">
                      {task.budgetNote}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Planning section */}
          {task.status !== 'done' && (
            <PlanningSection task={task} />
          )}

        </div>

        {/* ---- Action footer ---- */}
        <div className="detail-action-groups">

          {/* Inline feedback message */}
          {feedback && (
            <div className="detail-feedback-ok">
              <Icon name="check" size={12} /> {feedback}
            </div>
          )}

          {/* AI error message */}
          {aiError && (
            <div className="detail-fs-error">! {aiError}</div>
          )}

          {/* WORKFLOW */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Workflow</div>
            <div className="detail-action-grid">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAnalyze}
                disabled={!!aiLoading}
                title="Analyse task with AI and set status to Analyzed"
              >
                {aiLoading === 'analyze'
                  ? <><span className="btn-spinner" /> Analysing…</>
                  : <><Icon name="search" size={13} /> Analyze</>}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleDoIt}
                disabled={!!aiLoading}
                title="Set In Progress and open in VS Code"
              >
                <Icon name="play" size={13} /> Do It
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCreateSkeleton}
                disabled={!!aiLoading}
                title="Generate C# plugin skeleton with AI"
              >
                {aiLoading === 'skeleton'
                  ? <><span className="btn-spinner" /> Generating…</>
                  : <><Icon name="layers" size={13} /> Skeleton</>}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleValidate}
                disabled={!!aiLoading}
                title="Mark as Ready for Review"
              >
                <Icon name="check" size={13} /> Validate
              </button>
            </div>
          </div>

          {/* SCRIPT ASSISTANT — shown when customer has a script folder or repo root */}
          {customer && (customer.scriptFolder || customer.resolvedRepositoryPath || customer.repositoryRoot) && (
            <ScriptAssistantPanel task={task} customer={customer} />
          )}

          {/* AZURE DEVOPS — shown for ADO PR comment/review tasks with an extracted deep link */}
          {(() => {
            const adoUrl =
              task.adoContext?.type === 'pr-comment'
                ? (task.adoContext.prUrl ?? task.adoContext.workItemUrl ?? null)
                : task.adoContext?.type === 'work-item'
                  ? (task.adoContext.workItemUrl ?? null)
                  : null;
            console.log(
              `[ado-link] TaskDetail render check`,
              `taskId=${task.id}`,
              `adoType=${task.adoContext?.type ?? 'none'}`,
              `prUrl=${task.adoContext?.prUrl ?? 'none'}`,
              `resolvedUrl=${adoUrl ?? 'none'}`,
            );
            if (!adoUrl) return null;
            return (
              <div className="detail-action-group">
                <div className="detail-action-group-label">Azure DevOps</div>
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenUrl(adoUrl)}
                  title={adoUrl}
                >
                  <Icon name="external-link" size={13} /> Open in DevOps
                </button>
              </div>
            );
          })()}

          {/* FILESYSTEM — only rendered when the customer has at least one path */}
          {hasAnyPath && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">Filesystem</div>

              {hasRepo && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.repositoryRoot, 'repository root')}
                >
                  <Icon name="folder" size={13} /> Open Repository
                </button>
              )}

              {hasPlugin && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.pluginFolder, 'plugin folder')}
                >
                  <Icon name="plug" size={13} /> Open Plugin Folder
                </button>
              )}

              {hasScript && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.scriptFolder, 'script folder')}
                >
                  <Icon name="file-text" size={13} /> Open Script Folder
                </button>
              )}

              {(hasRepo || hasVscodePath) && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenVscode(effectiveVscodePath)}
                >
                  <Icon name="terminal" size={13} /> Open in VS Code
                </button>
              )}

              {/* Filesystem error strip */}
              {fsError && (
                <div className="detail-fs-error">! {fsError}</div>
              )}
            </div>
          )}

          {/* Show fs error even when no paths configured (e.g. from workflow actions) */}
          {!hasAnyPath && fsError && (
            <div className="detail-fs-error">! {fsError}</div>
          )}

          {/* COMMUNICATION */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Communication</div>
            <button
              className="btn btn-secondary btn-sm btn-full"
              onClick={handleGenerateReply}
              disabled={!!aiLoading}
            >
              {aiLoading === 'reply'
                ? <><span className="btn-spinner" /> Drafting…</>
                : <><Icon name="mail" size={13} /> Generate Reply</>}
            </button>
          </div>

          {/* PLANNING — quick bucket assignment */}
          {task.status !== 'done' && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">
                Plan for
                {task.isPlanningLocked && (
                  <span className="planning-lock-badge">
                    <Icon name="pin" size={10} /> locked
                  </span>
                )}
              </div>
              <div className="detail-plan-grid">
                {BUCKET_ORDER.map((b) => {
                  const active = effectiveBucket(task) === b;
                  return (
                    <button
                      key={b}
                      className={`btn btn-sm${active ? ' btn-primary' : ' btn-secondary'} planning-bucket-btn`}
                      onClick={() => handleSetBucket(b)}
                      title={BUCKET_META[b].label}
                    >
                      <Icon name={BUCKET_META[b].icon} size={12} />
                      {BUCKET_META[b].label}
                    </button>
                  );
                })}
              </div>
              <button
                className="btn btn-ghost btn-sm planning-lock-toggle"
                onClick={handleToggleLock}
              >
                {task.isPlanningLocked
                  ? <><Icon name="unlock" size={12} /> Unlock (use auto-suggest)</>
                  : <><Icon name="lock" size={12} /> Lock manual choice</>}
              </button>
            </div>
          )}

        </div>
        </div>{/* end detail-panel-inner */}
      </aside>

      {/* Reply modal */}
      {showReply && (
        <ReplyModal
          task={task}
          customer={customer}
          onClose={() => { setShowReply(false); setGeneratedReply(null); }}
          initialText={generatedReply ?? task.generatedReply ?? undefined}
        />
      )}

      {/* Skeleton preview modal */}
      {showSkeleton && skeletonPreview && (
        <SkeletonPreviewModal
          preview={skeletonPreview}
          customer={customer}
          onClose={() => { setShowSkeleton(false); setSkeletonPreview(null); }}
        />
      )}

      {/* Edit task form */}
      {showEditForm && (
        <TaskForm
          initialTask={task}
          onClose={() => setShowEditForm(false)}
        />
      )}
    </>
  );
}
