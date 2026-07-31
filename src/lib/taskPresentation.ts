import type { Task } from '../types';

/** Text shown as the human-facing expected outcome in the expanded record. */
export function expectedOutcomeCzech(task: Task): string {
  const text = task.analysisResult?.summaryCz?.trim()
    || task.description?.trim()
    || task.analysisResult?.summary?.trim();
  if (!text) return 'Očekávaný výsledek zatím není vyplněn.';

  // ADO imports historically generated this English sentence. Keep the
  // deterministic translation local so old records become Czech as well.
  const adoMatch = /^Azure DevOps task (\d+) requests adding (.+?)\.\s*The exact implementation details should be checked in the linked work item\.?$/i.exec(text);
  if (adoMatch) {
    const requested = adoMatch[2]
      .replace(/^the\s+/i, '')
      .replace(/KS \/ KS specialist fields to scripts/i, 'polí KS / KS specialist do skriptů');
    return `Azure DevOps úkol ${adoMatch[1]} požaduje doplnění ${requested}. Přesné detaily implementace ověřte v odkazované položce.`;
  }

  return text;
}
