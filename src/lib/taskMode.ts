/**
 * taskMode.ts — resolves the effective developer/general mode for a task.
 *
 * Priority:
 *   1. task.taskMode (explicit user override)
 *   2. ADO work-item or PR assignment → developer
 *   3. workflowSetup.devTargetKind = plugin | script → developer
 *   4. devopsTaskUrl present → developer
 *   5. Text-based heuristic: plugin/script/Dataverse technical keywords → developer
 *   6. default → general
 */
import type { Task } from '../types';

export type TaskMode = 'developer' | 'general';

export interface ResolvedTaskMode {
  mode: TaskMode;
  /** True when the mode is derived from heuristics, false when user-set. */
  isAuto: boolean;
}

/**
 * Plugin/script technical keywords that reliably indicate a developer task.
 * Requires a meaningful technical signal — generic words like "update" or "fix" are excluded.
 *
 * NOTE: Czech accented characters (ě, á, ž …) are \W in JS regex, so \b after them
 * does NOT work. Use explicit alternatives (e.g. entit[aě]) instead.
 */
const DEVELOPER_KEYWORDS = [
  // Plugin / C# / Dataverse server-side
  /\bplugin\b/i,
  /\biplugin\b/i,
  /dataverse/i,
  /\bcrm plugin\b/i,
  /preoperation|postoperation/i,
  /\.csproj\b|\.cs\b/i,
  /\bstatecode\b|\bstatuscode\b/i,
  /\bIOrganizationService\b|\bIPlugin\b|\bITracingService\b/i,
  // Entity / record context — Czech "entita"/"entitě" + English "entity"
  // \bentita\b works (all ASCII); entit[eě] covers "entitě"/"entity" without broken \b
  /\bentita\b/i,
  /entit[eě]/i,
  // Form / tab / section / field — CRM UI concepts (Czech + English)
  /\bformulář|\bformuláři\b/i,    // Czech: form
  /sekc[ei]/i,                     // Czech: sekce/sekci (section in nom./acc.)
  /\bzáložka\b|\bzáložce\b/i,     // Czech: tab
  // Show/hide visibility operations — strong CRM dev signal
  /skrývání|skrýt|skryj|zobrazení|zobrazit/i,
  // Custom field prefix (nvr_, cr_) — unambiguous Dataverse developer signal
  /\bnvr_|\bcr[a-z0-9]{1,4}_/i,
  // Standalone "pole" (field) — CRM field change context
  /\bpole\b/i,
  // PCF / Power Apps Component Framework
  /\bpcf\b/i,
  // Power Apps / Dynamics 365 platform
  /power apps|dynamics 365|\bd365\b/i,
  // Script / JS / WebResource / form context
  /\bscript\b.*\b(crm|d365|dynamics|dataverse|xrm)\b|\b(xrm|formcontext)\b/i,
  /\bwebresource\b|\bonchange\b|\bonload\b|\bonsave\b/i,
  /\bribbon\b/i,
  /\bformcontext\b|\bxrm\.page\b/i,
  /\.js\b.*crm|crm.*\.js\b|\.ts\b.*crm|crm.*\.ts\b/i,
  // "pole" (field) mentioned near "entit" (entity) — Czech CRM field change task
  /\bpole\b.*entit|entit.*\bpole\b/i,
];

/**
 * Returns the effective task mode and whether it is heuristically inferred.
 * Components should use this instead of reading task.taskMode directly.
 */
export function inferTaskMode(task: Task): ResolvedTaskMode {
  // Explicit user override always wins.
  if (task.taskMode) {
    return { mode: task.taskMode, isAuto: false };
  }

  // ADO work-item assignment emails are almost always developer tasks.
  if (task.adoContext?.type === 'work-item') {
    return { mode: 'developer', isAuto: true };
  }

  // ADO PR comments are code review → developer.
  if (task.adoContext?.type === 'pr-comment') {
    return { mode: 'developer', isAuto: true };
  }

  // Explicit devops URL → developer context.
  if (task.devopsTaskUrl) {
    return { mode: 'developer', isAuto: true };
  }

  // User already confirmed a dev kind → developer.
  const devKind = task.workflowSetup?.devTargetKind;
  if (devKind === 'plugin' || devKind === 'script' || devKind === 'repo') {
    return { mode: 'developer', isAuto: true };
  }

  // Text-based heuristic: scan title + originalMessage for technical developer signals.
  // Requires at least one strong keyword match — generic task words are intentionally excluded.
  const textToScan = `${task.title} ${task.originalMessage ?? ''} ${task.analysisResult?.summary ?? ''}`;
  for (const kw of DEVELOPER_KEYWORDS) {
    if (kw.test(textToScan)) {
      return { mode: 'developer', isAuto: true };
    }
  }

  return { mode: 'general', isAuto: true };
}
