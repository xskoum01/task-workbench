import { scanCSharpCrmReferences, scanJavaScriptCrmReferences } from './crmReferenceScanner';
import { describe, expect, it } from 'vitest';

function hasAttr(
  attributes: Record<string, string[]>,
  entity: string,
  attr: string,
): boolean {
  return (attributes[entity] ?? []).includes(attr);
}

describe('scanJavaScriptCrmReferences', () => {
  it('binds formContext.getAttribute("name") to account from nvr_account_events.js filename', () => {
    const content = 'formContext.getAttribute("name")?.getValue();';
    const result = scanJavaScriptCrmReferences(content, undefined, 'C:/scripts/nvr_account_events.js');
    expect(hasAttr(result.attributes, 'account', 'name')).toBe(true);
  });

  it('binds retrieveRecord $select fields to systemuser', () => {
    const content = 'await Xrm.WebApi.retrieveRecord("systemuser", id, "?$select=domainname,fullname");';
    const result = scanJavaScriptCrmReferences(content, undefined, 'C:/scripts/nvr_account_events.js');
    expect(hasAttr(result.attributes, 'systemuser', 'domainname')).toBe(true);
    expect(hasAttr(result.attributes, 'systemuser', 'fullname')).toBe(true);
  });

  it('keeps formContext and WebApi references separated by entity', () => {
    const content = [
      'formContext.getAttribute("name")?.getValue();',
      'await Xrm.WebApi.retrieveMultipleRecords("nvr_companyhierarchycompany", "?$select=nvr_company,nvr_erprelevant");',
    ].join('\n');
    const result = scanJavaScriptCrmReferences(content, undefined, 'C:/scripts/nvr_account_events.js');

    expect(hasAttr(result.attributes, 'account', 'name')).toBe(true);
    expect(hasAttr(result.attributes, 'nvr_companyhierarchycompany', 'nvr_company')).toBe(true);
    expect(hasAttr(result.attributes, 'nvr_companyhierarchycompany', 'nvr_erprelevant')).toBe(true);
    expect(hasAttr(result.attributes, 'account', 'nvr_company')).toBe(false);
  });

  it('does not assign unknown string literal to first WebApi entity', () => {
    const content = [
      'await Xrm.WebApi.retrieveMultipleRecords("nvr_companyhierarchycompany", "?$select=nvr_company");',
      'someFunction("nvr_unknown");',
    ].join('\n');
    const result = scanJavaScriptCrmReferences(content, undefined, 'C:/scripts/nvr_account_events.js');

    expect(hasAttr(result.attributes, 'nvr_companyhierarchycompany', 'nvr_unknown')).toBe(false);
    expect(result.attributes.account ?? []).not.toContain('nvr_unknown');
  });
});

describe('scanCSharpCrmReferences', () => {
  it('binds new Entity and indexer assignment to contact.ownerid', () => {
    const content = [
      'var updateContact = new Entity("contact");',
      'updateContact["ownerid"] = new EntityReference("systemuser", ownerId);',
    ].join('\n');
    const result = scanCSharpCrmReferences(content);
    expect(hasAttr(result.attributes, 'contact', 'ownerid')).toBe(true);
  });

  it('binds service.Retrieve result attribute access to contact.fullname', () => {
    const content = [
      'var contact = service.Retrieve("contact", id, new ColumnSet("fullname"));',
      'contact.GetAttributeValue<string>("fullname");',
    ].join('\n');
    const result = scanCSharpCrmReferences(content);
    expect(hasAttr(result.attributes, 'contact', 'fullname')).toBe(true);
  });

  it('binds query result entity extraction to systemuser.domainname', () => {
    const content = [
      'var query = new QueryExpression("systemuser");',
      'query.ColumnSet = new ColumnSet("domainname");',
      'var result = service.RetrieveMultiple(query);',
      'var owner = result.Entities.FirstOrDefault();',
      'owner.GetAttributeValue<string>("domainname");',
    ].join('\n');
    const result = scanCSharpCrmReferences(content);
    expect(hasAttr(result.attributes, 'systemuser', 'domainname')).toBe(true);
  });

  it('keeps ExtendedContextEntity attribute ambiguous without primary override', () => {
    const content = 'ExtendedContextEntity.GetAttributeValue<string>("nvr_registrationno");';
    const result = scanCSharpCrmReferences(content);
    expect(hasAttr(result.attributes, 'account', 'nvr_registrationno')).toBe(false);
    expect(result.ambiguousAttributes).toContain('nvr_registrationno');
  });

  it('binds ExtendedContextEntity to account when primary override is provided', () => {
    const content = 'ExtendedContextEntity.GetAttributeValue<string>("nvr_registrationno");';
    const result = scanCSharpCrmReferences(content, 'account');
    expect(hasAttr(result.attributes, 'account', 'nvr_registrationno')).toBe(true);
  });
});
