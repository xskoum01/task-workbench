import type { CrmPluginCheck, CrmReferenceFinding, CrmVerificationReport } from '../types';

interface CrmVerificationReportViewProps {
  report: CrmVerificationReport;
}

function countBySeverity(report: CrmVerificationReport, severity: 'error' | 'warning' | 'suggestion'): number {
  return (report.issues ?? []).filter((i) => i.severity === severity).length;
}

function getVerdictLabel(verdict: CrmVerificationReport['verdict']): string {
  switch (verdict) {
    case 'not_configured': return 'NOT CONFIGURED';
    case 'warnings': return 'WARNINGS';
    case 'fail': return 'FAIL';
    case 'error': return 'ERROR';
    case 'unknown': return 'UNKNOWN';
    default: return 'PASS';
  }
}

function getVerdictClass(verdict: CrmVerificationReport['verdict']): string {
  switch (verdict) {
    case 'pass':
      return 'repo-status-linked';
    case 'not_configured':
    case 'unknown':
      return 'repo-status-not-created';
    default:
      return 'repo-status-missing';
  }
}

function getMetadataVerdictLabel(verdict: CrmVerificationReport['metadataVerdict']): string {
  switch (verdict) {
    case 'pass': return 'PASS';
    case 'warnings': return 'WARNINGS';
    case 'fail': return 'FAIL';
    default: return 'UNKNOWN';
  }
}

function getMetadataVerdictClass(verdict: CrmVerificationReport['metadataVerdict']): string {
  switch (verdict) {
    case 'pass': return 'repo-status-linked';
    case 'warnings': return 'repo-status-missing';
    case 'fail': return 'repo-status-missing';
    default: return 'repo-status-not-created';
  }
}

function getRuntimeReadinessLabel(readiness: CrmVerificationReport['runtimeReadiness']): string {
  switch (readiness) {
    case 'low_risk': return 'LOW RISK';
    case 'risks_found': return 'RISKS FOUND';
    case 'not_checked': return 'NOT CHECKED';
    default: return 'UNKNOWN';
  }
}

function getInferenceLabel(confidence: CrmVerificationReport['staticInferenceConfidence']): string {
  switch (confidence) {
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    case 'low': return 'LOW';
    case 'inferred': return 'INFERRED';
    default: return 'UNKNOWN';
  }
}

function renderReferenceLabel(item: CrmReferenceFinding): string {
  if (item.displayName) {
    return item.displayName;
  }
  if (item.entityLogicalName && item.attributeLogicalName) {
    return `${item.entityLogicalName}.${item.attributeLogicalName}`;
  }
  if (item.entityLogicalName) {
    return item.entityLogicalName;
  }
  if (item.attributeLogicalName) {
    return item.attributeLogicalName;
  }
  return 'Unnamed reference';
}

// Group findings by entityLogicalName; items without an entity go to "(unknown context)".
function groupByEntity(items: CrmReferenceFinding[]): Record<string, CrmReferenceFinding[]> {
  const groups: Record<string, CrmReferenceFinding[]> = {};
  for (const item of items) {
    const key = item.entityLogicalName ?? '(unknown context)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function FindingItem({ item }: { item: CrmReferenceFinding }) {
  const label = renderReferenceLabel(item);
  return (
    <li style={{ marginBottom: 6 }}>
      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{label}</span>
      {item.kind !== 'entity' && (
        <span className="settings-field-hint" style={{ marginLeft: 6 }}>[{item.kind}]</span>
      )}
      {item.sourceReason && (
        <div className="settings-field-hint" style={{ marginTop: 2 }}>{item.sourceReason}</div>
      )}
      {item.detail && <div className="settings-field-hint">{item.detail}</div>}
    </li>
  );
}

/**
 * Collapsible section of findings grouped by entity.
 * "(unknown context)" items appear last.
 */
function GroupedFindingSection({
  title,
  items,
  emptyLabel,
  defaultOpen = false,
}: {
  title: string;
  items: CrmReferenceFinding[];
  emptyLabel: string;
  defaultOpen?: boolean;
}) {
  if (items.length === 0) {
    return (
      <details className="analysis-subsection" style={{ marginTop: 8 }}>
        <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
          {title} (0)
        </summary>
        <div className="settings-field-hint" style={{ marginTop: 8 }}>{emptyLabel}</div>
      </details>
    );
  }

  const grouped = groupByEntity(items);
  const entityKeys = Object.keys(grouped).sort((a, b) => {
    if (a === '(unknown context)') return 1;
    if (b === '(unknown context)') return -1;
    return a.localeCompare(b);
  });

  return (
    <details className="analysis-subsection" style={{ marginTop: 8 }} open={defaultOpen}>
      <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
        {title} ({items.length})
      </summary>
      <div style={{ marginTop: 8 }}>
        {entityKeys.map((entityKey) => {
          const entityItems = grouped[entityKey];
          return (
            <div key={entityKey} style={{ marginBottom: 10 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                borderBottom: '1px solid var(--border-subtle)',
                paddingBottom: 3,
                marginBottom: 6,
              }}>
                {entityKey}
              </div>
              <ul className="detail-analysis-points" style={{ margin: 0, paddingLeft: 0 }}>
                {entityItems.map((item, idx) => (
                  <FindingItem
                    key={`${entityKey}-${idx}-${item.attributeLogicalName ?? item.displayName}`}
                    item={item}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function PluginChecksSection({ items }: { items: CrmPluginCheck[] }) {
  return (
    <details className="analysis-subsection" style={{ marginTop: 8 }} open={items.length > 0}>
      <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
        Plugin-specific checks ({items.length})
      </summary>
      {items.length === 0 ? (
        <div className="settings-field-hint" style={{ marginTop: 8 }}>No plugin-specific checks were collected.</div>
      ) : (
        <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
          {items.map((item, idx) => (
            <li key={`${item.title}-${idx}`}>
              <strong>{item.status.toUpperCase()}</strong> · {item.title}
              <div className="settings-field-hint">{item.detail}</div>
              {item.sourceReason && <div className="settings-field-hint">{item.sourceReason}</div>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export default function CrmVerificationReportView({ report }: CrmVerificationReportViewProps) {
  const errors = countBySeverity(report, 'error');
  const warnings = countBySeverity(report, 'warning');
  const suggestions = countBySeverity(report, 'suggestion');
  const tools = report.metadataInspected?.toolsUsed ?? [];
  const entities = report.inspectedEntities?.length
    ? report.inspectedEntities
    : (report.metadataInspected?.entityLogicalNames ?? []);
  const answer = report.answer || report.summary || 'No summary available.';
  const metadataWasInspected = (report.metadataInspected?.entityLogicalNames?.length ?? 0) > 0;

  return (
    <div className="detail-analysis-block" style={{ marginTop: 8 }}>
      {/* === Overall verdict — always visible at the top === */}
      <div className="analysis-subsection">
        <span className="analysis-subsection-label">Overall verdict</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <span className={`repo-status-badge ${getVerdictClass(report.verdict)}`}>
            {getVerdictLabel(report.verdict)}
          </span>
          <span className={`repo-status-badge ${getMetadataVerdictClass(report.metadataVerdict)}`}>
            Metadata: {getMetadataVerdictLabel(report.metadataVerdict)}
          </span>
          <span className="repo-status-badge repo-status-not-created">
            Runtime: {getRuntimeReadinessLabel(report.runtimeReadiness)}
          </span>
          <span className="repo-status-badge repo-status-not-created">
            Inference: {getInferenceLabel(report.staticInferenceConfidence)}
          </span>
          {(errors > 0 || warnings > 0 || suggestions > 0) && (
            <span className="settings-field-hint">
              {errors} errors · {warnings} warnings · {suggestions} suggestions
            </span>
          )}
        </div>
        <p className="detail-analysis-summary" style={{ marginTop: 6, marginBottom: 0 }}>{answer}</p>
        <div className="settings-field-hint" style={{ marginTop: 4 }}>
          {report.verdict === 'not_configured'
            ? 'Dataverse metadata was not inspected. This is not a CRM verification result.'
            : 'Runtime behavior is not guaranteed by metadata validation alone.'}
        </div>
        {report.verdict === 'not_configured' && !metadataWasInspected && (
          <div className="settings-field-hint" style={{ marginTop: 4 }}>
            Local reference scan only — not checked against Dataverse.
          </div>
        )}
      </div>

      {/* === Missing references — open by default when present === */}
      <GroupedFindingSection
        title="Confirmed missing references"
        items={report.missingReferences ?? []}
        emptyLabel="No confirmed missing references were recorded."
        defaultOpen={(report.missingReferences?.length ?? 0) > 0}
      />

      {/* === Plugin-specific checks === */}
      <PluginChecksSection items={report.pluginChecks ?? []} />

      {/* === Runtime risks — open by default when present === */}
      <GroupedFindingSection
        title="Runtime risks"
        items={report.runtimeRisks ?? []}
        emptyLabel="No runtime risks were recorded from static analysis."
        defaultOpen={(report.runtimeRisks?.length ?? 0) > 0}
      />

      {/* === Ambiguous references — open by default when present === */}
      <GroupedFindingSection
        title="Ambiguous references"
        items={report.ambiguousReferences ?? []}
        emptyLabel="No ambiguous references were recorded."
        defaultOpen={(report.ambiguousReferences?.length ?? 0) > 0}
      />

      {/* === Confirmed references — collapsed by default === */}
      <GroupedFindingSection
        title="Confirmed references"
        items={report.confirmedReferences ?? []}
        emptyLabel="No confirmed references were recorded."
        defaultOpen={false}
      />

      {/* === Metadata inspected === */}
      <div className="analysis-subsection" style={{ marginTop: 8 }}>
        <span className="analysis-subsection-label">Metadata inspected</span>
        <div className="settings-field-hint">
          Entities: {entities.length ? entities.join(', ') : 'none'}
        </div>
        <div className="settings-field-hint">
          Tools used: {tools.length ? tools.join(', ') : 'none'}
        </div>
        {(report.metadataInspected?.entityDetails?.length ?? 0) > 0 && (
          <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
            {report.metadataInspected.entityDetails?.map((detail) => (
              <li key={detail.entityLogicalName}>
                <strong>{detail.entityLogicalName}</strong>
                <div className="settings-field-hint">
                  {detail.columnCount} columns · {detail.schemaCompleteness} schema · tool: {detail.toolUsed}
                  {detail.paging ? ` · paging: ${detail.paging}` : ''}
                </div>
                {detail.note && (
                  <div
                    className="settings-field-hint"
                    style={detail.schemaCompleteness !== 'complete' ? { color: 'var(--color-warning, #d29922)' } : undefined}
                  >
                    {detail.note}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {Object.keys(report.inspectedAttributesByEntity ?? {}).length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary className="settings-field-hint" style={{ cursor: 'pointer' }}>
              Attributes inspected per entity
            </summary>
            <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
              {Object.entries(report.inspectedAttributesByEntity)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([entityName, attributes]) => (
                  <li key={entityName}>
                    <strong>{entityName}</strong>
                    <div className="settings-field-hint">
                      {attributes.length ? attributes.join(', ') : 'No attributes returned.'}
                    </div>
                  </li>
                ))}
            </ul>
          </details>
        )}
      </div>

      {/* === Unable to verify — only shown when there are entries === */}
      {(report.unableToVerifyReasons?.length ?? 0) > 0 && (
        <details className="analysis-subsection" style={{ marginTop: 8 }} open>
          <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
            Unable to verify ({report.unableToVerifyReasons?.length ?? 0})
          </summary>
          <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
            {report.unableToVerifyReasons.map((reason, idx) => (
              <li key={`${reason}-${idx}`}>{reason}</li>
            ))}
          </ul>
        </details>
      )}

      {/* === Runtime / form registration — informational only, never a Dataverse metadata warning === */}
      {(report.formRegistrationNotes?.length ?? 0) > 0 && (
        <details className="analysis-subsection" style={{ marginTop: 8 }}>
          <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
            Runtime / form registration: Not checked
          </summary>
          <div className="settings-field-hint" style={{ marginTop: 8 }}>
            Form registration/runtime context was not checked. This is expected before web resource upload and form event registration.
          </div>
          <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
            {(report.formRegistrationNotes ?? []).map((note, idx) => (
              <li key={`${note}-${idx}`}>{note}</li>
            ))}
          </ul>
        </details>
      )}

      {/* === Detailed issues — collapsed by default === */}
      {(report.issues?.length ?? 0) > 0 && (
        <details className="analysis-subsection" style={{ marginTop: 8 }}>
          <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
            Detailed issues ({report.issues?.length ?? 0})
          </summary>
          <ul className="detail-analysis-points" style={{ marginTop: 8 }}>
            {report.issues.map((issue, idx) => (
              <li key={`${issue.code}-${idx}`}>
                <strong>{issue.severity.toUpperCase()}</strong> · {issue.title}
                <div className="settings-field-hint">{issue.detail}</div>
                {(issue.entityLogicalName || issue.attributeLogicalName) && (
                  <div className="settings-field-hint">
                    {[issue.entityLogicalName, issue.attributeLogicalName].filter(Boolean).join('.')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* === Raw extracted references — collapsed by default === */}
      <details className="analysis-subsection" style={{ marginTop: 8 }}>
        <summary className="analysis-subsection-label" style={{ cursor: 'pointer' }}>
          Raw extracted references
        </summary>
        <pre className="detail-code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', marginTop: 8 }}>
          {JSON.stringify(report.rawExtractedReferences ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}

