import type { CrmSkeletonResult } from '../types';

interface CrmSkeletonResultViewProps {
  result: CrmSkeletonResult;
}

export default function CrmSkeletonResultView({ result }: CrmSkeletonResultViewProps) {
  const tools = result.metadataInspected?.toolsUsed ?? [];
  const entities = result.metadataInspected?.entityLogicalNames ?? [];

  return (
    <div className="detail-analysis-block" style={{ marginTop: 8 }}>
      <div className="analysis-subsection">
        <span className="analysis-subsection-label">Summary</span>
        <p className="detail-analysis-summary">{result.summary || '—'}</p>
      </div>

      <div className="analysis-subsection" style={{ marginTop: 8 }}>
        <span className="analysis-subsection-label">Pseudo-code</span>
        <pre className="detail-code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>
          {result.pseudoCode || ''}
        </pre>
      </div>

      <div className="analysis-subsection" style={{ marginTop: 8 }}>
        <span className="analysis-subsection-label">Metadata inspected</span>
        <div className="settings-field-hint">Entities: {entities.length ? entities.join(', ') : 'none'}</div>
        <div className="settings-field-hint">Tools used: {tools.length ? tools.join(', ') : 'none'}</div>
      </div>
    </div>
  );
}
