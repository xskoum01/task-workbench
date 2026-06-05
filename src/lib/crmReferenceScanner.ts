import type {
  CrmAmbiguousReference,
  CrmDetectedAttributeReference,
  CrmDetectedEntityReference,
  CrmDetectedRelationshipReference,
  CrmPluginScanInfo,
  CrmRawExtractedReferences,
} from '../types';

export interface CrmReferenceScanResult extends CrmRawExtractedReferences {
  ambiguousAttributes: string[];
}

function inferPrimaryEntityFromFilePath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  const noExt = name.replace(/\.[a-z0-9]+$/i, '');
  const tokenMatch = noExt.match(/(?:^|_)(account|contact|systemuser|lead|opportunity|incident|case)(?:_|$)/i);
  if (tokenMatch) {
    return tokenMatch[1].toLowerCase();
  }
  return undefined;
}

interface LinkContext {
  targetEntity: string;
  sourceEntity?: string;
  fromAttribute?: string;
  toAttribute?: string;
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function ensureEntityBucket(map: Record<string, string[]>, entity: string) {
  if (!map[entity]) map[entity] = [];
}

function pushEntityAttr(map: Record<string, string[]>, entity: string, attr: string) {
  if (!entity || !attr) return;
  ensureEntityBucket(map, entity);
  if (!map[entity].includes(attr)) {
    map[entity].push(attr);
  }
}

function normalizeLogicalName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^[a-z][a-z0-9_]{1,79}$/.test(trimmed) ? trimmed : undefined;
}

function parseLogicalNameList(fragment: string): string[] {
  const matches = fragment.match(/"([a-z][a-z0-9_]{1,79})"/g) ?? [];
  return uniq(matches.map((m) => normalizeLogicalName(m.slice(1, -1)) ?? '').filter(Boolean));
}

function pushEntityReference(
  entityReferences: CrmDetectedEntityReference[],
  logicalName: string | undefined,
  sourceReason: string,
  contextType: string,
  variableName?: string,
) {
  const entity = normalizeLogicalName(logicalName);
  if (!entity) return;
  const key = `${entity}|${contextType}|${variableName ?? ''}|${sourceReason}`;
  if (!entityReferences.some((item) => `${item.logicalName}|${item.contextType}|${item.variableName ?? ''}|${item.sourceReason}` === key)) {
    entityReferences.push({ logicalName: entity, sourceReason, contextType, variableName });
  }
}

function pushAttributeReference(
  attributeReferences: CrmDetectedAttributeReference[],
  logicalName: string | undefined,
  entityLogicalName: string | undefined,
  sourceReason: string,
  contextType: string,
  variableName?: string,
  relatedEntityLogicalName?: string,
  optionValues?: number[],
) {
  const attr = normalizeLogicalName(logicalName);
  if (!attr) return;
  const key = [attr, entityLogicalName ?? '', contextType, variableName ?? '', relatedEntityLogicalName ?? '', sourceReason, (optionValues ?? []).join(',')].join('|');
  if (!attributeReferences.some((item) => [item.logicalName, item.entityLogicalName ?? '', item.contextType, item.variableName ?? '', item.relatedEntityLogicalName ?? '', item.sourceReason, (item.optionValues ?? []).join(',')].join('|') === key)) {
    attributeReferences.push({
      logicalName: attr,
      entityLogicalName,
      sourceReason,
      contextType,
      variableName,
      relatedEntityLogicalName,
      optionValues: optionValues?.length ? uniq(optionValues.map(String)).map(Number) : undefined,
    });
  }
}

function pushRelationshipReference(
  relationshipReferences: CrmDetectedRelationshipReference[],
  sourceEntityLogicalName: string | undefined,
  sourceAttributeLogicalName: string | undefined,
  targetEntityLogicalName: string | undefined,
  targetAttributeLogicalName: string | undefined,
  sourceReason: string,
  contextType: string,
  variableName?: string,
) {
  const fromAttr = normalizeLogicalName(sourceAttributeLogicalName);
  const toAttr = normalizeLogicalName(targetAttributeLogicalName);
  if (!fromAttr || !toAttr) return;
  const key = [sourceEntityLogicalName ?? '', fromAttr, targetEntityLogicalName ?? '', toAttr, sourceReason, contextType, variableName ?? ''].join('|');
  if (!relationshipReferences.some((item) => [item.sourceEntityLogicalName ?? '', item.sourceAttributeLogicalName, item.targetEntityLogicalName ?? '', item.targetAttributeLogicalName, item.sourceReason, item.contextType, item.variableName ?? ''].join('|') === key)) {
    relationshipReferences.push({
      sourceEntityLogicalName,
      sourceAttributeLogicalName: fromAttr,
      targetEntityLogicalName,
      targetAttributeLogicalName: toAttr,
      sourceReason,
      contextType,
      variableName,
    });
  }
}

function pushAmbiguousReference(
  ambiguousReferences: CrmAmbiguousReference[],
  kind: CrmAmbiguousReference['kind'],
  logicalName: string | undefined,
  sourceReason: string,
  detail: string,
  entityLogicalName?: string,
  relatedEntityLogicalName?: string,
) {
  const normalized = normalizeLogicalName(logicalName) ?? logicalName?.trim();
  if (!normalized) return;
  const key = [kind, normalized, sourceReason, detail, entityLogicalName ?? '', relatedEntityLogicalName ?? ''].join('|');
  if (!ambiguousReferences.some((item) => [item.kind, item.logicalName, item.sourceReason, item.detail, item.entityLogicalName ?? '', item.relatedEntityLogicalName ?? ''].join('|') === key)) {
    ambiguousReferences.push({ kind, logicalName: normalized, sourceReason, detail, entityLogicalName, relatedEntityLogicalName });
  }
}

function buildAttributesMap(attributeReferences: CrmDetectedAttributeReference[]): Record<string, string[]> {
  const attributes: Record<string, string[]> = {};
  attributeReferences.forEach((ref) => {
    if (ref.entityLogicalName) {
      pushEntityAttr(attributes, ref.entityLogicalName, ref.logicalName);
    }
  });
  return attributes;
}

export function scanJavaScriptCrmReferences(content: string, fallbackEntity?: string, filePath?: string): CrmReferenceScanResult {
  const notes: string[] = [];
  const entityReferences: CrmDetectedEntityReference[] = [];
  const attributeReferences: CrmDetectedAttributeReference[] = [];
  const relationshipReferences: CrmDetectedRelationshipReference[] = [];
  const ambiguousReferences: CrmAmbiguousReference[] = [];

  const webApiEntityByVariable = new Map<string, string>();

  const primaryFormEntity = fallbackEntity || inferPrimaryEntityFromFilePath(filePath);
  if (primaryFormEntity) {
    pushEntityReference(entityReferences, primaryFormEntity, 'from primary form entity inference', 'primary_form_entity');
    notes.push(`Primary form entity: ${primaryFormEntity}.`);
  }

  const retrieveRecordRe = /Xrm\.WebApi\.retrieveRecord\(\s*["']([a-z][a-z0-9_]+)["']/g;
  for (const m of content.matchAll(retrieveRecordRe)) {
    pushEntityReference(entityReferences, m[1], 'from Xrm.WebApi.retrieveRecord', 'retrieveRecord');
  }

  const retrieveManyRe = /Xrm\.WebApi\.retrieveMultipleRecords\(\s*["']([a-z][a-z0-9_]+)["']/g;
  for (const m of content.matchAll(retrieveManyRe)) {
    pushEntityReference(entityReferences, m[1], 'from Xrm.WebApi.retrieveMultipleRecords', 'retrieveMultipleRecords');
  }

  for (const m of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+Xrm\.WebApi\.retrieveRecord\(\s*["']([a-z][a-z0-9_]+)["']/g)) {
    webApiEntityByVariable.set(m[1], m[2]);
  }
  for (const m of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+Xrm\.WebApi\.retrieveMultipleRecords\(\s*["']([a-z][a-z0-9_]+)["']/g)) {
    webApiEntityByVariable.set(m[1], m[2]);
  }

  const defaultEntity = primaryFormEntity;

  const pushQueryAttributes = (
    rawQuery: string,
    entity: string | undefined,
    sourcePrefix: string,
  ) => {
    const decoded = decodeURIComponent(rawQuery.replace(/^\?/, ''));

    const selectMatch = decoded.match(/(?:^|&)\$select=([^&]+)/i);
    if (selectMatch) {
      const fields = selectMatch[1].split(',').map((f) => f.trim()).filter(Boolean);
      for (const field of fields) {
        if (entity) {
          pushAttributeReference(attributeReferences, field, entity, `${sourcePrefix} $select`, '$select');
        } else {
          pushAmbiguousReference(ambiguousReferences, 'attribute', field, `${sourcePrefix} $select`, 'Could not infer entity for this $select attribute.');
        }
      }
    }

    const filterMatch = decoded.match(/(?:^|&)\$filter=([^&]+)/i);
    if (filterMatch) {
      const filter = filterMatch[1];
      const fieldRe = /\b([a-z][a-z0-9_]+)\s+(?:eq|ne|gt|ge|lt|le|contains|startswith|endswith)\b/gi;
      for (const fm of filter.matchAll(fieldRe)) {
        if (entity) {
          pushAttributeReference(attributeReferences, fm[1], entity, `${sourcePrefix} $filter`, '$filter');
        } else {
          pushAmbiguousReference(ambiguousReferences, 'attribute', fm[1], `${sourcePrefix} $filter`, 'Could not infer entity for this $filter attribute.');
        }
      }
    }

    const expandRe = /\$expand=([a-z][a-z0-9_]+)\(([^\)]*)\)/gi;
    for (const expand of decoded.matchAll(expandRe)) {
      const expandEntity = expand[1];
      pushEntityReference(entityReferences, expandEntity, `${sourcePrefix} $expand`, '$expand');
      const inner = expand[2];
      const innerSelect = inner.match(/\$select=([^;]+)/i);
      if (innerSelect) {
        const fields = innerSelect[1].split(',').map((f) => f.trim()).filter(Boolean);
        for (const field of fields) {
          pushAttributeReference(attributeReferences, field, expandEntity, `${sourcePrefix} $expand $select`, '$expand', undefined, entity);
        }
      }
    }
  };

  for (const m of content.matchAll(/Xrm\.WebApi\.retrieveRecord\(\s*["']([a-z][a-z0-9_]+)["']\s*,\s*[^,]+\s*,\s*["']([^"']+)["']/g)) {
    pushQueryAttributes(m[2], m[1], `from Xrm.WebApi.retrieveRecord ${m[1]}`);
  }
  for (const m of content.matchAll(/Xrm\.WebApi\.retrieveMultipleRecords\(\s*["']([a-z][a-z0-9_]+)["']\s*,\s*["']([^"']+)["']/g)) {
    pushQueryAttributes(m[2], m[1], `from Xrm.WebApi.retrieveMultipleRecords ${m[1]}`);
  }

  const formAttrRe = /formContext\.(?:getAttribute|getControl)\(\s*["']([a-z][a-z0-9_]+)["']\s*\)/g;
  for (const m of content.matchAll(formAttrRe)) {
    const attr = m[1];
    if (defaultEntity) {
        pushAttributeReference(attributeReferences, attr, defaultEntity, 'from formContext.getAttribute/getControl on primary form entity', 'formContext');
    } else {
      pushAmbiguousReference(ambiguousReferences, 'attribute', attr, 'from formContext.getAttribute/getControl', 'Could not infer the primary form entity for this formContext attribute.');
    }
  }

  for (const m of content.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\?\.\s*entities\s*\?\.\s*map\(\s*\(?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const collectionVar = m[1];
    const itemVar = m[2];
    const entity = webApiEntityByVariable.get(collectionVar);
    if (entity) {
      webApiEntityByVariable.set(itemVar, entity);
    }
  }

  for (const m of content.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\?\.\s*([a-z][a-z0-9_]{1,79})\b/g)) {
    const ownerVar = m[1];
    const attr = m[2];
    const entity = webApiEntityByVariable.get(ownerVar);
    if (entity) {
      pushAttributeReference(attributeReferences, attr, entity, `from ${ownerVar}?.${attr} (WebApi result)`, 'webapi_result', ownerVar);
    }
  }

  if (!entityReferences.length && primaryFormEntity) {
    pushEntityReference(entityReferences, primaryFormEntity, 'from workflow setup fallback', 'fallback');
    notes.push('No explicit WebApi entity found; used fallback entity from workflow setup.');
  }

  const attributes = buildAttributesMap(attributeReferences);

  return {
    entities: uniq(entityReferences.map((item) => item.logicalName).concat(Object.keys(attributes))),
    attributes,
    ambiguousAttributes: uniq(ambiguousReferences.filter((item) => item.kind === 'attribute').map((item) => item.logicalName)),
    notes,
    entityReferences,
    attributeReferences,
    relationshipReferences,
    ambiguousReferences,
  };
}

export function scanCSharpCrmReferences(content: string, primaryEntityOverride?: string): CrmReferenceScanResult {
  const lines = content.split(/\r?\n/);
  const notes: string[] = [];
  const entityReferences: CrmDetectedEntityReference[] = [];
  const attributeReferences: CrmDetectedAttributeReference[] = [];
  const relationshipReferences: CrmDetectedRelationshipReference[] = [];
  const ambiguousReferences: CrmAmbiguousReference[] = [];

  const entityVarMap = new Map<string, string>();
  const queryVarMap = new Map<string, string>();
  const linkVarMap = new Map<string, LinkContext>();
  const filterVarMap = new Map<string, string>();
  const targetVars = new Set<string>(['target', 'Target']);
  const imageVarMap = new Map<string, 'pre' | 'post'>();
  const pluginMessages = new Set<string>();
  const targetAttributes = new Set<string>();
  const filteringAttributes = new Set<string>();
  const imageAttributes: Record<string, string[]> = { pre: [], post: [] };
  let primaryEntityName: string | undefined = normalizeLogicalName(primaryEntityOverride);
  let primaryEntitySource: CrmPluginScanInfo['primaryEntitySource'] = primaryEntityName ? 'manual_override' : 'unknown';

  const lowerCaseEntityHints = new Map<string, string | null>();
  const rememberEntityVar = (variableName: string, entityName: string) => {
    const logical = normalizeLogicalName(entityName);
    if (!logical) return;
    entityVarMap.set(variableName, logical);
    const lower = variableName.toLowerCase();
    const existing = lowerCaseEntityHints.get(lower);
    if (!existing) {
      lowerCaseEntityHints.set(lower, logical);
    } else if (existing !== logical) {
      lowerCaseEntityHints.set(lower, null);
    }
  };
  const rememberQueryVar = (variableName: string, entityName: string) => {
    const logical = normalizeLogicalName(entityName);
    if (!logical) return;
    queryVarMap.set(variableName, logical);
    const lower = variableName.toLowerCase();
    const existing = lowerCaseEntityHints.get(lower);
    if (!existing) {
      lowerCaseEntityHints.set(lower, logical);
    } else if (existing !== logical) {
      lowerCaseEntityHints.set(lower, null);
    }
  };
  const resolveEntityForVariable = (variableName: string): string | undefined => {
    const exact = entityVarMap.get(variableName)
      ?? queryVarMap.get(variableName)
      ?? linkVarMap.get(variableName)?.targetEntity
      ?? filterVarMap.get(variableName);
    if (exact) return exact;
    const lower = lowerCaseEntityHints.get(variableName.toLowerCase());
    if (lower) return lower;
    return undefined;
  };

  const primaryContextVars = new Set<string>([
    'target',
    'contextentity',
    'extendedcontextentity',
    'entity',
    'preimage',
    'postimage',
  ]);

  const setPrimaryEntity = (candidate: string | undefined, source: CrmPluginScanInfo['primaryEntitySource']) => {
    const logical = normalizeLogicalName(candidate);
    if (!logical) return;
    if (!primaryEntityName) {
      primaryEntityName = logical;
      primaryEntitySource = source;
      return;
    }
    if (primaryEntityName === logical) {
      if (primaryEntitySource !== 'manual_override') {
        primaryEntitySource = source;
      }
      return;
    }
    if (primaryEntitySource !== 'manual_override') {
      notes.push(`Conflicting primary entity hints detected (${primaryEntityName} vs ${logical}); keeping '${primaryEntityName}'.`);
    }
  };

  if (primaryEntityName) {
    pushEntityReference(entityReferences, primaryEntityName, 'from manual primary entity override', 'primary_entity_manual_override');
  }

  const pushAttrForVariable = (
    variableName: string,
    attr: string,
    sourceReason: string,
    contextType: string,
    optionValues?: number[],
  ) => {
    const logicalName = normalizeLogicalName(attr);
    if (!logicalName) return;

    const entity = resolveEntityForVariable(variableName)
      ?? ((targetVars.has(variableName)
        || imageVarMap.has(variableName)
        || primaryContextVars.has(variableName.toLowerCase())) ? primaryEntityName : undefined);

    if (targetVars.has(variableName) || primaryContextVars.has(variableName.toLowerCase())) {
      targetAttributes.add(logicalName);
      filteringAttributes.add(logicalName);
    }

    if (imageVarMap.has(variableName)) {
      const bucket = imageVarMap.get(variableName) === 'post' ? 'post' : 'pre';
      imageAttributes[bucket] = uniq([...imageAttributes[bucket], logicalName]);
    }

    if (entity) {
      pushAttributeReference(attributeReferences, logicalName, entity, sourceReason, contextType, variableName, undefined, optionValues);
    } else {
      pushAmbiguousReference(
        ambiguousReferences,
        'attribute',
        logicalName,
        sourceReason,
        'Could not infer the entity for this attribute reference.',
      );
    }
  };

  const pushColumnSetForOwner = (owner: string, attrs: string[], reasonPrefix: string) => {
    attrs.forEach((attr) => pushAttrForVariable(owner, attr, `${reasonPrefix} ColumnSet`, 'column_set'));
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const primaryFromLogicalName = trimmed.match(/(?:Target|target|context\.PrimaryEntityName|PrimaryEntityName|(?:target|Target)\.LogicalName)\s*(?:==|!=)\s*"([a-z][a-z0-9_]+)"/);
    if (primaryFromLogicalName) {
      setPrimaryEntity(primaryFromLogicalName[1], 'inferred');
      pushEntityReference(entityReferences, primaryFromLogicalName[1], 'from Target.LogicalName/context.PrimaryEntityName check', 'primary_entity');
    }

    for (const match of trimmed.matchAll(/context\.MessageName\s*(?:==|!=)\s*"([A-Za-z]+)"/g)) {
      pluginMessages.add(match[1]);
    }

    const targetAssign = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(?Entity\)?\s*context\.InputParameters\["Target"\]/);
    if (targetAssign) {
      targetVars.add(targetAssign[1]);
      if (primaryEntityName) {
        rememberEntityVar(targetAssign[1], primaryEntityName);
      }
    }

    const preImageAssign = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*context\.PreEntityImages\[[^\]]+\]/);
    if (preImageAssign) {
      imageVarMap.set(preImageAssign[1], 'pre');
      if (primaryEntityName) {
        rememberEntityVar(preImageAssign[1], primaryEntityName);
      }
    }
    const postImageAssign = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*context\.PostEntityImages\[[^\]]+\]/);
    if (postImageAssign) {
      imageVarMap.set(postImageAssign[1], 'post');
      if (primaryEntityName) {
        rememberEntityVar(postImageAssign[1], primaryEntityName);
      }
    }

    const newEntityMatch = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+Entity\("([a-z][a-z0-9_]+)"\)/);
    if (newEntityMatch) {
      rememberEntityVar(newEntityMatch[1], newEntityMatch[2]);
      pushEntityReference(entityReferences, newEntityMatch[2], `from new Entity assigned to ${newEntityMatch[1]}`, 'entity', newEntityMatch[1]);
      const variableName = newEntityMatch[1].toLowerCase();
      if (variableName === 'target' || variableName === 'entity' || variableName === 'contextentity' || variableName === 'extendedcontextentity' || variableName.startsWith('update')) {
        setPrimaryEntity(newEntityMatch[2], 'inferred');
      }
    }

    const entityReferenceMatch = trimmed.match(/(?:EntityReference\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+EntityReference\("([a-z][a-z0-9_]+)"/);
    if (entityReferenceMatch) {
      rememberEntityVar(entityReferenceMatch[1], entityReferenceMatch[2]);
      pushEntityReference(entityReferences, entityReferenceMatch[2], `from new EntityReference assigned to ${entityReferenceMatch[1]}`, 'entity_reference', entityReferenceMatch[1]);
    }

    const queryMatch = trimmed.match(/(?:QueryExpression\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+QueryExpression\("([a-z][a-z0-9_]+)"\)/);
    if (queryMatch) {
      rememberQueryVar(queryMatch[1], queryMatch[2]);
      pushEntityReference(entityReferences, queryMatch[2], `from QueryExpression ${queryMatch[1]}`, 'query_expression', queryMatch[1]);
    }

    const retrieveMatch = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*service\.Retrieve\("([a-z][a-z0-9_]+)"/);
    if (retrieveMatch) {
      rememberEntityVar(retrieveMatch[1], retrieveMatch[2]);
      pushEntityReference(entityReferences, retrieveMatch[2], `from service.Retrieve into ${retrieveMatch[1]}`, 'retrieve', retrieveMatch[1]);
      const columnSetMatch = trimmed.match(/service\.Retrieve\([^\)]*new\s+ColumnSet\(([^\)]*)\)/);
      if (columnSetMatch) {
        parseLogicalNameList(columnSetMatch[1]).forEach((attr) => pushAttributeReference(attributeReferences, attr, retrieveMatch[2], `from service.Retrieve ColumnSet on ${retrieveMatch[2]}`, 'column_set', retrieveMatch[1]));
      }
    }

    const retrieveMultipleInlineMatch = trimmed.match(/service\.RetrieveMultiple\(\s*new\s+QueryExpression\("([a-z][a-z0-9_]+)"\)/);
    if (retrieveMultipleInlineMatch) {
      const entity = retrieveMultipleInlineMatch[1];
      pushEntityReference(entityReferences, entity, 'from inline QueryExpression in RetrieveMultiple', 'query_expression');
      const inlineColumnSet = trimmed.match(/ColumnSet\s*=\s*new\s+ColumnSet\(([^\)]*)\)/);
      if (inlineColumnSet) {
        parseLogicalNameList(inlineColumnSet[1]).forEach((attr) => pushAttributeReference(attributeReferences, attr, entity, `from inline QueryExpression ${entity} ColumnSet`, 'column_set'));
      }
    }

    // Track service.RetrieveMultiple(knownQueryVar) result into an EntityCollection variable.
    // Allows attributes accessed later from the collection to be bound to the correct entity.
    const retrieveMultipleVarMatch = trimmed.match(/(?:EntityCollection\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:[A-Za-z_][A-Za-z0-9_]*)\.RetrieveMultiple\(([A-Za-z_][A-Za-z0-9_]*)\)/);
    if (retrieveMultipleVarMatch && !retrieveMultipleInlineMatch) {
      const [, resultVar, queryVar] = retrieveMultipleVarMatch;
      const queryEntity = resolveEntityForVariable(queryVar);
      if (queryEntity) {
        // Map the EntityCollection result variable to the same entity as the query.
        rememberEntityVar(resultVar, queryEntity);
      }
    }

    // Track entity variable assigned from EntityCollection.Entities[...] or .FirstOrDefault() etc.
    const entityFromCollectionMatch = trimmed.match(/(?:Entity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.Entities(?:\[\d+\]|\.FirstOrDefault\(\)|\.First\(\)|\.LastOrDefault\(\)|\.SingleOrDefault\(\)|\.Single\(\)|\.ElementAtOrDefault\(\d+\))?/);
    if (entityFromCollectionMatch) {
      const [, entityVar, collectionVar] = entityFromCollectionMatch;
      const collectionEntity = resolveEntityForVariable(collectionVar);
      if (collectionEntity) {
        rememberEntityVar(entityVar, collectionEntity);
      }
    }

    const directAliasMatch = trimmed.match(/(?:Entity\s+|EntityReference\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (directAliasMatch) {
      const [, lhs, rhs] = directAliasMatch;
      const rhsEntity = resolveEntityForVariable(rhs)
        ?? ((targetVars.has(rhs) || primaryContextVars.has(rhs.toLowerCase())) ? primaryEntityName : undefined);
      if (rhsEntity) {
        rememberEntityVar(lhs, rhsEntity);
      }
    }

    const fetchEntityMatch = trimmed.match(/new\s+FetchExpression\((?:@)?"([\s\S]*)"\)/);
    if (fetchEntityMatch) {
      const entityMatch = fetchEntityMatch[1].match(/<entity\s+name=['"]([a-z][a-z0-9_]+)['"]/);
      if (entityMatch) {
        pushEntityReference(entityReferences, entityMatch[1], 'from FetchExpression entity', 'fetch_expression');
      }
    }

    const addLinkMatch = trimmed.match(/(?:LinkEntity\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.AddLink\("([a-z][a-z0-9_]+)",\s*"([a-z][a-z0-9_]+)",\s*"([a-z][a-z0-9_]+)"/);
    if (addLinkMatch) {
      const [, linkVar, ownerVar, targetEntity, fromAttr, toAttr] = addLinkMatch;
      const sourceEntity = queryVarMap.get(ownerVar) ?? linkVarMap.get(ownerVar)?.targetEntity;
      linkVarMap.set(linkVar, { targetEntity, sourceEntity, fromAttribute: fromAttr, toAttribute: toAttr });
      pushEntityReference(entityReferences, targetEntity, `from LinkEntity ${linkVar}`, 'link_entity', linkVar);
      pushRelationshipReference(relationshipReferences, sourceEntity, fromAttr, targetEntity, toAttr, `from LinkEntity ${linkVar}`, 'link_entity', linkVar);
      pushAttributeReference(attributeReferences, fromAttr, sourceEntity, `from LinkEntity ${linkVar} source attribute`, 'link_entity', linkVar, targetEntity);
      pushAttributeReference(attributeReferences, toAttr, targetEntity, `from LinkEntity ${linkVar} target attribute`, 'link_entity', linkVar, sourceEntity);
    }

    const filterAssign = trimmed.match(/(?:FilterExpression\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.(?:Criteria|LinkCriteria)/);
    if (filterAssign) {
      const [, filterVar, ownerVar] = filterAssign;
      const entity = resolveEntityForVariable(ownerVar) ?? linkVarMap.get(ownerVar)?.targetEntity;
      if (entity) filterVarMap.set(filterVar, entity);
    }

    const queryColumnSetMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*)\.ColumnSet\s*=\s*new\s+ColumnSet\(([^\)]*)\)/);
    if (queryColumnSetMatch) {
      pushColumnSetForOwner(queryColumnSetMatch[1], parseLogicalNameList(queryColumnSetMatch[2]), `from ${queryColumnSetMatch[1]}`);
    }

    const linkColumnsMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*)\.Columns\s*=\s*new\s+ColumnSet\(([^\)]*)\)/);
    if (linkColumnsMatch) {
      pushColumnSetForOwner(linkColumnsMatch[1], parseLogicalNameList(linkColumnsMatch[2]), `from ${linkColumnsMatch[1]}`);
    }

    // AddColumn("attr") / AddColumns("a", "b") on ColumnSet or Columns property.
    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.(?:ColumnSet|Columns)\.AddColumn\("([a-z][a-z0-9_]+)"\)/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.ColumnSet.AddColumn`, 'column_set');
    }
    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.(?:ColumnSet|Columns)\.AddColumns\(([^)]*)\)/g)) {
      parseLogicalNameList(match[2]).forEach((attr) => pushAttrForVariable(match[1], attr, `from ${match[1]}.ColumnSet.AddColumns`, 'column_set'));
    }

    // entity.Attributes["attr"] access pattern (indexer on Attributes property).
    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.Attributes\["([a-z][a-z0-9_]+)"\]/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.Attributes["${match[2]}"]`, 'indexer');
    }

    // filterVar.Conditions.Add(new ConditionExpression("attr", ...))
    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.Conditions\.Add\(\s*new\s+ConditionExpression\("([a-z][a-z0-9_]+)"/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.Conditions.Add ConditionExpression`, 'condition');
    }

    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.GetAttributeValue<[^>]+>\("([a-z][a-z0-9_]+)"\)/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.GetAttributeValue`, 'get_attribute_value');
    }

    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.Contains\("([a-z][a-z0-9_]+)"\)/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.Contains`, 'contains');
    }

    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\["([a-z][a-z0-9_]+)"\]/g)) {
      pushAttrForVariable(match[1], match[2], `from ${match[1]}["${match[2]}"]`, 'indexer');
    }

    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.(?:Criteria|LinkCriteria)\.AddCondition\("([a-z][a-z0-9_]+)"(?:,[^\)]*?,\s*(\d+))?/g)) {
      const optionValues = match[3] ? [Number(match[3])] : undefined;
      pushAttrForVariable(match[1], match[2], `from ${match[1]} criteria condition`, 'condition', optionValues);
    }

    for (const match of trimmed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.AddCondition\("([a-z][a-z0-9_]+)"(?:,[^\)]*?,\s*(\d+))?/g)) {
      const optionValues = match[3] ? [Number(match[3])] : undefined;
      pushAttrForVariable(match[1], match[2], `from ${match[1]}.AddCondition`, 'condition', optionValues);
    }

    const orderMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*)\.[^\n]*OrderExpression\("([a-z][a-z0-9_]+)"/);
    if (orderMatch) {
      pushAttrForVariable(orderMatch[1], orderMatch[2], `from ${orderMatch[1]} OrderExpression`, 'order_expression');
    }

    if (trimmed.includes('PreEntityImages') && !notes.includes('Code uses PreEntityImages. Registration metadata was not available locally.')) {
      notes.push('Code uses PreEntityImages. Registration metadata was not available locally.');
    }
    if (trimmed.includes('PostEntityImages') && !notes.includes('Code uses PostEntityImages. Registration metadata was not available locally.')) {
      notes.push('Code uses PostEntityImages. Registration metadata was not available locally.');
    }
  });

  if (primaryEntityName) {
    if (primaryEntitySource === 'manual_override') {
      notes.push(`Primary plugin entity: ${primaryEntityName} (source: manual override).`);
    } else {
      notes.push(`Primary plugin entity: ${primaryEntityName} (source: inferred).`);
    }
  } else if (targetAttributes.size > 0) {
    notes.push('Primary plugin entity could not be inferred. Configure primary entity in task setup or provide a manual override for verification.');
  }

  const attributes = buildAttributesMap(attributeReferences);
  const entities = uniq(
    entityReferences.map((item) => item.logicalName)
      .concat(Object.keys(attributes))
      .concat(relationshipReferences.flatMap((item) => [item.sourceEntityLogicalName ?? '', item.targetEntityLogicalName ?? '']))
      .filter(Boolean),
  );

  const pluginContext: CrmPluginScanInfo = {
    primaryEntityName,
    primaryEntitySource,
    messages: Array.from(pluginMessages),
    filteringAttributes: Array.from(filteringAttributes),
    usesPreEntityImages: content.includes('PreEntityImages'),
    usesPostEntityImages: content.includes('PostEntityImages'),
    imageAttributes: {
      pre: uniq(imageAttributes.pre),
      post: uniq(imageAttributes.post),
    },
    targetAttributes: Array.from(targetAttributes),
    notes,
  };

  return {
    entities,
    attributes,
    ambiguousAttributes: uniq(ambiguousReferences.filter((item) => item.kind === 'attribute').map((item) => item.logicalName)),
    notes,
    entityReferences,
    attributeReferences,
    relationshipReferences,
    ambiguousReferences,
    pluginContext,
  };
}
