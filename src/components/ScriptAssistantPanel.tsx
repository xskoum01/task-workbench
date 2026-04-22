/**
 * Script Assistant Panel — V1 workflow for Dataverse model-driven app JS scripts.
 *
 * Workflow: Analyze → Plan → Skeleton → Open in VS Code
 *
 * V1 contract:
 * - Analysis result persisted to task.scriptAnalysis (survives task switching)
 * - Skeleton rendered as multiple labeled, individually-copyable sections
 * - VS Code open falls back to script folder when target file does not yet exist
 * - Plan shows customer name, repo path, and concrete recommended action
 */

import { useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import type { Task, Customer, ScriptAnalysis, ScriptPlan, ScriptSkeleton, SkeletonSection, ScriptPreview, ScriptApplyResult } from '../types';
import Icon from './Icon';
import { useApp } from '../context/AppContext';
import * as tauriApi from '../lib/tauriCommands';
import {
  analyzeScriptTask,
  buildScriptPlan,
  generateSkeleton,
  buildScriptPreview,
  resolveCustomerScriptFolder,
} from '../lib/scriptAssistant';

export interface ScriptAssistantPanelHandle {
  /** Run the full Analyze → Plan → Skeleton → Preview pipeline. Throws on failure. */
  generateDraft(): Promise<void>;
  /** Write the current preview to disk. Throws if no preview is available. */
  applyDraft(): Promise<void>;
}

interface ScriptAssistantPanelProps {
  task: Task;
  customer: Customer;
  /**
   * Called whenever the draft-ready state changes.
   * `true`  = a preview is loaded and ready to apply.
   * `false` = no preview (or just applied).
   */
  onDraftChange?: (hasDraft: boolean) => void;
  /**
   * Explicit script folder path to use when customer fields alone cannot resolve one.
   * Covers the fallback path (crmBaseDirectory + folderName) used by Open Work.
   */
  scriptFolderOverride?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AnalysisDisplay({ analysis }: { analysis: ScriptAnalysis }) {
  const isLowConfidence = analysis.confidence < 0.60;
  return (
    <div className="sa-result">
      {isLowConfidence && (
        <div className="sa-inline-warn">
          Low confidence ({Math.round(analysis.confidence * 100)}%) — entity or trigger may be incorrect. Review before proceeding.
        </div>
      )}
      <div className="sa-result-row">
        <span className="sa-result-label">Entity</span>
        <span className="sa-result-value sa-mono">{analysis.entityLogicalName}</span>
      </div>
      <div className="sa-result-row">
        <span className="sa-result-label">Trigger</span>
        <span className="sa-result-value">
          {analysis.triggerType}
          {analysis.triggerField && <span className="sa-field-pill"> {analysis.triggerField}</span>}
        </span>
      </div>
      <div className="sa-result-row">
        <span className="sa-result-label">Function</span>
        <span className="sa-result-value sa-mono">{analysis.candidateFunctionName}</span>
      </div>
      {!isLowConfidence && (
        <div className="sa-result-row">
          <span className="sa-result-label">Confidence</span>
          <span className="sa-result-value">{Math.round(analysis.confidence * 100)}%</span>
        </div>
      )}
      <div className="sa-summary">{analysis.summary}</div>
    </div>
  );
}

const RESOLVED_BY_LABEL: Record<ScriptPlan['resolvedBy'], string> = {
  canonical: 'canonical pattern',
  activity_shared: 'shared activity file',
  content_match: 'content search',
  none: 'not found — will scaffold',
};

const OPERATION_LABEL: Record<string, string> = {
  new_file_scaffold:      'Create new file',
  new_onchange_handler:   'Add onChange handler',
  helper_plus_hook:       'Add helper + hook',
  extend_existing_helper: 'Extend existing helper',
};

function PlanDisplay({ plan, customer }: { plan: ScriptPlan; customer: Customer }) {
  const scriptFolder = resolveCustomerScriptFolder(customer);

  return (
    <div className="sa-result">
      {/* Recommended action — highlighted at top */}
      <div className="sa-recommended-action">{plan.recommendedAction}</div>

      <div className="sa-result-row">
        <span className="sa-result-label">Customer</span>
        <span className="sa-result-value">{customer.name}</span>
      </div>
      {scriptFolder && (
        <div className="sa-result-row">
          <span className="sa-result-label">Repo</span>
          <span className="sa-result-value sa-mono sa-ellipsis" title={scriptFolder}>{scriptFolder}</span>
        </div>
      )}
      <div className="sa-result-row">
        <span className="sa-result-label">Target file</span>
        <span className="sa-result-value sa-mono">{plan.targetFileName}</span>
      </div>
      <div className="sa-result-row">
        <span className="sa-result-label">Resolved by</span>
        <span className="sa-result-value">{RESOLVED_BY_LABEL[plan.resolvedBy]}</span>
      </div>
      <div className="sa-result-row">
        <span className="sa-result-label">File exists</span>
        <span className={`sa-result-value ${plan.fileExists ? 'sa-ok' : 'sa-warn'}`}>
          {plan.fileExists ? 'yes' : 'no — will scaffold'}
        </span>
      </div>
      <div className="sa-result-row">
        <span className="sa-result-label">Operation</span>
        <span className="sa-result-value">{OPERATION_LABEL[plan.operationType] ?? plan.operationType}</span>
      </div>
      {plan.existingHandlerName && (
        <div className="sa-result-row">
          <span className="sa-result-label">Hook into</span>
          <span className="sa-result-value sa-mono">{plan.existingHandlerName}</span>
        </div>
      )}
      {plan.similarHelperFound && (
        <div className="sa-inline-warn">
          A helper with a similar name already exists in this file. Check for duplicates before adding the new one.
        </div>
      )}
      {plan.inspection && plan.inspection.handlers.length > 0 && (
        <div className="sa-result-row">
          <span className="sa-result-label">Handlers</span>
          <span className="sa-result-value sa-mono sa-list">
            {plan.inspection.handlers.join(', ')}
          </span>
        </div>
      )}
      {plan.inspection && plan.inspection.helpers.length > 0 && (
        <div className="sa-result-row">
          <span className="sa-result-label">Helpers</span>
          <span className="sa-result-value sa-mono sa-list">
            {plan.inspection.helpers.slice(0, 8).join(', ')}
            {plan.inspection.helpers.length > 8 && ` +${plan.inspection.helpers.length - 8} more`}
          </span>
        </div>
      )}
    </div>
  );
}

function SectionBlock({ section }: { section: SkeletonSection }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(section.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available — not critical
    }
  }

  return (
    <div className="sa-section">
      <div className="sa-section-header">
        <span className="sa-section-label">{section.label}</span>
        <button className="btn btn-ghost btn-sm" onClick={handleCopy} title="Copy section code">
          <Icon name="layers" size={11} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {section.description && (
        <div className="sa-section-desc">{section.description}</div>
      )}
      <pre className="sa-code-block">{section.code}</pre>
    </div>
  );
}

function SkeletonDisplay({ skeleton }: { skeleton: ScriptSkeleton }) {
  return (
    <div className="sa-skeleton">
      <div className="sa-skeleton-file-row">
        <Icon name="file-text" size={11} />
        <span className="sa-mono">{skeleton.targetFileName}</span>
        <span className="sa-operation-badge">{OPERATION_LABEL[skeleton.operationType] ?? skeleton.operationType}</span>
      </div>
      {skeleton.sections.map((section, i) => (
        <SectionBlock key={i} section={section} />
      ))}
    </div>
  );
}

function PreviewDisplay({ preview }: { preview: ScriptPreview }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(preview.newContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }

  return (
    <div className="sa-preview">
      <div className="sa-preview-header">
        <div className="sa-skeleton-file-row">
          <Icon name="file-text" size={11} />
          <span className="sa-mono">{preview.targetFileName}</span>
          <span className={`sa-change-badge sa-change-badge--${preview.fileExists ? 'update' : 'create'}`}>
            {preview.fileExists ? 'update' : 'create'}
          </span>
        </div>
        <div className="sa-preview-summary">{preview.changeSummary}</div>
      </div>
      {preview.isNoop ? (
        <div className="sa-noop-message">
          No file changes needed — logic already appears to be applied.
        </div>
      ) : (
        <div className="sa-preview-body">
          <div className="sa-preview-code-header">
            <span className="sa-section-label">Final file content</span>
            <button className="btn btn-ghost btn-sm" onClick={handleCopy} title="Copy final content">
              <Icon name="layers" size={11} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="sa-code-block sa-code-block--main">{preview.newContent}</pre>
        </div>
      )}
    </div>
  );
}

function ApplySuccessDisplay({ result }: { result: ScriptApplyResult }) {
  return (
    <div className="sa-apply-success">
      <span className="sa-apply-success-icon">✓</span>
      <span className="sa-apply-success-text">
        {result.created ? 'Created' : 'Updated'}{' '}
        <span className="sa-mono">{result.targetFileName}</span>
        {' '}({result.bytesWritten} bytes)
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default forwardRef<ScriptAssistantPanelHandle, ScriptAssistantPanelProps>(
function ScriptAssistantPanel({ task, customer, onDraftChange, scriptFolderOverride }, ref) {
  const { updateTask } = useApp();
  const scriptFolder = resolveCustomerScriptFolder(customer) ?? scriptFolderOverride ?? null;

  // Restore persisted analysis from task (survives task switching).
  // Track whether we loaded from persistence so the UI can show a subtle indicator.
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(task.scriptAnalysis ?? null);
  // True when analysis came from persistence and hasn't been refreshed yet this session.
  // useRef so toggling it to false in handleAnalyze fires before the re-render.
  const analysisIsRestored = useRef<boolean>(!!(task.scriptAnalysis));
  const [plan, setPlan]           = useState<ScriptPlan | null>(null);
  const [skeleton, setSkeleton]   = useState<ScriptSkeleton | null>(null);
  const [preview, setPreview]     = useState<ScriptPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ScriptApplyResult | null>(null);

  // Shadow ref so imperative applyDraft() can read the current preview synchronously.
  const previewRef = useRef<ScriptPreview | null>(null);
  function updatePreview(p: ScriptPreview | null) {
    previewRef.current = p;
    setPreview(p);
    onDraftChange?.(!!p && !p.isNoop);
  }

  const [loading, setLoading] = useState<'analyze' | 'plan' | 'skeleton' | 'preview' | 'apply' | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // ---------------------------------------------------------------------------
  // Imperative API (exposed via forwardRef to TaskDetail)
  // ---------------------------------------------------------------------------

  useImperativeHandle(ref, () => ({
    /** Chain all 4 steps using local variables so we don’t rely on async state between steps. */
    async generateDraft() {
      if (!scriptFolder) throw new Error('No script folder configured for this customer.');
      clearError();

      // Step 1: Analyze (synchronous)
      setLoading('analyze');
      let localAnalysis: ScriptAnalysis;
      try {
        localAnalysis = analyzeScriptTask(task, customer);
        analysisIsRestored.current = false;
        setAnalysis(localAnalysis);
        setPlan(null); setSkeleton(null);
        updatePreview(null);
        setApplyResult(null);
        updateTask(task.id, { scriptAnalysis: localAnalysis }).catch(() => {});
      } catch (e) {
        setLoading(null);
        setError(String(e));
        throw e;
      }

      // Step 2: Plan (async — reads files from disk)
      setLoading('plan');
      let localPlan: ScriptPlan;
      try {
        localPlan = await buildScriptPlan(
          localAnalysis,
          scriptFolder,
          () => tauriApi.listDirectoryFiles(scriptFolder, 'js'),
          (path: string) => tauriApi.readFileContent(path),
        );
        setPlan(localPlan);
        setSkeleton(null);
        updatePreview(null);
        setApplyResult(null);
      } catch (e) {
        setLoading(null);
        setError(String(e));
        throw e;
      }

      // Step 3: Skeleton (synchronous)
      setLoading('skeleton');
      let localSkeleton: ScriptSkeleton;
      try {
        localSkeleton = generateSkeleton(localAnalysis, localPlan);
        setSkeleton(localSkeleton);
        updatePreview(null);
        setApplyResult(null);
      } catch (e) {
        setLoading(null);
        setError(String(e));
        throw e;
      }

      // Step 4: Preview (async — reads current file content)
      setLoading('preview');
      try {
        const localPreview = await buildScriptPreview(
          localAnalysis,
          localPlan,
          localSkeleton,
          (path: string) => tauriApi.readFileContent(path),
        );
        updatePreview(localPreview);
        setApplyResult(null);
      } catch (e) {
        setLoading(null);
        setError(String(e));
        throw e;
      }
      setLoading(null);
    },

    async applyDraft() {
      const currentPreview = previewRef.current;
      if (!currentPreview) throw new Error('No preview available. Run Generate Draft first.');
      if (currentPreview.isNoop) throw new Error('No file changes to apply — logic already present.');
      clearError();
      setLoading('apply');
      try {
        await tauriApi.saveGeneratedFile(currentPreview.targetFile, currentPreview.newContent);
        setApplyResult({
          targetFile: currentPreview.targetFile,
          targetFileName: currentPreview.targetFileName,
          created: !currentPreview.fileExists,
          updated: currentPreview.fileExists,
          bytesWritten: new TextEncoder().encode(currentPreview.newContent).length,
        });
        onDraftChange?.(false); // draft consumed
      } catch (e) {
        setLoading(null);
        setError(String(e));
        throw e;
      }
      setLoading(null);
    },
  }), [task, customer, scriptFolder, clearError, updateTask, onDraftChange]);

  // --- Step 1: Analyze ---

  function handleAnalyze() {
    clearError();
    setLoading('analyze');
    try {
      const result = analyzeScriptTask(task, customer);
      analysisIsRestored.current = false; // fresh analysis — clear the restored hint
      setAnalysis(result);
      setPlan(null);
      setSkeleton(null);
      updatePreview(null);
      setApplyResult(null);
      // Persist to task so analysis survives navigation away and back
      updateTask(task.id, { scriptAnalysis: result }).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  // --- Step 2: Plan ---

  async function handlePlan() {
    if (!analysis) return;
    if (!scriptFolder) {
      setError('No script folder configured for this customer. Set it in Customers → Edit.');
      return;
    }
    clearError();
    setLoading('plan');
    try {
      const result = await buildScriptPlan(
        analysis,
        scriptFolder,
        () => tauriApi.listDirectoryFiles(scriptFolder, 'js'),
        (path: string) => tauriApi.readFileContent(path),
      );
      setPlan(result);
      setSkeleton(null);
      updatePreview(null);
      setApplyResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  // --- Step 3: Skeleton ---

  function handleSkeleton() {
    if (!analysis || !plan) return;
    clearError();
    setLoading('skeleton');
    try {
      const result = generateSkeleton(analysis, plan);
      setSkeleton(result);
      updatePreview(null);
      setApplyResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  // --- Step 4: Preview ---

  async function handlePreview() {
    if (!analysis || !plan || !skeleton) return;
    clearError();
    setLoading('preview');
    try {
      const result = await buildScriptPreview(
        analysis,
        plan,
        skeleton,
        (path: string) => tauriApi.readFileContent(path),
      );
      updatePreview(result);
      setApplyResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  // --- Step 5: Apply ---

  async function handleApply() {
    if (!preview || preview.isNoop) return;
    clearError();
    setLoading('apply');
    try {
      await tauriApi.saveGeneratedFile(preview.targetFile, preview.newContent);
      setApplyResult({
        targetFile: preview.targetFile,
        targetFileName: preview.targetFileName,
        created: !preview.fileExists,
        updated: preview.fileExists,
        bytesWritten: new TextEncoder().encode(preview.newContent).length,
      });
      onDraftChange?.(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  // --- Open in VS Code ---
  // Opens the applied/existing target file, or falls back to the script folder.

  async function handleOpenVscode() {
    // After apply, the file definitely exists — use it directly.
    // Before apply, use target file only when known to exist.
    const targetPath =
      applyResult?.targetFile ??
      (plan?.fileExists ? plan.targetFile : null) ??
      scriptFolder;

    if (!targetPath) {
      setError('No script folder configured. Set it in Customers → Edit.');
      return;
    }
    try {
      await tauriApi.openInVscode(targetPath);
    } catch (e) {
      setError(String(e));
    }
  }

  // ---------------------------------------------------------------------------

  const vsCodeLabel = applyResult?.targetFileName
    ? `Open ${applyResult.targetFileName}`
    : plan?.fileExists
      ? `Open ${plan.targetFileName}`
      : plan
        ? 'Open script folder'
        : 'Open in VS Code';

  return (
    <div className="detail-action-group sa-panel">
      <div className="detail-action-group-label">
        <Icon name="file-text" size={12} /> Script Assistant
      </div>

      {/* Step buttons */}
      <div className="sa-step-row">
        <button
          className={`btn btn-sm ${analysis ? 'btn-secondary' : 'btn-primary'}`}
          onClick={handleAnalyze}
          disabled={loading === 'analyze'}
          title="Analyze task to infer entity, trigger, and operation"
        >
          {loading === 'analyze' ? <><span className="btn-spinner" /> Analyzing…</> : 'Analyze'}
        </button>

        <button
          className={`btn btn-sm ${plan ? 'btn-secondary' : analysis ? 'btn-primary' : 'btn-ghost'}`}
          onClick={handlePlan}
          disabled={!analysis || loading === 'plan'}
          title="Resolve target file and inspect existing handlers"
        >
          {loading === 'plan' ? <><span className="btn-spinner" /> Planning…</> : 'Plan'}
        </button>

        <button
          className={`btn btn-sm ${skeleton ? 'btn-secondary' : plan ? 'btn-primary' : 'btn-ghost'}`}
          onClick={handleSkeleton}
          disabled={!plan || loading === 'skeleton'}
          title="Generate code skeleton proposal"
        >
          {loading === 'skeleton' ? <><span className="btn-spinner" /> Generating…</> : 'Skeleton'}
        </button>

        <button
          className={`btn btn-sm ${preview ? 'btn-secondary' : skeleton ? 'btn-primary' : 'btn-ghost'}`}
          onClick={handlePreview}
          disabled={!skeleton || loading === 'preview'}
          title="Preview the exact file change that will be written"
        >
          {loading === 'preview' ? <><span className="btn-spinner" /> Previewing…</> : 'Preview'}
        </button>

        <button
          className={`btn btn-sm ${applyResult ? 'btn-secondary' : preview && !preview.isNoop ? 'btn-primary' : 'btn-ghost'}`}
          onClick={handleApply}
          disabled={!preview || preview.isNoop || !!applyResult || loading === 'apply'}
          title={preview?.isNoop ? 'No changes to apply' : 'Write the generated change to the repository'}
        >
          {loading === 'apply' ? <><span className="btn-spinner" /> Applying…</> : 'Apply'}
        </button>

        <button
          className="btn btn-sm btn-ghost"
          onClick={handleOpenVscode}
          disabled={!scriptFolder}
          title={vsCodeLabel}
        >
          <Icon name="terminal" size={12} /> VS Code
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="detail-fs-error sa-error">! {error}</div>
      )}

      {/* Analysis result */}
      {analysis && (
        <>
          {analysisIsRestored.current && !plan && (
            <div className="sa-restored-hint">Analysis restored — re-run Analyze to refresh, or continue with Plan.</div>
          )}
          <AnalysisDisplay analysis={analysis} />
        </>
      )}

      {/* Plan result */}
      {plan && (
        <PlanDisplay plan={plan} customer={customer} />
      )}

      {/* Skeleton — each section is individually copyable */}
      {skeleton && (
        <SkeletonDisplay skeleton={skeleton} />
      )}

      {/* Preview — shows exact file content that will be written */}
      {preview && (
        <PreviewDisplay preview={preview} />
      )}

      {/* Apply success message */}
      {applyResult && (
        <ApplySuccessDisplay result={applyResult} />
      )}
    </div>
  );
});
