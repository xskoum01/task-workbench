import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { Task, Customer, AppSettings, CreateRepoResult, CreateRepoOptions, TaskType, ClassificationState, PlanningBucket, AdoEmailContext } from '../types';
import * as api from '../lib/tauriCommands';
import { defaultSettings } from '../data/mockData';
import { OTHER_CUSTOMER, OTHER_CUSTOMER_ID } from '../data/mockData';
import { prefilter } from '../lib/prefilter';
import { matchCustomer } from '../lib/customerMatch';
import { normalizeText, normalizeTitle } from '../lib/textNormalize';

// --- Context value shape ---------------------------------------------------

export interface ImportMessageInput {
  externalMessageId: string;
  sourceThreadId?: string;
  sourceUrl?: string;
  source: 'email' | 'teams';
  title: string;
  senderName?: string;
  senderEmail?: string;
  content: string;
  receivedAt: string;
  /** Heuristic-derived planning bucket (used before and as AI fallback). */
  heuristicBucket?: PlanningBucket;
  /** Heuristic-derived priority score 0–100. */
  heuristicPriority?: number;
  /** Short reason for the heuristic priority, shown in the UI. */
  heuristicReason?: string;
  /**
   * Pre-resolved customer ID (e.g. from deterministic ADO parsing).
   * When set, bypasses the matchCustomer heuristic and uses this ID directly.
   */
  preResolvedCustomerId?: string;
  /**
   * Structured Azure DevOps context extracted by the ADO parser.
   * Stored on the task for display in TaskDetail.
   */
  adoContext?: AdoEmailContext;
  /**
   * When true the user is manually overriding auto-classification.
   * The item is created as a real task immediately:
   *   - prefilter and AI are skipped
   *   - if an existing rejected/analyzed record exists, it is upgraded in-place
   *   - if already 'created', returns duplicate to prevent doubling
   */
  forceCreate?: boolean;
  /**
   * Signals that this import was triggered by an explicit user intent signal
   * (e.g. Outlook panel import, manual Teams message selection).
   *
   * Effect: AI enriches the task (summary, type, customer, effort, due date) but
   * no longer acts as a gatekeeper. The item always surfaces as at minimum
   * 'analyzed' (inbox review), regardless of AI confidence or isTask verdict.
   * High-confidence AI results (>= CONFIDENCE_AUTO_CREATE) still auto-create.
   *
   * The ADO deterministic path never sets this — it has its own confidence values.
   */
  captureMode?: 'explicit';
  /**
   * CID-resolved HTML body from Microsoft Graph — used only for display in TaskDetail.
   * Never fed into AI, prefilter, ADO parsing, or text normalization.
   */
  emailBodyHtml?: string;
}

export type ImportOutcome = 'duplicate' | 'rejected' | 'analyzed' | 'created';

export interface ImportResult {
  outcome: ImportOutcome;
  reason?: string;
  taskId?: string;
  /** Set when outcome === 'duplicate'. Tells callers what state the existing item is in. */
  existingState?: ClassificationState;
}

interface AppContextValue {
  tasks: Task[];
  customers: Customer[];
  settings: AppSettings;
  /** Subfolder names from the configured CRM base directory — used as customer candidates. */
  crmFolders: string[];
  isLoading: boolean;
  error: string | null;

  // Task operations
  createTask: (draft: Omit<Task, 'id' | 'receivedAt' | 'suggestedActions'>) => Promise<void>;
  updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  /** Re-fetches tasks from storage. Useful after external writes (e.g. MCP tools). */
  reloadTasks: () => Promise<void>;

  // Import pipeline — normalises, deduplicates, prefilters, and classifies
  importMessage: (input: ImportMessageInput) => Promise<ImportResult>;

  // Customer operations
  createCustomer: (draft: Omit<Customer, 'id'>) => Promise<void>;
  updateCustomer: (id: string, updates: Partial<Customer>) => Promise<void>;
  /** Removes the customer record from app state and storage. Does not touch disk. */
  deleteCustomer: (id: string) => Promise<void>;
  /**
   * Finds an existing customer whose folderName matches, or creates a minimal
   * Customer record for the folder. Returns the customer ID.
   */
  resolveOrCreateCustomerByFolder: (folderName: string) => Promise<string>;

  // Repository operations
  rescanRepositories: () => Promise<void>;
  createRepositoryFromTemplate: (customer: Customer, options?: CreateRepoOptions) => Promise<CreateRepoResult>;

  // Settings operations
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;

  // Week log
  updateWeeklyNote: (date: string, note: string) => Promise<void>;

  // Convenience lookup
  getCustomerById: (id: string) => Customer | undefined;
}

// --- Context ---------------------------------------------------------------

const AppContext = createContext<AppContextValue | null>(null);

// --- Hook ------------------------------------------------------------------

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

// --- ID generation ---------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Merges newly discovered CRM folders into an existing customer list.
 * Creates minimal customer records for folders that have no matching customer.
 * Returns the merged list and a flag indicating whether anything changed.
 */
function mergeDiscoveredFolders(
  existing: Customer[],
  folders: string[],
): { merged: Customer[]; changed: boolean } {
  let merged = existing;
  let changed = false;
  for (const folder of folders) {
    const has = existing.find(
      (c) =>
        c.folderName?.toLowerCase() === folder.toLowerCase() ||
        c.name.toLowerCase() === folder.toLowerCase(),
    );
    if (!has) {
      const code = folder
        .replace(/^CRM_/i, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, 6) || 'CRM';
      merged = [
        ...merged,
        { id: generateId(), name: folder, shortCode: code, folderName: folder },
      ];
      changed = true;
    }
  }
  return { merged, changed };
}

// ---------------------------------------------------------------------------
// Import pipeline configuration
// All classification thresholds live here — easy to tune in one place.
// ---------------------------------------------------------------------------

const IMPORT_CONFIG = {
  // confidence >= this → create task automatically
  // Set conservatively: only high-signal items auto-create; borderline items go to review.
  CONFIDENCE_AUTO_CREATE: 85,
  // confidence >= this → keep as analyzed inbox item for user review
  // confidence < this (or isTask=false) → reject
  MIN_CONFIDENCE_ANALYZE: 50,
} as const;

// Valid taskType values from the backend schema
const VALID_TASK_TYPES = new Set(['bug-fix', 'feature', 'review', 'question', 'deployment', 'other']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode basic entities — used before sending content to AI. */
function stripHtmlTags(html: string): string {
  // 1. <br> variants → newline
  // 2. Block-level open/close tags → newline (preserves paragraph/list structure)
  // 3. Remaining inline tags → space
  // 4. Collapse horizontal whitespace only; normalize excessive blank lines (max 2)
  const BLOCK_RE = /<\/?(p|div|li|tr|td|th|h[1-6]|blockquote|pre|ul|ol|table|section|article|header|footer|hr)\b[^>]*>/gi;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_RE, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Run through full normalizer for mojibake + entity decoding.
  // normalizeText's whitespace step only collapses [ \t]+, so newlines survive.
  return normalizeText(text);
}

/** Detect a short human-readable hint for what kind of message this is. */
function detectClassificationLabel(title: string, content: string, senderEmail?: string): string | undefined {
  const t      = title.toLowerCase();
  const c      = content.toLowerCase();
  const sender = (senderEmail ?? '').toLowerCase();
  const combo  = `${t} ${c}`;

  // Calendar invitations (subject-anchored patterns)
  if (/^invitation:/.test(t) || /training\s+invitation|webinar\s+invitation/.test(t)) return 'Meeting invitation';
  if (/join\s+(?:microsoft\s+)?teams\s+meeting/.test(c)) return 'Meeting invitation';
  if (/^accepted:|^declined:|^tentative:|^cancelled:/.test(t)) return 'Calendar response';

  // Azure DevOps — PR/code review
  if (/pull\s+request|pr\s+comment|code\s+review/.test(combo) || /pull\s+request/.test(t)) return 'PR feedback';

  // Azure DevOps — work items
  if (/azure[‑\-]?devops|visualstudio\.com/.test(sender)) {
    if (/work\s+item|task\s+\d|bug\s+\d|story\s+\d|feature\s+\d|epic\s+\d/.test(combo)) return 'ADO work item';
    if (/pipeline|build\s+(succeeded|failed|completed)/.test(combo)) return 'Build notification';
    return 'ADO notification';
  }

  // CI/CD build results
  if (/build\s+(succeeded|failed|completed)|pipeline\s+(succeeded|failed)/.test(combo)) return 'Build notification';

  return undefined;
}

// --- Provider --------------------------------------------------------------

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks]         = useState<Task[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [settings, setSettings]   = useState<AppSettings>(defaultSettings);
  const [crmFolders, setCrmFolders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error]                   = useState<string | null>(null);

  // tasksRef always holds the latest tasks array.
  // importMessage reads from this ref so concurrent imports don't capture
  // the same stale closure snapshot and overwrite each other's state.
  const tasksRef = useRef<Task[]>([]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  // Load all data once on mount
  useEffect(() => {
    async function load() {
      try {
        const [loadedTasks, loadedCustomers, loadedSettings] = await Promise.all([
          api.loadTasks(),
          api.loadCustomers(),
          api.loadSettings(),
        ]);

        // Reconcile stored M365 connection status with the actual token cache.
        if (loadedSettings.microsoftConnectionStatus === 'connected') {
          try {
            const tokenState = await api.getMicrosoftConnectionState();
            if (tokenState === 'disconnected') {
              loadedSettings.microsoftConnectionStatus = 'disconnected';
              loadedSettings.outlookStatus = 'not_configured';
              loadedSettings.teamsStatus   = 'not_configured';
              loadedSettings.graphEnabled  = false;
            }
          } catch {
            // Not a Tauri context — silently ignore.
          }
        }

        // Auto-discover customers from CRM base directory on load (before state update).
        let finalCustomers = loadedCustomers;
        const baseDir = loadedSettings.crmBaseDirectory ?? '';
        if (baseDir) {
          try {
            const folders = await api.listCrmFolders(baseDir);
            setCrmFolders(folders);
            const { merged, changed } = mergeDiscoveredFolders(loadedCustomers, folders);
            if (changed) {
              finalCustomers = merged;
              api.saveCustomers(merged).catch(() => undefined);
            }
          } catch {
            // Not critical — Tauri unavailable in browser dev mode
          }
        }

        setTasks(loadedTasks);
        // Always ensure the Other sentinel customer is present.
        const withOther = finalCustomers.some((c) => c.id === OTHER_CUSTOMER_ID)
          ? finalCustomers
          : [OTHER_CUSTOMER, ...finalCustomers];
        setCustomers(withOther);
        setSettings(loadedSettings);
      } catch (err) {
        // Tauri runtime not available (e.g. plain Vite dev server in browser).
        console.warn('Tauri unavailable — starting with empty state:', err);
        setTasks([]);
        setCustomers([]);
        setSettings(defaultSettings);
      } finally {
        setIsLoading(false);
      }
    }
    load();

    // Listen for MCP bridge writes and reload tasks to keep UI in sync
    const unlisten = listen('tasks-changed-externally', () => {
      api.loadTasks().then((updated) => {
        setTasks(updated);
      }).catch(() => {});
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // --- Task operations ---

  // All three task-mutation callbacks use the functional form of setTasks so they always
  // operate on the latest state — safe for rapid sequential calls from async handlers.
  // `captured` is set synchronously inside the updater before the async saveTasks call.

  const createTask = useCallback(
    async (draft: Omit<Task, 'id' | 'receivedAt' | 'suggestedActions'>) => {
      const newTask: Task = {
        ...draft,
        id:               generateId(),
        receivedAt:       new Date().toISOString(),
        suggestedActions: [],
      };
      let captured: Task[] = [];
      setTasks((prev) => {
        const next = [...prev, newTask];
        captured = next;
        return next;
      });
      try {
        await api.saveTasks(captured);
      } catch (err) {
        console.warn('saveTasks failed:', err);
      }
    },
    [],
  );

  const updateTask = useCallback(
    async (id: string, updates: Partial<Task>) => {
      let captured: Task[] = [];
      setTasks((prev) => {
        const next = prev.map((t) => {
          if (t.id !== id) return t;
          const merged = { ...t, ...updates };
          // Track completion timestamp automatically.
          if (updates.status === 'done' && t.status !== 'done') {
            merged.completedAt = new Date().toISOString();
          } else if (updates.status && updates.status !== 'done' && t.status === 'done') {
            merged.completedAt = undefined;
          }
          return merged;
        });
        captured = next;
        return next;
      });
      try {
        await api.saveTasks(captured);
      } catch (err) {
        console.warn('saveTasks failed:', err);
      }
    },
    [],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      let captured: Task[] = [];
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== id);
        captured = next;
        return next;
      });
      try {
        await api.saveTasks(captured);
      } catch (err) {
        console.warn('saveTasks (deleteTask) failed:', err);
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Import pipeline
  //
  // Steps: dedup → prefilter → save pending → AI classify → save final state
  //
  // Reads tasks via tasksRef (always current) to avoid stale closure capture
  // when multiple messages are imported in the same batch.
  // Each step that fails leaves the item in a visible, recoverable state.
  // ---------------------------------------------------------------------------

  const importMessage = useCallback(
    async (input: ImportMessageInput): Promise<ImportResult> => {
      // Execution probe — appears in browser DevTools console (NOT in the Tauri terminal).
      // Open DevTools in the Tauri app: right-click inside the app → Inspect.
      console.log(`[import] ▶ "${input.title?.slice(0, 70)}" source=${input.source} forceCreate=${!!input.forceCreate} customers=${customers.length}`);
      console.log(`[import-html] emailBodyHtml present=${!!input.emailBodyHtml} length=${input.emailBodyHtml?.length ?? 0}`);

      const dedupeKey = input.externalMessageId?.trim();


      // --- Per-message trace logs for ADO/PR emails ---
      if (input.adoContext) {
        const msgId = input.externalMessageId || '';
        const subj = input.title || '';
        const prUrl = input.adoContext.prUrl;
        console.log(`[ado-link] messageId=${msgId} subject="${subj}"`);
        if (prUrl) console.log(`[ado-link] selected prUrl=${prUrl}`);
      }

      // --- Force-create path: user explicitly requested task creation ----------
      // Skips prefilter and AI. Upgrades an existing rejected/analyzed record
      // in-place, or creates a new task directly at confidence 80.
      if (input.forceCreate) {
        if (dedupeKey) {
          const existing = tasksRef.current.find(
            (t) => t.source === input.source && t.externalMessageId === dedupeKey,
          );
          if (existing?.classificationState === 'created') {
            console.log(`[import] force-create: already a task "${input.title}"`);
            // Still backfill emailBodyHtml if the existing task is missing it.
            if (input.source === 'email' && input.emailBodyHtml && !existing.emailBodyHtml) {
              console.log(`[import-html] force-create duplicate: backfilling emailBodyHtml length=${input.emailBodyHtml.length}`);
              const patched = tasksRef.current.map((t) =>
                t.id === existing.id ? { ...t, emailBodyHtml: input.emailBodyHtml } : t
              );
              tasksRef.current = patched;
              setTasks(patched);
              api.saveTasks(patched).catch((e) => console.warn('[import] save force-create html backfill failed:', e));
            }
            return { outcome: 'duplicate', reason: 'Already a task', existingState: 'created', taskId: existing.id };
          }
          if (existing) {
            // Upgrade rejected/analyzed → created; also carry emailBodyHtml forward.
            console.log(`[import] force-create: upgrading ${existing.classificationState} → created "${input.title}"`);
            const htmlPatch = (input.source === 'email' && input.emailBodyHtml && !existing.emailBodyHtml)
              ? { emailBodyHtml: input.emailBodyHtml }
              : {};
            if (Object.keys(htmlPatch).length > 0) console.log(`[import-html] force-create upgrade: adding emailBodyHtml length=${input.emailBodyHtml?.length}`);
            const upgraded = tasksRef.current.map((t) =>
              t.id === existing.id
                ? { ...t, ...htmlPatch, classificationState: 'created' as const, confidence: Math.max(t.confidence, 80) }
                : t,
            );
            tasksRef.current = upgraded;
            setTasks(upgraded);
            api.saveTasks(upgraded).catch((e) => console.warn('[import] save force-upgrade failed:', e));
            return { outcome: 'created', taskId: existing.id };
          }
        }
        // No existing record — create directly without AI
        const cleanContent = input.content.includes('<') ? stripHtmlTags(input.content) : normalizeText(input.content);
        const cleanTitle   = normalizeTitle(input.title);
        const matchedCustomer = input.preResolvedCustomerId
          ? customers.find((c) => c.id === input.preResolvedCustomerId) ?? null
          : matchCustomer(customers.filter((c) => c.id !== OTHER_CUSTOMER_ID), { senderEmail: input.senderEmail, senderName: input.senderName, title: cleanTitle, content: cleanContent });
        const forcedId   = generateId();
        const forcedTask: Task = {
          id:                      forcedId,
          title:                   cleanTitle,
          source:                  input.source,
          customerId:              matchedCustomer?.id ?? OTHER_CUSTOMER_ID,
          taskType:                'other',
          status:                  'new',
          confidence:              80,
          originalMessage:         cleanContent,
          receivedAt:              input.receivedAt,
          suggestedActions:        [],
          externalMessageId:       dedupeKey,
          sourceThreadId:          input.sourceThreadId,
          sourceUrl:               input.sourceUrl,
          senderName:              input.senderName,
          senderEmail:             input.senderEmail,
          importedAt:              new Date().toISOString(),
          classificationLabel:     detectClassificationLabel(cleanTitle, cleanContent, input.senderEmail),
          classificationState:     'created',
          adoContext:              input.adoContext,
          suggestedPlanningBucket: input.heuristicBucket,
          priorityScore:           input.heuristicPriority,
          priorityReason:          input.heuristicReason,
          emailBodyHtml:           input.emailBodyHtml,
        };
        console.log(`[import] force-create: new task "${cleanTitle}"`);
        const withForced = [...tasksRef.current, forcedTask];
        tasksRef.current = withForced;
        setTasks(withForced);
        api.saveTasks(withForced).catch((e) => console.warn('[import] save force-create failed:', e));
        return { outcome: 'created', taskId: forcedId };
      }

      // --------------------------------------------------------------------------
      // 1. Deduplication — normal auto-import path
      // Only deduplicate when externalMessageId is a non-empty stable key.
      // Include source in the check so an email and a Teams message with the
      // same API-assigned ID cannot shadow each other.
      //
      // Once an item is stored with any classificationState, it is never
      // re-processed on repeat refreshes. This prevents duplicate tasks and
      // repeated AI calls for the same source message.
      if (dedupeKey) {
        const existing = tasksRef.current.find(
          (t) => t.source === input.source && t.externalMessageId === dedupeKey,
        );
        if (existing) {
          // --- Per-message trace logs for dedupe path ---
          console.log(`[ado-link] duplicate existingTaskId=${existing.id}`);
          console.log(`[import-html] dedupe: existing.emailBodyHtml present=${!!existing.emailBodyHtml} incoming present=${!!input.emailBodyHtml}`);

          // Collect all fields that need backfilling into a single update.
          // This avoids multiple setState/saveTasks calls for the same task.
          const backfill: Partial<Task> = {};

          // Backfill emailBodyHtml for email tasks — the primary fix for the
          // "already imported before HTML patch" scenario.
          if (input.source === 'email' && input.emailBodyHtml && !existing.emailBodyHtml) {
            backfill.emailBodyHtml = input.emailBodyHtml;
            console.log(`[import-html] dedupe: backfilling emailBodyHtml (length=${input.emailBodyHtml.length})`);
          }

          // Backfill adoContext when new data has URLs that existing record is missing.
          const existingPrUrl = existing.adoContext?.prUrl;
          const newPrUrl = input.adoContext?.prUrl;
          if (input.adoContext &&
              ((newPrUrl && !existingPrUrl) ||
               (input.adoContext.workItemUrl && !existing.adoContext?.workItemUrl))) {
            backfill.adoContext = { ...existing.adoContext, ...input.adoContext };
            if (!existingPrUrl && newPrUrl) console.log('[ado-link] existing prUrl missing -> backfilling');
            if (!existing.adoContext?.workItemUrl && input.adoContext?.workItemUrl) console.log('[ado-link] existing workItemUrl missing -> backfilling');
          } else {
            if (!existingPrUrl) console.log('[ado-link] existing prUrl missing but no new prUrl found');
            else console.log('[ado-link] existing prUrl already present -> no update');
          }

          if (Object.keys(backfill).length > 0) {
            const upgraded = tasksRef.current.map((t) =>
              t.id === existing.id ? { ...t, ...backfill } : t
            );
            tasksRef.current = upgraded;
            setTasks(upgraded);
            api.saveTasks(upgraded).catch((e) => console.warn('[import] dedupe backfill save failed:', e));
            console.log(`[import-html] dedupe: saved backfill for taskId=${existing.id}`);
          }

          return { outcome: 'duplicate', reason: 'Already imported', existingState: existing.classificationState, taskId: existing.id };
        }
      }

      const cleanContent = input.content.includes('<') ? stripHtmlTags(input.content) : normalizeText(input.content);

      // Also normalize the title
      const cleanTitle = normalizeTitle(input.title);

      // Derive a hint label early — used for both prefilter-rejected and AI-classified items.
      const classificationLabel = detectClassificationLabel(cleanTitle, cleanContent, input.senderEmail);

      // 2. Rule-based prefilter — reject obvious noise before calling AI.
      // For explicit captures: conservative mode — only hard-known zero-actionability
      // items (calendar responses, OOO) are rejected; everything else passes.
      const filterResult = prefilter({
        title:       cleanTitle,
        content:     cleanContent,
        senderEmail: input.senderEmail,
        captureMode: input.captureMode,
      });

      if (!filterResult.pass) {
        console.log(`[import] prefilter rejected "${input.title}": ${filterResult.reason}`);
        const rejectedId   = generateId();
        const rejectedTask: Task = {
          id:                  rejectedId,
          title:               cleanTitle,
          source:              input.source,
          customerId:          '',
          taskType:            'other',
          status:              'new',
          confidence:          0,
          originalMessage:     cleanContent,
          receivedAt:          input.receivedAt,
          suggestedActions:    [],
          externalMessageId:   dedupeKey,
          sourceThreadId:      input.sourceThreadId,
          sourceUrl:           input.sourceUrl,
          senderName:          input.senderName,
          senderEmail:         input.senderEmail,
          importedAt:          new Date().toISOString(),
          classificationLabel: classificationLabel ?? filterResult.reason,
          classificationState: 'rejected',
          // Keep heuristic planning even for rejected items (avoids data loss if user re-promotes)
          suggestedPlanningBucket: input.heuristicBucket,
          priorityScore:           input.heuristicPriority,
          priorityReason:          input.heuristicReason,
          emailBodyHtml:           input.emailBodyHtml,
        };
        // Read from ref so a concurrent import's pending task is not lost
        const next = [...tasksRef.current, rejectedTask];
        setTasks(next);
        api.saveTasks(next).catch((e) => console.warn('[import] save rejected failed:', e));
        return { outcome: 'rejected', reason: filterResult.reason, taskId: rejectedId };
      }

        // 3. Deterministic customer matching before AI
      // a. Use pre-resolved customer ID (e.g. from ADO parser) when provided
      // b. Otherwise run the heuristic matchCustomer algorithm
      const matchedCustomer = input.preResolvedCustomerId
        ? customers.find((c) => c.id === input.preResolvedCustomerId) ?? null
        : matchCustomer(customers.filter((c) => c.id !== OTHER_CUSTOMER_ID), {
            senderEmail: input.senderEmail,
            senderName:  input.senderName,
            title:       cleanTitle,
            content:     cleanContent,
          });
      console.log(
        `[import] pre-AI customer: ${matchedCustomer?.name ?? 'none'}`,
        `(${customers.length} customers loaded) title="${cleanTitle.slice(0, 60)}"`,
      );

      // 4. Persist as 'pending' immediately so the item survives app crashes or AI failures.
      // 'pending' is an internal transient state — InboxPage filters it out, so
      // the item is intentionally invisible until classification completes.
      const pendingId   = generateId();
      const pendingTask: Task = {
        id:                  pendingId,
        title:               cleanTitle,
        source:              input.source,
        customerId:          matchedCustomer?.id ?? OTHER_CUSTOMER_ID,
        taskType:            'other',
        status:              'new',
        confidence:          0,
        originalMessage:     cleanContent,
        receivedAt:          input.receivedAt,
        suggestedActions:    [],
        externalMessageId:   dedupeKey,
        sourceThreadId:      input.sourceThreadId,
        sourceUrl:           input.sourceUrl,
        senderName:          input.senderName,
        senderEmail:         input.senderEmail,
        importedAt:          new Date().toISOString(),
        classificationLabel,
        classificationState: 'pending',
        adoContext:          input.adoContext,
        // Heuristic planning defaults — AI will override these when available
        suggestedPlanningBucket: input.heuristicBucket,
        priorityScore:           input.heuristicPriority,
        priorityReason:          input.heuristicReason,
        // HTML display path — not used by AI/prefilter (stays plain text via originalMessage).
        emailBodyHtml:           input.emailBodyHtml,
      };

      console.log(`[import] pending "${input.title}" (${input.source})`);
      console.log(`[import-html] pending: emailBodyHtml stored=${!!pendingTask.emailBodyHtml} length=${pendingTask.emailBodyHtml?.length ?? 0}`);
      const withPending = [...tasksRef.current, pendingTask];
      // *** Critical: update ref synchronously before any awaits ***
      // Concurrent imports (Promise.all) all read tasksRef.current. Without this
      // synchronous mutation, they each see the same pre-import snapshot and
      // their setTasks calls overwrite each other — only the last pending task
      // survives into state. All earlier classified tasks then fail the map lookup
      // and are silently discarded. Updating the ref here makes each concurrent
      // import see all previously registered pending tasks.
      tasksRef.current = withPending;
      setTasks(withPending);
      api.saveTasks(withPending).catch((e) => console.warn('[import] save pending failed:', e));

      // 5. AI classification
      // On any failure: update the item to 'analyzed' so it becomes visible in
      // the inbox. The error is stored in analysisResult.summary so the user
      // sees a clear explanation and can decide what to do with it.
      let classification;
      try {
        classification = await api.classifyInboxItem(pendingTask);
        console.log(
          `[import] classified "${input.title}": isTask=${classification.isTask} confidence=${classification.confidence}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[import] AI classification failed for "${input.title}":`, errMsg);

        // When AI call fails, fall back to heuristic priority.
        // Explicit-capture: always surface in inbox — AI failure never silently rejects.
        // Auto-import: heuristic confidence gates the outcome as before.
        const fallbackConfidence = input.heuristicPriority ?? 30;
        const fallbackState: ClassificationState =
          input.captureMode === 'explicit'
            ? (fallbackConfidence >= IMPORT_CONFIG.CONFIDENCE_AUTO_CREATE ? 'created' : 'analyzed')
            : fallbackConfidence >= IMPORT_CONFIG.CONFIDENCE_AUTO_CREATE ? 'created'
            : fallbackConfidence >= IMPORT_CONFIG.MIN_CONFIDENCE_ANALYZE  ? 'analyzed' : 'rejected';

        const fallbackSummary = errMsg.includes('API key not configured')
          ? 'No OpenAI API key configured — review manually or add key in Settings.'
          : `AI unavailable — classified by heuristic (${errMsg.slice(0, 120)})`;

        console.warn(`[import] AI fallback for "${input.title}": heuristic=${fallbackConfidence} → ${fallbackState}`);

        // On AI failure: mark with fallback state so the item surfaces in the inbox.
        // Preserve any heuristic planning values set in the pending task.
        const afterError = tasksRef.current.map((t) =>
          t.id === pendingId
            ? {
                ...t,
                confidence:          fallbackConfidence,
                classificationState: fallbackState,
                analysisResult: {
                  summary:          fallbackSummary,
                  suggestedActions: [],
                  confidence:       fallbackConfidence,
                },
              }
            : t,
        );
        setTasks(afterError);
        api.saveTasks(afterError).catch((e) => console.warn('[import] save after AI error failed:', e));
        return {
          outcome: fallbackState === 'created' ? 'created' : fallbackState === 'analyzed' ? 'analyzed' : 'rejected',
          reason: `AI unavailable: ${errMsg}`,
          taskId: pendingId,
        };
      }

      // 6. Apply classification result
      //
      // Auto-import (captureMode unset):
      //   isTask=false               → reject
      //   isTask=true, conf < REVIEW → reject
      //   isTask=true, conf >= AUTO  → created
      //   isTask=true, conf >= REVIEW → analyzed
      //
      // Explicit-capture (captureMode === 'explicit'):
      //   AI enriches only — never rejects.
      //   conf >= AUTO → created; otherwise → analyzed
      const { isTask, confidence, title, summary, summaryCz, summaryEn, problemPointsCz, problemPointsEn, actionPointsCz, actionPointsEn, nextStepCz, nextStepEn, customerName, taskType, estimatedEffort, dueAt } =
        classification;

      if ((!isTask || confidence < IMPORT_CONFIG.MIN_CONFIDENCE_ANALYZE) && input.captureMode !== 'explicit') {
        const skipReason = !isTask
          ? `AI: isTask=false (conf=${confidence})`
          : `AI: low confidence (conf=${confidence})`;
        console.log(`[import] skip "${input.title}": ${skipReason}`);
        const withRejected = tasksRef.current.map((t) =>
          t.id === pendingId
            ? { ...t, classificationState: 'rejected' as const, confidence }
            : t,
        );
        setTasks(withRejected);
        api.saveTasks(withRejected).catch((e) => console.warn('[import] save rejected failed:', e));
        return { outcome: 'rejected', reason: skipReason, taskId: pendingId };
      }
      if (input.captureMode === 'explicit' && (!isTask || confidence < IMPORT_CONFIG.MIN_CONFIDENCE_ANALYZE)) {
        console.log(`[import] explicit-capture override "${input.title}": AI weak (isTask=${isTask} conf=${confidence}) → surfaces as analyzed`);
      }

      // Refine customer match using AI-derived name if deterministic match failed.
      // Exclude the Other sentinel from matching — it must only be used as a fallback.
      const finalCustomer = matchedCustomer ?? matchCustomer(customers.filter((c) => c.id !== OTHER_CUSTOMER_ID), {
        senderEmail:    input.senderEmail,
        senderName:     input.senderName,
        title:          input.title,
        content:        cleanContent,
        aiCustomerName: customerName ?? undefined,
      });
      const finalCustomerId = finalCustomer?.id ?? OTHER_CUSTOMER_ID;
      if (!matchedCustomer && finalCustomer) {
        console.log(`[import] post-AI customer: ${finalCustomer.name} (via AI name "${customerName}")`);
      } else if (!finalCustomer) {
        console.log(`[import] customer UNRESOLVED — AI name was "${customerName ?? 'null'}", ${customers.length} customers loaded`);
      }

      const resolvedTaskType: TaskType = VALID_TASK_TYPES.has(taskType)
        ? (taskType as TaskType)
        : 'other';

      // Fields set by AI — applied to both 'created' and 'analyzed' outcomes.
      // AI planning bucket overwrites the heuristic bucket only when AI sets a meaningful one.
      //
      // Title policy: for ADO PR comment items the deterministic title ("PR comment: ...") is
      // always preferred. OpenAI's freely-generated title is used only for generic emails, where
      // it adds real value by extracting a clean action-oriented summary from messy bodies.
      const isPrComment = input.adoContext?.type === 'pr-comment';
      const isEmail     = input.source === 'email';
      const isTeams     = input.source === 'teams';
      // Title policy:
      //   ADO PR comment  → deterministic subject always wins
      //   Generic email   → deterministic subject always wins
      //   Teams           → prefer deterministic Czech title; allow AI title only when it looks Czech
      //   Other           → AI-generated title preferred, input title as fallback
      const aiTitleHasCzech = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(title ?? '');
      const deterministicIsNaceneni = /^Nacen[ěe]n[íi]:/i.test(input.title ?? '');
      const resolvedTitle =
        (isPrComment || isEmail)
          ? input.title
          : isTeams
            // Keep deterministic Czech title when: it has a "Nacenění:" prefix, or AI title looks English
            ? (deterministicIsNaceneni || !aiTitleHasCzech ? input.title : title || input.title)
            : title || input.title;
      console.log(
        `[title-route] finalTitle="${resolvedTitle?.slice(0, 70)}"`,
        `source=${isPrComment ? 'deterministic_pr' : isEmail ? 'email_subject' : 'ai'}`,
        `customer=${finalCustomer?.name ?? 'Other'}`,
      );
      const aiFields: Partial<Task> = {
        title:                  resolvedTitle,
        customerId:             finalCustomerId,
        taskType:               resolvedTaskType,
        confidence,
        dueAt:                  dueAt ?? undefined,
        estimatedEffort:        estimatedEffort ?? undefined,
        analysisResult:         {
          summary,
          summaryCz:        summaryCz   ?? undefined,
          summaryEn:        summaryEn   ?? undefined,
          problemPointsCz:  problemPointsCz ?? undefined,
          problemPointsEn:  problemPointsEn ?? undefined,
          actionPointsCz:   actionPointsCz  ?? undefined,
          actionPointsEn:   actionPointsEn  ?? undefined,
          nextStepCz:       nextStepCz  ?? undefined,
          nextStepEn:       nextStepEn  ?? undefined,
          suggestedActions: [],
          confidence,
        },
        // Preserve heuristic planning when AI doesn't set a bucket (AI doesn't return bucket yet)
        suggestedPlanningBucket: input.heuristicBucket,
        priorityScore:           input.heuristicPriority,
        priorityReason:          input.heuristicReason,
      };

      if (confidence >= IMPORT_CONFIG.CONFIDENCE_AUTO_CREATE) {
        console.log(
          `[import] → created task "${aiFields.title}" (isTask=${isTask} conf=${confidence})`,
        );
        const withCreated = tasksRef.current.map((t) =>
          t.id === pendingId
            ? { ...t, ...aiFields, classificationState: 'created' as const }
            : t,
        );
        setTasks(withCreated);
        api.saveTasks(withCreated).catch((e) => console.warn('[import] save created failed:', e));
        // Non-blocking: generate a reply draft for explicit captures.
        if (input.captureMode === 'explicit') {
          api.generateReply(
            { id: pendingId, title: resolvedTitle ?? pendingTask.title, taskType: resolvedTaskType, status: 'new', originalMessage: pendingTask.originalMessage } as Task,
            finalCustomer,
          ).then((replyDraft) => {
            const withReply = tasksRef.current.map((t) => t.id === pendingId ? { ...t, generatedReply: replyDraft } : t);
            setTasks(withReply);
            api.saveTasks(withReply).catch(() => {});
            console.log('[import] reply draft generated for', pendingId);
          }).catch((e) => console.warn('[import] reply draft failed (non-blocking):', e));
        }
        return { outcome: 'created', taskId: pendingId };
      }

      // Medium confidence — leave in inbox for user review
      console.log(
        `[import] analyzed "${aiFields.title}" (confidence: ${confidence}) — needs review`,
      );
      const withAnalyzed = tasksRef.current.map((t) =>
        t.id === pendingId
          ? { ...t, ...aiFields, classificationState: 'analyzed' as const }
          : t,
      );
      setTasks(withAnalyzed);
      api.saveTasks(withAnalyzed).catch((e) => console.warn('[import] save analyzed failed:', e));
      // Non-blocking: generate a reply draft for explicit captures.
      if (input.captureMode === 'explicit') {
        api.generateReply(
          { id: pendingId, title: resolvedTitle ?? pendingTask.title, taskType: resolvedTaskType, status: 'new', originalMessage: pendingTask.originalMessage } as Task,
          finalCustomer,
        ).then((replyDraft) => {
          const withReply = tasksRef.current.map((t) => t.id === pendingId ? { ...t, generatedReply: replyDraft } : t);
          setTasks(withReply);
          api.saveTasks(withReply).catch(() => {});
          console.log('[import] reply draft generated for', pendingId);
        }).catch((e) => console.warn('[import] reply draft failed (non-blocking):', e));
      }
      return { outcome: 'analyzed', taskId: pendingId };
    },
    [customers], // reads tasks via tasksRef — no stale capture on concurrent imports
  );

  // --- Customer operations ---

  const createCustomer = useCallback(
    async (draft: Omit<Customer, 'id'>) => {
      const newCustomer: Customer = { ...draft, id: generateId() };
      const updated = [...customers, newCustomer];
      setCustomers(updated);
      try {
        await api.saveCustomers(updated);
      } catch (err) {
        console.warn('saveCustomers failed:', err);
      }
    },
    [customers],
  );

  const updateCustomer = useCallback(
    async (id: string, updates: Partial<Customer>) => {
      const updated = customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
      setCustomers(updated);
      try {
        await api.saveCustomers(updated);
      } catch (err) {
        console.warn('saveCustomers failed:', err);
      }
    },
    [customers],
  );

  const deleteCustomer = useCallback(
    async (id: string) => {
      const updated = customers.filter((c) => c.id !== id);
      setCustomers(updated);
      try {
        await api.saveCustomers(updated);
      } catch (err) {
        console.warn('saveCustomers (delete) failed:', err);
      }
    },
    [customers],
  );

  // --- Customer folder resolution ---

  /**
   * Finds an existing customer whose folderName matches the given folder name,
   * or creates a minimal Customer record so downstream actions (open folder,
   * open in VS Code) can resolve the path via crmBaseDirectory + folderName.
   * Returns the customer ID.
   */
  const resolveOrCreateCustomerByFolder = useCallback(
    async (folderName: string): Promise<string> => {
      // 1. Match existing customer by folderName (exact) or by name containing the folder
      const existing = customers.find(
        (c) =>
          c.folderName?.toLowerCase() === folderName.toLowerCase() ||
          c.name.toLowerCase() === folderName.toLowerCase(),
      );
      if (existing) return existing.id;

      // 2. Create a minimal customer record for this folder
      const newId = generateId();
      const newCustomer: Customer = {
        id:         newId,
        name:       folderName,
        shortCode:  folderName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10),
        folderName: folderName,
      };
      const updated = [...customers, newCustomer];
      setCustomers(updated);
      api.saveCustomers(updated).catch((e) => console.warn('saveCustomers (resolveOrCreate) failed:', e));
      return newId;
    },
    [customers],
  );

  // --- Settings operations ---

  const updateSettings = useCallback(
    async (updates: Partial<AppSettings>) => {
      const next = { ...settings, ...updates };
      setSettings(next);
      try {
        await api.saveSettings(next);
        const persisted = await api.loadSettings();
        setSettings(persisted);
        if ('crmBaseDirectory' in updates) {
          const baseDir = persisted.crmBaseDirectory ?? '';
          const folders = baseDir ? await api.listCrmFolders(baseDir).catch(() => []) : [];
          setCrmFolders(folders);
        }
      } catch (err) {
        console.warn('saveSettings failed:', err);
        throw err;
      }
    },
    [settings],
  );

  // --- Week log ---

  const updateWeeklyNote = useCallback(
    async (date: string, note: string) => {
      const notes = { ...(settings.weeklyNotes ?? {}), [date]: note };
      // Remove empty notes to keep storage clean
      if (!note.trim()) delete notes[date];
      await updateSettings({ weeklyNotes: notes });
    },
    [settings, updateSettings],
  );

  // --- Repository rescan ---

  const rescanRepositories = useCallback(
    async () => {
      try {
        const baseDir = settings.crmBaseDirectory ?? '';
        // 1. Discover new workspace folders and upsert them as customer records.
        let current = customers;
        if (baseDir) {
          const folders = await api.listCrmFolders(baseDir).catch(() => [] as string[]);
          setCrmFolders(folders);
          const { merged, changed } = mergeDiscoveredFolders(current, folders);
          if (changed) current = merged;
        }
        // 2. Refresh repository status for all customers.
        const rescanned = await api.rescanRepositories(current, baseDir);
        setCustomers(rescanned);
        await api.saveCustomers(rescanned);
      } catch (err) {
        console.warn('rescanRepositories failed:', err);
      }
    },
    [customers, settings.crmBaseDirectory],
  );

  // --- Repository creation from template ---

  const createRepositoryFromTemplate = useCallback(
    async (customer: Customer, options?: CreateRepoOptions): Promise<CreateRepoResult> => {
      const templatePath = settings.repositoryTemplatePath;
      const templateType = settings.repositoryTemplateType ?? 'none';
      const baseDir      = settings.crmBaseDirectory ?? '';

      if (!templatePath || templateType === 'none') {
        throw new Error('No repository template configured. Set one in Settings → Repository Workspace.');
      }
      if (!baseDir) {
        throw new Error('CRM base directory is not configured. Set it in Settings → Repository Workspace.');
      }
      const folderName = customer.folderName || customer.repositoryName;
      if (!folderName) {
        throw new Error('Customer has no folder name configured.');
      }

      const targetPath = `${baseDir}/${folderName}`;

      await api.createRepositoryFromTemplate(templatePath, targetPath);

      let gitInit: CreateRepoResult['gitInit'] = 'skipped';
      let gitMessage: string | undefined;
      let initialCommitCreated = false;

      const doGit    = options?.initializeGit    ?? (settings.initializeGitOnCreate ?? true);
      const branch   = options?.gitBranch?.trim()  || settings.defaultGitBranch?.trim() || 'main';
      const doCommit = options?.createInitialCommit ?? (settings.createInitialCommit ?? false);

      if (doGit) {
        const result = await api.initializeGitRepository(targetPath, branch, doCommit);
        gitInit              = result.status;
        gitMessage           = result.message || undefined;
        initialCommitCreated = result.initialCommitCreated;
      }

      const rescanned = await api.rescanRepositories(customers, baseDir);
      setCustomers(rescanned);
      await api.saveCustomers(rescanned);

      return { targetPath, gitInit, gitMessage, initialCommitCreated };
    },
    [customers, settings],
  );

  // --- Convenience ---

  const getCustomerById = useCallback(
    (id: string) => {
      // Treat empty string as equivalent to __other__ for backward compat
      // with tasks imported before the Other sentinel existed.
      if (!id || id === OTHER_CUSTOMER_ID) return OTHER_CUSTOMER;
      return customers.find((c) => c.id === id);
    },
    [customers],
  );

  // --- Render ---

  return (
    <AppContext.Provider
      value={{
        tasks,
        customers,
        settings,
        crmFolders,
        isLoading,
        error,
        createTask,
        updateTask,
        deleteTask,
        reloadTasks: async () => {
          const updated = await api.loadTasks();
          setTasks(updated);
        },
        importMessage,
        createCustomer,
        updateCustomer,
        deleteCustomer,
        resolveOrCreateCustomerByFolder,
        rescanRepositories,
        createRepositoryFromTemplate,
        updateSettings,
        updateWeeklyNote,
        getCustomerById,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
