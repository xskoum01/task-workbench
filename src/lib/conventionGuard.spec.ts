import { describe, expect, it } from 'vitest';
import { checkCrmJavaScriptConventions } from './conventionGuard';

// ---------------------------------------------------------------------------
// Early-return blocking violations
// ---------------------------------------------------------------------------

describe('checkCrmJavaScriptConventions — blocking violations', () => {
  it('blocks bare return; introduced in proposed content', () => {
    const proposed = `function accountOnCustomerTypeChange(executionContext) {
  var formContext = executionContext.getFormContext();
  var attr = formContext.getAttribute("nvr_customertype");
  return;
}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule).toBe('no-early-return');
    expect(result.violations[0].matchedLines.some((l) => l.trim() === 'return;')).toBe(true);
  });

  it('blocks if (...) return; guard clause', () => {
    const proposed = `function foo(ctx) {
  var x = ctx.getFormContext().getAttribute("nvr_x");
  if (!x) return;
  x.setValue(1);
}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(true);
    expect(result.violations[0].matchedLines.some((l) => /if.*return/.test(l))).toBe(true);
  });

  it('blocks if (...) { return; } guard clause', () => {
    const proposed = `function foo(ctx) {
  if (!ctx) { return; }
  ctx.setValue(1);
}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(true);
  });

  it('blocks multi-attribute guard-clause pattern (return; inside multi-line if)', () => {
    // This is the exact pattern from the reported violation
    const proposed = `function accountOnCustomerTypeChange(executionContext) {
  var formContext = executionContext.getFormContext();
  var customerTypeAttr = formContext.getAttribute("nvr_customertype");
  var vatNumberControl = formContext.getControl("nvr_vatnumber");
  var vatNumberAttr = formContext.getAttribute("nvr_vatnumber");
  if (!customerTypeAttr || !vatNumberControl || !vatNumberAttr) {
    return;
  }
  var customerType = customerTypeAttr.getValue();
  if (customerType === 917680000) {
    vatNumberControl.setVisible(true);
  } else {
    vatNumberControl.setVisible(false);
    vatNumberAttr.setValue(null);
  }
}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(true);
    // The `return;` inside the multi-line if is caught via the bare-return pattern
    expect(result.violations[0].matchedLines.some((l) => l.trim() === 'return;')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Passing content — no violations
// ---------------------------------------------------------------------------

describe('checkCrmJavaScriptConventions — passing content', () => {
  it('passes positive if/else branching without early return', () => {
    const proposed = `function accountOnCustomerTypeChange(executionContext) {
  var formContext = executionContext.getFormContext();
  var customerTypeAttr = formContext.getAttribute("nvr_customertype");
  var vatNumberControl = formContext.getControl("nvr_vatnumber");
  var vatNumberAttr = formContext.getAttribute("nvr_vatnumber");
  if (customerTypeAttr && vatNumberControl && vatNumberAttr) {
    var customerType = customerTypeAttr.getValue();
    if (customerType === 917680000) {
      vatNumberControl.setVisible(true);
    } else {
      vatNumberControl.setVisible(false);
      vatNumberAttr.setValue(null);
    }
  }
}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(result.feedbackForRegeneration).toBe('');
  });

  it('passes content with return value (non-void return is not a violation)', () => {
    const proposed = `function getCustomerType(formContext) {
  var attr = formContext.getAttribute("nvr_customertype");
  if (attr) {
    return attr.getValue();
  }
  return null;
}`;
    // return null; is not void return — not matched by the pattern
    // return attr.getValue(); is also not void — not matched
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.hasBlockingViolations).toBe(false);
  });

  it('passes empty proposed content', () => {
    const result = checkCrmJavaScriptConventions('', '');
    expect(result.hasBlockingViolations).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing content exclusion
// ---------------------------------------------------------------------------

describe('checkCrmJavaScriptConventions — existing content exclusion', () => {
  it('does not block existing unchanged early return', () => {
    const existing = `function foo(ctx) {
  var x = ctx.getFormContext().getAttribute("nvr_x");
  return;
}`;
    // Proposed is identical — AI just kept existing code unchanged
    const proposed = existing;
    const result = checkCrmJavaScriptConventions(proposed, existing);
    expect(result.hasBlockingViolations).toBe(false);
  });

  it('does not block when existing and proposed have same count of return;', () => {
    const existing = `function a() { return; }`;
    const proposed = `function a() { return; }\nfunction b() { /* no return */ }`;
    const result = checkCrmJavaScriptConventions(proposed, existing);
    expect(result.hasBlockingViolations).toBe(false);
  });

  it('blocks when proposed introduces MORE early returns than existing', () => {
    const existing = `function a(ctx) {\n  return;\n}`;
    const proposed = `function a(ctx) {\n  return;\n}\nfunction b(ctx) {\n  return;\n}`;
    const result = checkCrmJavaScriptConventions(proposed, existing);
    expect(result.hasBlockingViolations).toBe(true);
    expect(result.violations[0].matchedLines).toHaveLength(1);
  });

  it('blocks when proposed adds new early return even when existing has one', () => {
    const existing = `function a() {\n  if (!x) return;\n}`;
    const proposed = `function a() {\n  if (!x) return;\n}\nfunction b() {\n  if (!y) return;\n}`;
    const result = checkCrmJavaScriptConventions(proposed, existing);
    expect(result.hasBlockingViolations).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feedback for regeneration
// ---------------------------------------------------------------------------

describe('checkCrmJavaScriptConventions — feedback', () => {
  it('feedbackForRegeneration includes the exact violation line', () => {
    const proposed = `function foo() {\n  if (!x) return;\n}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.feedbackForRegeneration).toContain('if (!x) return;');
    expect(result.feedbackForRegeneration).toMatch(/regenerate/i);
    expect(result.feedbackForRegeneration).toMatch(/early return/i);
  });

  it('feedbackForRegeneration is empty when no violations', () => {
    const proposed = `function foo() {\n  if (x) { x.setValue(1); }\n}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.feedbackForRegeneration).toBe('');
  });

  it('feedbackForRegeneration includes all violation lines when multiple present', () => {
    const proposed = `function a() {\n  return;\n}\nfunction b() {\n  return;\n}`;
    const result = checkCrmJavaScriptConventions(proposed, '');
    expect(result.violations[0].matchedLines).toHaveLength(2);
    expect(result.feedbackForRegeneration.match(/return;/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
