/**
 * Script Assistant — deterministic analysis, file resolution, inspection,
 * and skeleton generation for Power Apps / Dataverse model-driven app JS.
 *
 * All logic runs on the frontend. No AI API required.
 *
 * V1 design principles:
 * - Entity resolution is deterministic, not fuzzy
 * - File resolution priority: canonical → activity shared → content match
 * - Skeleton output follows team JS conventions (see CODING CONVENTIONS below)
 * - Plan is always concrete — never vague
 *
 * CODING CONVENTIONS (reflected in generated skeletons):
 * - Event handlers receive executionContext; extract formContext at function top
 * - Helpers receive formContext directly (not executionContext)
 * - const for immutable top-of-function values; let only when value changes
 * - No early returns unless absolutely necessary
 * - Event handlers are thin (orchestration only); logic lives in helpers
 * - Common naming prefixes: manage, set, update, validate, lockOrUnlock, hideOrShow, fill
 */

import type {
  Task,
  Customer,
  ScriptAnalysis,
  ScriptFileInspection,
  ScriptPlan,
  ScriptSkeleton,
  SkeletonSection,
  ScriptTriggerType,
  ScriptOperationType,
  ScriptPreview,
} from '../types';

// ---------------------------------------------------------------------------
// Activity entity family
// ---------------------------------------------------------------------------

/** Entities that may share a single activity JS file instead of per-entity files. */
const ACTIVITY_ENTITIES = new Set([
  'nvr_interaction',
  'nvr_generalactivity',
  'nvr_activity',
  'appointment',
  'email',
  'phonecall',
  'task',
  'fax',
  'letter',
  'recurringappointmentmaster',
  'activitypointer',
  'activityparty',
]);

/** Shared activity file names to try when entity is activity-related. */
const ACTIVITY_SHARED_FILES = [
  'nvr_activity_events.js',
  'activity_events.js',
  'nvr_activity.js',
];

// ---------------------------------------------------------------------------
// Standard Dataverse entities (for direct-name matching)
// ---------------------------------------------------------------------------

// Sorted longest-first once at module level (avoids repeated sort in extractEntityFromText).
const STANDARD_ENTITIES = [
  'account',
  'contact',
  'lead',
  'opportunity',
  'quote',
  'salesorder',
  'invoice',
  'incident',
  'systemuser',
  'team',
  'businessunit',
  'product',
  'pricelevel',
  'productpricelevel',
  'campaign',
  'campaignactivity',
  'list',
  'appointment',
  'email',
  'phonecall',
  'fax',
  'letter',
  'activitypointer',
  'connection',
  'connectionrole',
  'contract',
  'entitlement',
  'knowledgearticle',
  'msdyn_project',
  'msdyn_timeentry',
].sort((a, b) => b.length - a.length); // sort once at module load

// ---------------------------------------------------------------------------
// Czech / English keyword → entity mappings (longest first for greedy matching)
// ---------------------------------------------------------------------------

const ENTITY_KEYWORDS: [string, string][] = [
  ['obchodní příležitost', 'opportunity'],
  ['obecná aktivita',      'nvr_generalactivity'],
  ['obecna aktivita',      'nvr_generalactivity'],
  ['general activity',     'nvr_generalactivity'],
  ['příležitost',          'opportunity'],
  ['prilezitost',          'opportunity'],
  ['zákazník',             'account'],
  ['zakaznik',             'account'],
  ['případ',               'incident'],
  ['pripad',               'incident'],
  ['schůzka',              'appointment'],
  ['schuze',               'appointment'],
  ['objednávka',           'salesorder'],
  ['nabídka',              'quote'],
  ['faktura',              'invoice'],
  ['interakce',            'nvr_interaction'],
  ['kontakt',              'contact'],
  ['firma',                'account'],
  ['ucet',                 'account'],
  ['aktivita',             'nvr_generalactivity'],
  ['activity',             'nvr_generalactivity'],
  ['interaction',          'nvr_interaction'],
];

// ---------------------------------------------------------------------------
// nvr_-prefixed words that are fields, not entity logical names
// ---------------------------------------------------------------------------

/**
 * These nvr_* tokens appear in task text as field names or UI labels,
 * NOT as entity logical names. Exclude them from entity detection.
 */
const NVR_FIELD_EXCLUSIONS = new Set([
  'nvr_company',
  'nvr_name',
  'nvr_type',
  'nvr_status',
  'nvr_state',
  'nvr_date',
  'nvr_amount',
  'nvr_note',
  'nvr_description',
  'nvr_reference',
  'nvr_code',
  'nvr_value',
  'nvr_flag',
  'nvr_enabled',
  'nvr_active',
  'nvr_class',
  'nvr_group',
  'nvr_owner',
  'nvr_user',
  'nvr_email',
  'nvr_phone',
  'nvr_address',
  'nvr_city',
  'nvr_country',
  'nvr_zip',
  'nvr_region',
  'nvr_category',
  'nvr_priority',
  'nvr_order',
  'nvr_price',
  'nvr_quantity',
  'nvr_unit',
  'nvr_currency',
]);

// ---------------------------------------------------------------------------
// Trigger patterns
// ---------------------------------------------------------------------------

interface TriggerResult {
  triggerType: ScriptTriggerType;
  triggerField?: string;
}

/**
 * Ordered list of trigger detection patterns.
 * Format: [regex, triggerType, fieldCaptureGroup | null]
 *
 * Rules:
 * - Patterns are tried in order; first match wins
 * - fieldCaptureGroup: which regex group contains the field name (1-based), or null
 * - English and Czech patterns intermixed; more specific patterns first
 */
const TRIGGER_PATTERNS: [RegExp, ScriptTriggerType, number | null][] = [
  // onChange: explicit "onchange / on change" with nvr_ field before or after
  [/\bon[-\s]?change\s+(?:of\s+)?(?:field\s+)?(nvr_[a-z_][a-z0-9_]*)/i,  'onChange', 1],
  [/(nvr_[a-z_][a-z0-9_]*)\s+(?:field\s+)?on[-\s]?change/i,              'onChange', 1],
  // onChange: with plain field name before or after
  [/\bon[-\s]?change\s+(?:of\s+)?(?:field\s+)?([a-z_][a-z0-9_]{2,})/i,   'onChange', 1],
  [/([a-z_][a-z0-9_]{2,})\s+(?:field\s+)?on[-\s]?change/i,               'onChange', 1],
  // onChange: "company change" / "nvr_company change" — field + "change" without "on"
  [/(nvr_[a-z_][a-z0-9_]*)\s+change\b/i,                                  'onChange', 1],
  [/\bchange\s+(?:of\s+)?(nvr_[a-z_][a-z0-9_]*)\b/i,                     'onChange', 1],
  [/\b([a-z_][a-z0-9_]{2,})\s+change\b/i,                                 'onChange', 1],
  // Czech onChange with field
  [/změn[ěe]\s+(?:pole\s+)?(nvr_[a-z_][a-z0-9_]*)/i,                     'onChange', 1],
  [/(nvr_[a-z_][a-z0-9_]*)\s+změn[ěe]/i,                                  'onChange', 1],
  // Czech onChange generic
  [/při\s+změn[ěe]/i,                                                      'onChange', null],
  // Generic onChange (no field capture)
  [/\bon[-\s]?change\b/i,                                                  'onChange', null],
  // onLoad
  [/\bon[-\s]?load\b/i,                                                    'onLoad', null],
  [/při\s+načten[íi]/i,                                                    'onLoad', null],
  [/načten[íi]\s+formulář/i,                                               'onLoad', null],
  // onSave
  [/\bon[-\s]?save\b/i,                                                    'onSave', null],
  [/při\s+uložen[íi]/i,                                                    'onSave', null],
  // Validation implies onSave
  [/\bvalidat/i,                                                           'onSave', null],
  [/\bvalidac/i,                                                           'onSave', null],
  [/\bvalidov/i,                                                           'onSave', null],
  // Ribbon
  [/\bribbon\b/i,                                                          'ribbon', null],
  [/\btlačítko\b|\btlacitko\b/i,                                           'ribbon', null],
];

/** Field names / words that should NOT be captured as field names. */
const FIELD_EXCLUSION_WORDS = new Set([
  'load', 'save', 'change', 'submit', 'form', 'formulář', 'formulari',
  'account', 'contact', 'lead', 'opportunity', 'quote', 'incident',
  'entity', 'field', 'pole', 'trigger', 'event', 'handler', 'helper',
  'function', 'script', 'class', 'object', 'section', 'tab', 'panel',
  'validation', 'validace', 'visibility', 'visible', 'hidden',
]);

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract the most likely Dataverse entity logical name from task text.
 *
 * Priority order:
 * 1. Explicit nvr_<entity> tokens (excluding known field names)
 * 2. Standard entity names (word-boundary match, longest first)
 * 3. Czech / English keyword → entity mapping (longest keyword first)
 * 4. File name hints in the text (e.g. nvr_account_events.js)
 * 5. Default fallback: 'account'
 */
export function extractEntityFromText(text: string): string {
  const lower = text.toLowerCase();

  // Trigger/event words that must never form part of an entity logical name.
  // e.g. "nvr_solution_onchange" → entity is "nvr_solution", not "nvr_solution_onchange".
  const TRIGGER_SUFFIXES = /[_](onchange|onload|onsave|handler|events)$/i;

  // 1. nvr_ prefixed tokens — skip excluded field names; limit segment count
  for (const m of lower.matchAll(/\bnvr_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/g)) {
    // Strip trailing trigger/event suffix before treating as entity name.
    const bare = m[1].replace(TRIGGER_SUFFIXES, '');
    const full = `nvr_${bare}`;
    if (NVR_FIELD_EXCLUSIONS.has(full)) continue;
    const segmentCount = bare.split('_').length;
    if (segmentCount > 3) continue; // likely a compound field, not an entity
    return full;
  }

  // 2. Standard entity names — already sorted longest-first at module level
  for (const entity of STANDARD_ENTITIES) {
    if (new RegExp(`\\b${entity}\\b`, 'i').test(text)) {
      return entity;
    }
  }

  // 3. Czech / English keyword mapping (longest keyword first)
  for (const [keyword, entity] of ENTITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return entity;
    }
  }

  // 4. File name hints
  const fileMatch = lower.match(/\b(nvr_[a-z][a-z0-9_]*)_events\.js\b/);
  if (fileMatch) return fileMatch[1];
  const fileMatch2 = lower.match(/\b([a-z][a-z0-9]+)_events\.js\b/);
  if (fileMatch2) return fileMatch2[1];

  return 'account'; // final fallback
}

// ---------------------------------------------------------------------------
// Trigger extraction
// ---------------------------------------------------------------------------

export function extractTriggerFromText(text: string): TriggerResult {
  for (const [pattern, trigger, fieldGroup] of TRIGGER_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    let triggerField: string | undefined;
    if (fieldGroup !== null && match[fieldGroup]) {
      const candidate = match[fieldGroup].toLowerCase().trim();
      if (!FIELD_EXCLUSION_WORDS.has(candidate)) {
        triggerField = candidate;
      }
    }
    return { triggerType: trigger, triggerField };
  }

  // Heuristic fallback: visibility / section / tab words → onLoad
  if (/visib|section|tab|panel|viditel|sekc|skry|zob/i.test(text)) {
    return { triggerType: 'onLoad' };
  }

  return { triggerType: 'helper_only' };
}

// ---------------------------------------------------------------------------
// Candidate function name generation
// ---------------------------------------------------------------------------

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function toCamelCase(words: string[]): string {
  return words
    .filter(w => w.length > 0)
    .map((w, i) => {
      const clean = removeDiacritics(w).replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) return '';
      return i === 0
        ? clean.toLowerCase()
        : clean[0].toUpperCase() + clean.slice(1).toLowerCase();
    })
    .join('');
}

const FUNCTION_STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'for', 'of', 'and', 'or', 'to', 'at', 'by', 'if',
  'na', 'pro', 'při', 've', 'ze', 'do', 'se', 'je', 'ke', 'po', 'od', 'ze',
  'form', 'formuláři', 'formulář', 'formulár',
  'script', 'with', 'into', 'přidat', 'add',
  'funkci', 'funkce', 'skript',
]);

const HELPER_VERBS = new Set([
  'manage', 'set', 'update', 'validate', 'lock', 'unlock',
  'hide', 'show', 'fill', 'clear', 'refresh', 'load', 'save', 'check',
  'get', 'build', 'calculate', 'compute', 'initialize', 'reset',
]);

function extractMeaningfulWords(title: string, maxWords = 4): string[] {
  return title
    .split(/[\s\-_–,.:()]+/)
    .map(w => removeDiacritics(w).replace(/[^a-zA-Z0-9]/g, ''))
    .filter(w => w.length > 2 && !FUNCTION_STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords);
}

export function buildCandidateFunctionName(
  entity: string,
  triggerType: ScriptTriggerType,
  triggerField?: string,
  taskTitle?: string,
): string {
  const words = extractMeaningfulWords(taskTitle ?? '');
  const entityPart = entity.replace(/^nvr_/, '');
  const titleVerb = words.find(w => HELPER_VERBS.has(w.toLowerCase()));

  if (triggerField) {
    const fieldPart = triggerField.replace(/^nvr_/, '');
    const verb = titleVerb ?? 'manage';
    const extras = words.filter(w =>
      w.toLowerCase() !== verb.toLowerCase() &&
      w.toLowerCase() !== fieldPart.toLowerCase() &&
      w.toLowerCase() !== entityPart.toLowerCase()
    );
    if (extras.length > 0) {
      return toCamelCase([verb, fieldPart, ...extras.slice(0, 2)]);
    }
    return toCamelCase([verb, fieldPart]);
  }

  if (triggerType === 'onLoad') {
    if (words.length > 0) return toCamelCase(words);
    return toCamelCase(['initialize', entityPart]);
  }

  if (triggerType === 'onSave') {
    if (words.length > 0) return toCamelCase(words);
    return toCamelCase(['validate', entityPart]);
  }

  if (words.length > 0) return toCamelCase(words);
  return toCamelCase(['manage', entityPart]);
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

export function computeConfidence(
  entity: string,
  triggerType: ScriptTriggerType,
  triggerField?: string,
  taskText?: string,
): number {
  let score = 0.45;

  if (entity.startsWith('nvr_')) score += 0.20;
  else if (entity !== 'account') score += 0.12;
  else score += 0.06;

  if (triggerType !== 'helper_only') score += 0.15;
  if (triggerField) score += 0.12;
  if (taskText && /_events\.js/.test(taskText)) score += 0.08;
  if (taskText && /nvr_[a-z]/.test(taskText)) score += 0.04;

  return Math.min(0.95, score);
}

// ---------------------------------------------------------------------------
// Phase 1: Analyze
// ---------------------------------------------------------------------------

export function analyzeScriptTask(task: Task, customer: Customer | null): ScriptAnalysis {
  const text = `${task.title} ${task.originalMessage ?? ''}`;
  const entity = extractEntityFromText(text);
  const { triggerType, triggerField } = extractTriggerFromText(text);
  const candidateFunctionName = buildCandidateFunctionName(
    entity, triggerType, triggerField, task.title,
  );
  const confidence = computeConfidence(entity, triggerType, triggerField, text);

  let operationType: ScriptOperationType;
  if (triggerType === 'onChange' && triggerField) {
    operationType = 'new_onchange_handler';
  } else {
    operationType = 'helper_plus_hook';
  }

  const entityDisplay = entity.replace(/^nvr_/, '');
  const triggerDisplay = triggerField
    ? `${triggerType} / field: ${triggerField}`
    : triggerType;

  const summary =
    `Entity: ${entityDisplay}. Trigger: ${triggerDisplay}. ` +
    `Suggested function: ${candidateFunctionName}. ` +
    (customer ? `Customer: ${customer.name}. ` : '') +
    `Confidence: ${Math.round(confidence * 100)}%.`;

  return {
    artifactType: 'script',
    entityLogicalName: entity,
    triggerType,
    triggerField,
    operationType,
    candidateFunctionName,
    shouldReuseExistingHandler: false, // refined in Plan
    shouldCreateNewHandler: triggerType === 'onChange',
    shouldCreateHelper: true,
    confidence,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: File resolution
// ---------------------------------------------------------------------------

interface FileResolution {
  fileName: string;
  resolvedBy: ScriptPlan['resolvedBy'];
}

function canonicalFileNames(entity: string): string[] {
  const e = entity.toLowerCase().replace(/\s+/g, '_');
  // Strip existing nvr_ prefix before constructing nvr_-prefixed variants,
  // so nvr_account → nvr_account_events.js (not nvr_nvr_account_events.js).
  const bare = e.startsWith('nvr_') ? e.slice(4) : e;
  const candidates = [
    `nvr_${bare}_events.js`,
    `${e}_events.js`,
    `nvr_${bare}.js`,
    `${e}.js`,
  ];
  // Deduplicate while preserving priority order (e.g. when entity is already bare).
  return [...new Set(candidates)];
}

/**
 * Deterministic file resolution — pure function, no I/O.
 * Receives the list of .js file names already present in the script folder.
 *
 * Priority:
 * 1. Canonical entity filename (actual casing from directory)
 * 2. Activity shared file (only for activity-family entities)
 * 3. 'none' — returns the preferred scaffold target name
 */
export function resolveScriptFile(entity: string, jsFiles: string[]): FileResolution {
  const lower = entity.toLowerCase();
  const filesLower = jsFiles.map(f => f.toLowerCase());

  for (const candidate of canonicalFileNames(lower)) {

    const idx = filesLower.indexOf(candidate);
    if (idx !== -1) {
      return { fileName: jsFiles[idx], resolvedBy: 'canonical' };
    }
  }

  if (ACTIVITY_ENTITIES.has(lower)) {
    for (const shared of ACTIVITY_SHARED_FILES) {
      const idx = filesLower.indexOf(shared);
      if (idx !== -1) {
        return { fileName: jsFiles[idx], resolvedBy: 'activity_shared' };
      }
    }
  }

  const bareFallback = lower.startsWith('nvr_') ? lower.slice(4) : lower;
  return { fileName: `nvr_${bareFallback}_events.js`, resolvedBy: 'none' };
}

/**
 * Content-based fallback — scan file contents for entity-related patterns.
 * Only called when canonical + shared failed.
 */
export function resolveByContent(
  entity: string,
  jsFiles: string[],
  fileContents: Map<string, string>,
): FileResolution | null {
  const e = entity.toLowerCase();
  const patterns = [
    new RegExp(`var\\s+${e}_on(?:load|save|change)`, 'i'),
    new RegExp(`var\\s+${e}[._]`, 'i'),
    new RegExp(`["']${e}["']`, 'i'),
  ];

  for (const fileName of jsFiles) {
    const content = fileContents.get(fileName);
    if (!content) continue;
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { fileName, resolvedBy: 'content_match' };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 3: File inspection
// ---------------------------------------------------------------------------

/**
 * Inspect a JS file and extract structural information.
 *
 * Detects these function declaration patterns:
 * - var/let/const foo = [async] function(...)
 * - function foo(...)
 * - Namespace.foo = [async] function(...)
 */
export function inspectScriptFile(
  content: string,
  filePath: string,
  fileName: string,
): ScriptFileInspection {
  const allFunctions: string[] = [];

  for (const m of content.matchAll(/(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function/g)) {
    allFunctions.push(m[1]);
  }
  for (const m of content.matchAll(/^function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm)) {
    allFunctions.push(m[1]);
  }
  // Namespace pattern: Prefix.name = function or Prefix.name = async function
  for (const m of content.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$.]*\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function/g)) {
    allFunctions.push(m[1]);
  }

  // Deduplicate
  const seen = new Set<string>();
  const functions: string[] = [];
  for (const f of allFunctions) {
    if (!seen.has(f)) {
      seen.add(f);
      functions.push(f);
    }
  }

  const HANDLER_SUFFIX = /_(onLoad|onSave|onChange|onchange|onload|onsave|onLookupTagAdded|preSearch|postSearch|handler)$/i;
  const handlers = functions.filter(f => HANDLER_SUFFIX.test(f) || /Handler$/i.test(f));
  const helpers  = functions.filter(f => !HANDLER_SUFFIX.test(f) && !/Handler$/i.test(f));

  const hasOnLoad   = functions.some(f => /on[-_]?load/i.test(f));
  const hasOnSave   = functions.some(f => /on[-_]?save/i.test(f));
  const hasOnChange = functions.some(f => /on[-_]?change/i.test(f));

  const onChangeFields: string[] = [];
  for (const m of content.matchAll(/(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)_[Oo]n[Cc]hange/g)) {
    onChangeFields.push(m[1]);
  }

  return {
    filePath,
    fileName,
    exists: true,
    handlers,
    helpers,
    hasOnLoad,
    hasOnSave,
    hasOnChange,
    onChangeFields,
  };
}

/**
 * Find the best existing handler to hook into for a given trigger and field.
 * Returns undefined if no suitable handler is found.
 */
function findBestExistingHandler(
  inspection: ScriptFileInspection,
  triggerType: ScriptTriggerType,
  triggerField?: string,
): string | undefined {
  const { handlers } = inspection;

  if (triggerField) {
    const fieldLower = triggerField.toLowerCase().replace(/^nvr_/, '');
    const fieldSpecific = handlers.find(h =>
      h.toLowerCase().includes(fieldLower) && /on[-_]?change/i.test(h)
    );
    if (fieldSpecific) return fieldSpecific;
  }

  const triggerRe: Record<string, RegExp> = {
    onLoad:   /on[-_]?load/i,
    onSave:   /on[-_]?save/i,
    onChange: /on[-_]?change/i,
  };
  const re = triggerRe[triggerType];
  if (re) return handlers.find(h => re.test(h));

  return undefined;
}

// ---------------------------------------------------------------------------
// Phase 2+3: Build the full plan
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => i === 0 ? p.replace(/[/\\]+$/, '') : p.replace(/^[/\\]+/, ''))
    .join('/');
}

function determineOperationType(
  triggerType: ScriptTriggerType,
  fileExists: boolean,
  _inspection: ScriptFileInspection | undefined,
  existingHandlerName: string | undefined,
  triggerField?: string,
): ScriptOperationType {
  if (!fileExists) return 'new_file_scaffold';

  if (triggerType === 'onChange') {
    if (triggerField && existingHandlerName) {
      const fieldLower = triggerField.toLowerCase().replace(/^nvr_/, '');
      if (existingHandlerName.toLowerCase().includes(fieldLower)) {
        return 'extend_existing_helper';
      }
    }
    return existingHandlerName ? 'helper_plus_hook' : 'new_onchange_handler';
  }

  if (triggerType === 'onLoad' || triggerType === 'onSave') {
    return 'helper_plus_hook';
  }

  return 'extend_existing_helper';
}

function buildRecommendedAction(
  operationType: ScriptOperationType,
  entity: string,
  triggerType: ScriptTriggerType,
  triggerField: string | undefined,
  targetFileName: string,
  existingHandlerName: string | undefined,
  candidateFunctionName: string,
): string {
  const e = entity.replace(/^nvr_/, '');
  const f = triggerField ? ` on field ${triggerField}` : '';

  switch (operationType) {
    case 'new_file_scaffold':
      return `Create ${targetFileName} with a ${triggerType} scaffold for ${e}.`;
    case 'new_onchange_handler':
      return `Add new onChange handler for${f} and helper ${candidateFunctionName} to ${targetFileName}.`;
    case 'helper_plus_hook':
      return existingHandlerName
        ? `Add helper ${candidateFunctionName} to ${targetFileName} and call it from ${existingHandlerName}.`
        : `Add helper ${candidateFunctionName} to ${targetFileName} and hook into the ${triggerType} handler.`;
    case 'extend_existing_helper':
      return existingHandlerName
        ? `Extend ${existingHandlerName} in ${targetFileName} with new logic for ${e}${f}.`
        : `Add logic for ${e}${f} to ${targetFileName}.`;
    default:
      return `Update ${targetFileName} for ${e} ${triggerType}${f}.`;
  }
}

export async function buildScriptPlan(
  analysis: ScriptAnalysis,
  scriptFolder: string,
  getJsFiles: () => Promise<string[]>,
  getFileContent: (path: string) => Promise<string>,
): Promise<ScriptPlan> {
  const { entityLogicalName, triggerType, triggerField } = analysis;

  let jsFiles: string[] = [];
  try {
    jsFiles = await getJsFiles();
  } catch {
    // Folder may not exist yet
  }

  let resolution = resolveScriptFile(entityLogicalName, jsFiles);

  // Content-based fallback (limit to 12 files)
  if (resolution.resolvedBy === 'none' && jsFiles.length > 0) {
    const contentMap = new Map<string, string>();
    for (const f of jsFiles.slice(0, 12)) {
      try {
        contentMap.set(f, await getFileContent(joinPath(scriptFolder, f)));
      } catch {
        // skip unreadable files
      }
    }
    const contentMatch = resolveByContent(entityLogicalName, jsFiles, contentMap);
    if (contentMatch) resolution = contentMatch;
  }

  const targetFileName = resolution.fileName;
  const targetFile = joinPath(scriptFolder, targetFileName);
  const fileExists = resolution.resolvedBy !== 'none' &&
    jsFiles.some(f => f.toLowerCase() === targetFileName.toLowerCase());

  let inspection: ScriptFileInspection | undefined;
  let existingHandlerName: string | undefined;
  if (fileExists) {
    try {
      const content = await getFileContent(targetFile);
      inspection = inspectScriptFile(content, targetFile, targetFileName);
      existingHandlerName = findBestExistingHandler(inspection, triggerType, triggerField);
      // Attach existingHandlerName to inspection for convenience
      inspection = { ...inspection, existingHandlerName };
    } catch {
      // Could not read — leave uninspected
    }
  }

  const operationType = determineOperationType(
    triggerType, fileExists, inspection, existingHandlerName, triggerField,
  );

  const reuseExistingHandler  = !!existingHandlerName;
  const createNewHandler = operationType === 'new_onchange_handler' ||
    operationType === 'new_file_scaffold';
  const createNewHelper  = operationType !== 'extend_existing_helper';

  const candidateLower = analysis.candidateFunctionName.toLowerCase();
  const similarHelperFound = inspection?.helpers.some(h =>
    h.toLowerCase().startsWith(candidateLower.slice(0, Math.max(5, candidateLower.length - 3)))
  ) ?? false;

  const recommendedAction = buildRecommendedAction(
    operationType, entityLogicalName, triggerType, triggerField,
    targetFileName, existingHandlerName, analysis.candidateFunctionName,
  );

  return {
    targetFile,
    targetFileName,
    resolvedBy: resolution.resolvedBy,
    fileExists,
    entity: entityLogicalName,
    triggerType,
    triggerField,
    operationType,
    reuseExistingHandler,
    existingHandlerName,
    createNewHelper,
    createNewHandler,
    similarHelperFound,
    recommendedAction,
    inspection,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Skeleton generation
// ---------------------------------------------------------------------------

export function generateSkeleton(analysis: ScriptAnalysis, plan: ScriptPlan): ScriptSkeleton {
  switch (plan.operationType) {
    case 'new_file_scaffold':
      return skeletonNewFile(analysis, plan);
    case 'new_onchange_handler':
      return skeletonNewOnChange(analysis, plan);
    case 'helper_plus_hook':
      return skeletonHelperPlusHook(analysis, plan);
    case 'extend_existing_helper':
      return skeletonExtend(analysis, plan);
    default:
      return skeletonHelperPlusHook(analysis, plan);
  }
}

// Trigger type → conventional handler name suffix (PascalCase per team conventions)
const TRIGGER_HANDLER_SUFFIX: Record<string, string> = {
  onLoad:   'OnLoad',
  onSave:   'OnSave',
  onChange: 'OnChange',
  ribbon:   'Ribbon',
};

// helper_plus_hook
function skeletonHelperPlusHook(analysis: ScriptAnalysis, plan: ScriptPlan): ScriptSkeleton {
  const { triggerField, candidateFunctionName } = analysis;
  const triggerSuffix = TRIGGER_HANDLER_SUFFIX[analysis.triggerType] ?? analysis.triggerType;
  // Convention:
  //   OnLoad / OnSave: nvr_<entity>_OnLoad / nvr_<entity>_OnSave
  //   OnChange: nvr_<fieldName>_OnChange  (field-based, not entity-based)
  const defaultHandler = (analysis.triggerType === 'onChange' && triggerField)
    ? `${triggerField}_${triggerSuffix}`
    : `${plan.entity}_${triggerSuffix}`;
  const handler = plan.existingHandlerName ?? defaultHandler;

  const helperCode = triggerField
    ? `// Helper: ${candidateFunctionName}
// Called from ${handler} to react to changes in ${triggerField}.
var ${candidateFunctionName} = function (formContext) {
    const fieldValue = formContext.getAttribute("${triggerField}")?.getValue();

    // TODO: implement logic based on fieldValue
};`
    : `// Helper: ${candidateFunctionName}
var ${candidateFunctionName} = function (formContext) {
    // TODO: implement logic
};`;

  const patchCode =
`// Inside ${handler} — add at the top, extract formContext if not already done:
//   const formContext = executionContext.getFormContext();
// Then call:
${candidateFunctionName}(formContext);`;

  const sections: SkeletonSection[] = [
    {
      label: 'New helper function',
      description: `Add below ${handler} in ${plan.targetFileName}.`,
      code: helperCode,
    },
    {
      label: 'Handler patch',
      description: `Inside ${handler}: extract formContext (if not already there), then add this call.`,
      code: patchCode,
    },
  ];

  return { targetFile: plan.targetFile, targetFileName: plan.targetFileName, operationType: plan.operationType, sections };
}

// new_onchange_handler
function skeletonNewOnChange(analysis: ScriptAnalysis, plan: ScriptPlan): ScriptSkeleton {
  const { triggerField, candidateFunctionName } = analysis;
  const field   = triggerField ?? 'nvr_fieldname';
  // Convention: nvr_<fieldName>_OnChange — use the field itself as the prefix, not entity+field.
  const handlerName = `${field}_OnChange`;

  const handlerCode =
`// Handler: ${handlerName}
// Register in Power Apps form editor → Field: ${field} → Event: OnChange
var ${handlerName} = function (executionContext) {
    const formContext = executionContext.getFormContext();

    ${candidateFunctionName}(formContext);
};`;

  const helperCode =
`// Helper: ${candidateFunctionName}
// Called from ${handlerName}. Receives formContext directly.
var ${candidateFunctionName} = function (formContext) {
    const fieldValue = formContext.getAttribute("${field}")?.getValue();

    // TODO: implement logic based on fieldValue
};`;

  const registrationNote =
`// Power Apps form editor — registration:
//   Field:    ${field}
//   Event:    OnChange
//   Library:  [your JS web resource]
//   Function: ${handlerName}
//   Pass execution context: yes`;

  const sections: SkeletonSection[] = [
    {
      label: 'New onChange handler',
      description: `Add to ${plan.targetFileName}, then register in the form editor.`,
      code: handlerCode,
    },
    {
      label: 'Helper function',
      description: `Add below ${handlerName} in ${plan.targetFileName}.`,
      code: helperCode,
    },
    {
      label: 'Form editor registration',
      description: 'Register this handler in the Power Apps form editor.',
      code: registrationNote,
    },
  ];

  return { targetFile: plan.targetFile, targetFileName: plan.targetFileName, operationType: plan.operationType, sections };
}

// extend_existing_helper
function skeletonExtend(analysis: ScriptAnalysis, plan: ScriptPlan): ScriptSkeleton {
  const { entityLogicalName, triggerField, candidateFunctionName } = analysis;
  const handler = plan.existingHandlerName ?? `${entityLogicalName.toLowerCase()}_handler`;

  const snippetCode = triggerField
    ? `// Extend ${handler} — add this block inside (or extract as a helper):
const ${triggerField.replace(/^nvr_/, '')}Value = formContext.getAttribute("${triggerField}")?.getValue();

// TODO: implement new logic for ${triggerField}
// Optionally extract as: ${candidateFunctionName}(formContext);`
    : `// Extend ${handler} — add new logic or extract a helper:
// var ${candidateFunctionName} = function (formContext) { ... };`;

  const sections: SkeletonSection[] = [
    {
      label: 'Extension snippet',
      description: `Extend ${handler} in ${plan.targetFileName}.`,
      code: snippetCode,
    },
  ];

  return { targetFile: plan.targetFile, targetFileName: plan.targetFileName, operationType: plan.operationType, sections };
}

// new_file_scaffold
function skeletonNewFile(analysis: ScriptAnalysis, plan: ScriptPlan): ScriptSkeleton {
  const { entityLogicalName, triggerType, triggerField, candidateFunctionName } = analysis;
  // Entity prefix keeps its nvr_ prefix — convention: nvr_<entity>_OnLoad etc.
  const prefix = entityLogicalName.toLowerCase();
  const field  = triggerField ?? 'nvr_fieldname';
  // Convention: handler name is nvr_<fieldName>_OnChange for onChange events.
  // Do NOT combine entity + stripped field — that produces nvr_entity_field_onchange.

  let handlerCode: string;
  let handlerFnName: string;

  if (triggerType === 'onLoad') {
    handlerFnName = `${prefix}_OnLoad`;
    handlerCode =
`// Form onLoad — register in Power Apps form editor (pass execution context: yes)
var ${handlerFnName} = function (executionContext) {
    const formContext = executionContext.getFormContext();

    ${candidateFunctionName}(formContext);
};`;
  } else if (triggerType === 'onSave') {
    handlerFnName = `${prefix}_OnSave`;
    handlerCode =
`// Form onSave — register in Power Apps form editor (pass execution context: yes)
var ${handlerFnName} = function (executionContext) {
    const formContext = executionContext.getFormContext();

    ${candidateFunctionName}(formContext);
};`;
  } else if (triggerType === 'onChange') {
    // Convention: nvr_<fieldName>_OnChange (field-based, not entity+field)
    handlerFnName = `${field}_OnChange`;
    handlerCode =
`// Field onChange — register in Power Apps form editor (pass execution context: yes)
var ${handlerFnName} = function (executionContext) {
    const formContext = executionContext.getFormContext();

    ${candidateFunctionName}(formContext);
};`;
  } else {
    handlerFnName = `${prefix}_handler`;
    handlerCode =
`var ${handlerFnName} = function (executionContext) {
    const formContext = executionContext.getFormContext();
};`;
  }

  // No "use strict" or generated-file comments — scaffold starts directly with the handler.
  const fileCode =
`${handlerCode}

// Helper: ${candidateFunctionName}
var ${candidateFunctionName} = function (formContext) {
    // TODO: implement logic
};`;

  const registrationNote =
`// Power Apps form editor — registration:
//   Event:    ${triggerType}${triggerField ? `\n//   Field:    ${triggerField}` : ''}
//   Library:  [upload ${plan.targetFileName} as JS web resource]
//   Function: ${handlerFnName}
//   Pass execution context: yes`;

  const sections: SkeletonSection[] = [
    {
      label: 'New file scaffold',
      description: `Create ${plan.targetFileName} with this content, then upload as a JS web resource.`,
      code: fileCode,
    },
    {
      label: 'Form editor registration',
      description: 'Register the handler in the Power Apps form editor.',
      code: registrationNote,
    },
  ];

  return { targetFile: plan.targetFile, targetFileName: plan.targetFileName, operationType: plan.operationType, sections };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Return the best available script folder path for a customer.
 * Priority:
 *   1. Explicit scriptFolder (used as-is — the user set the exact path)
 *   2. resolvedRepositoryPath + /Scripts (conventional subfolder)
 *   3. repositoryRoot + /Scripts
 */
export function resolveCustomerScriptFolder(customer: Customer): string | null {
  if (customer.scriptFolder) return customer.scriptFolder;
  const repo = customer.resolvedRepositoryPath ?? customer.repositoryRoot;
  if (repo) return `${repo}/Scripts`;
  return null;
}

// ---------------------------------------------------------------------------
// V2 — Deterministic patch helpers (no AST, regex/string-based)
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the character index of a function declaration for the given name.
 * Supports:
 *   var/let/const name = [async] function
 *   function name(
 *   Prefix.name = [async] function
 * Returns -1 if not found.
 */
function findFunctionDeclarationIndex(content: string, name: string): number {
  const esc = escapeRegex(name);
  const patterns: RegExp[] = [
    new RegExp(`(?:var|let|const)\\s+${esc}\\s*=\\s*(?:async\\s+)?function`),
    new RegExp(`(?:^|\\n)function\\s+${esc}\\s*\\(`),
    new RegExp(`[a-zA-Z_$][a-zA-Z0-9_$.]*\\.${esc}\\s*=\\s*(?:async\\s+)?function`),
  ];
  for (const p of patterns) {
    const m = content.match(p);
    if (m && m.index !== undefined) return m.index;
  }
  return -1;
}

/**
 * Finds the brace-delimited body range of a function by name.
 * Returns { open, close } as character indices of the opening and closing braces,
 * or null if the function cannot be located or the body is unterminated.
 */
function findFunctionBodyRange(content: string, name: string): { open: number; close: number } | null {
  const declIdx = findFunctionDeclarationIndex(content, name);
  if (declIdx === -1) return null;

  const braceStart = content.indexOf('{', declIdx);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { open: braceStart, close: i };
    }
  }
  return null; // unterminated — brace mismatch
}

/** Returns true when a function with the exact name is declared in the content. */
function functionExists(content: string, name: string): boolean {
  return findFunctionDeclarationIndex(content, name) !== -1;
}

/** Returns true when a call site `name(` exists anywhere in the content. */
function callExists(content: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(content);
}

/** Returns true when the given marker string appears in the content. */
function markerExists(content: string, marker: string): boolean {
  return content.includes(marker);
}

/**
 * Appends a code block to the file with safe double-newline spacing.
 * Normalises trailing whitespace before appending.
 */
function appendBlock(content: string, code: string): string {
  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${code}\n`;
}

/**
 * Injects a one-or-multi-line snippet near the top of a named function body.
 *
 * Injection position priority:
 *   1. After `const formContext = executionContext.getFormContext();` if present.
 *   2. After the first newline inside the body.
 *   3. Immediately after the opening `{`.
 *
 * Throws a clear error if the function body cannot be parsed safely.
 */
function injectIntoFunctionBody(content: string, handlerName: string, snippet: string): string {
  const range = findFunctionBodyRange(content, handlerName);
  if (!range) {
    throw new Error(
      `Could not safely patch handler "${handlerName}". Open in VS Code and apply manually.`,
    );
  }

  // Detect the indentation used in the function body (first non-empty line inside)
  const bodySlice = content.slice(range.open + 1, range.close);
  const indentMatch = bodySlice.match(/\n([ \t]+)\S/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  // Try to insert after any formContext extraction:
  //   const / let / var formContext = executionContext.getFormContext();
  const formCtxPattern = /\n[ \t]*(?:const|let|var)\s+formContext\s*=\s*executionContext\.getFormContext\(\);/;
  const formCtxMatch = bodySlice.match(formCtxPattern);

  let insertOffset: number; // offset relative to start of content
  if (formCtxMatch && formCtxMatch.index !== undefined) {
    insertOffset = range.open + 1 + formCtxMatch.index + formCtxMatch[0].length;
  } else {
    // Insert after the first newline in the body
    const firstNl = bodySlice.indexOf('\n');
    insertOffset = firstNl !== -1
      ? range.open + 1 + firstNl
      : range.open + 1;
  }

  // Format snippet with correct indentation
  const formatted = snippet
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${indent}${line}`))
    .join('\n');

  return content.slice(0, insertOffset) + '\n' + formatted + content.slice(insertOffset);
}

// ---------------------------------------------------------------------------
// V2 — Preview generation
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic ScriptPreview: the exact file change that Apply will write.
 *
 * Must be called after buildScriptPlan + generateSkeleton.
 * Reads the current file content from disk when the target file already exists.
 * Never calls any AI API.
 *
 * Throws a descriptive error when patching is not safe.
 */
export async function buildScriptPreview(
  analysis: ScriptAnalysis,
  plan: ScriptPlan,
  skeleton: ScriptSkeleton,
  getFileContent: (path: string) => Promise<string>,
): Promise<ScriptPreview> {
  // Read original content if the file exists
  const originalContent = plan.fileExists
    ? await getFileContent(plan.targetFile).catch(() => '')
    : '';

  switch (plan.operationType) {
    case 'new_file_scaffold': {
      const scaffoldSection = skeleton.sections.find((s) => s.label === 'New file scaffold');
      if (!scaffoldSection) throw new Error('Skeleton missing "New file scaffold" section.');
      // Edge case: file already exists with identical scaffold content (e.g. applied before)
      const newContent = scaffoldSection.code;
      const isNoop = plan.fileExists && newContent === originalContent;
      return {
        targetFile: plan.targetFile,
        targetFileName: plan.targetFileName,
        fileExists: plan.fileExists,
        operationType: plan.operationType,
        originalContent,
        newContent,
        changeSummary: isNoop ? 'No changes needed — file already matches scaffold' : 'Create new file',
        isNoop,
      };
    }

    case 'new_onchange_handler': {
      const handlerSection = skeleton.sections.find((s) => s.label === 'New onChange handler');
      const helperSection  = skeleton.sections.find((s) => s.label === 'Helper function');
      if (!handlerSection || !helperSection) {
        throw new Error('Skeleton missing expected sections for new_onchange_handler.');
      }

      // Extract function names to detect duplicates
      const handlerNameMatch = handlerSection.code.match(/(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
      const helperNameMatch  = helperSection.code.match(/(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
      const handlerFnName    = handlerNameMatch?.[1];
      const helperFnName     = helperNameMatch?.[1];

      let content = originalContent;

      if (!handlerFnName || !functionExists(content, handlerFnName)) {
        content = appendBlock(content, handlerSection.code);
      }
      if (!helperFnName || !functionExists(content, helperFnName)) {
        content = appendBlock(content, helperSection.code);
      }

      // Final content-equality guard
      const finalIsNoop = content === originalContent;
      return {
        targetFile: plan.targetFile,
        targetFileName: plan.targetFileName,
        fileExists: plan.fileExists,
        operationType: plan.operationType,
        originalContent,
        newContent: content,
        changeSummary: finalIsNoop
          ? 'No changes needed — handler and helper already present'
          : 'Append new onChange handler and helper',
        isNoop: finalIsNoop,
      };
    }

    case 'helper_plus_hook': {
      const helperSection = skeleton.sections.find((s) => s.label === 'New helper function');
      if (!helperSection) throw new Error('Skeleton missing "New helper function" section.');

      const helperName  = analysis.candidateFunctionName;
      const handlerName = plan.existingHandlerName;
      if (!handlerName) {
        throw new Error(
          'helper_plus_hook requires an existing handler. ' +
          'Plan did not resolve a handler — re-run Plan or use new_onchange_handler.',
        );
      }

      let content = originalContent;

      // Step 1: add helper if not already present
      if (!functionExists(content, helperName)) {
        content = appendBlock(content, helperSection.code);
      }

      // Step 2: check if handler already calls the helper
      const handlerRange = findFunctionBodyRange(content, handlerName);
      if (!handlerRange) {
        throw new Error(
          `Could not safely patch handler "${handlerName}". Open in VS Code and apply manually.`,
        );
      }

      const handlerBody = content.slice(handlerRange.open, handlerRange.close + 1);
      const alreadyCalled = callExists(handlerBody, helperName);

      if (!alreadyCalled) {
        // Match any flavour of formContext extraction: const / let / var
        const hasFormContext = /(?:const|let|var)\s+formContext\s*=\s*executionContext\.getFormContext\(\)/.test(handlerBody);
        const injection = hasFormContext
          ? `${helperName}(formContext);`
          : `const formContext = executionContext.getFormContext();\n${helperName}(formContext);`;

        content = injectIntoFunctionBody(content, handlerName, injection);
      }

      // Final content-equality guard: covers cases like helper injected + call
      // already existed, producing an unchanged file despite partial work.
      const finalIsNoop = content === originalContent;
      return {
        targetFile: plan.targetFile,
        targetFileName: plan.targetFileName,
        fileExists: plan.fileExists,
        operationType: plan.operationType,
        originalContent,
        newContent: content,
        changeSummary: finalIsNoop
          ? 'No changes needed — helper and hook already present'
          : 'Insert helper function and patch existing handler',
        isNoop: finalIsNoop,
      };
    }

    case 'extend_existing_helper': {
      const extSection = skeleton.sections.find((s) => s.label === 'Extension snippet');
      if (!extSection) throw new Error('Skeleton missing "Extension snippet" section.');

      const handlerName = plan.existingHandlerName;
      if (!handlerName) {
        throw new Error('extend_existing_helper requires an existing handler name from the plan.');
      }

      // Stable marker so re-run is idempotent
      const markerStart = `// [SA-V2-START] ${handlerName}`;
      const markerEnd   = `// [SA-V2-END] ${handlerName}`;

      if (markerExists(originalContent, markerStart)) {
        return {
          targetFile: plan.targetFile,
          targetFileName: plan.targetFileName,
          fileExists: plan.fileExists,
          operationType: plan.operationType,
          originalContent,
          newContent: originalContent,
          changeSummary: 'No changes needed — extension block already applied',
          isNoop: true,
        };
      }

      // Wrap the snippet in start/end markers so future runs detect it
      const markedSnippet =
        `${markerStart}\n` +
        extSection.code.split('\n').map((l) => `${l}`).join('\n') +
        `\n${markerEnd}`;

      const content = injectIntoFunctionBody(originalContent, handlerName, markedSnippet);
      return {
        targetFile: plan.targetFile,
        targetFileName: plan.targetFileName,
        fileExists: plan.fileExists,
        operationType: plan.operationType,
        originalContent,
        newContent: content,
        changeSummary: 'Extend existing handler with new logic block',
        isNoop: false,
      };
    }

    default:
      throw new Error(`Unknown operation type: ${(plan as ScriptPlan).operationType}`);
  }
}
