import { describe, it, expect } from 'vitest';
import { extractEntityFromText } from './scriptAssistant';

describe('extractEntityFromText', () => {
  it('picks the explicit nvr_ table name over a generic Czech keyword guess in the same text', () => {
    const text =
      'Create a JavaScript form script for the NVR Training Automation Lab table `nvr_labservicecase`. ' +
      'Target file: Scripts\\nvr_labservicecase_events.js. ' +
      'Events: Form OnLoad, OnChange of `nvr_priority`. ' +
      'Handlers: `nvr_labservicecase_OnLoad`, `nvr_priority_OnChange`. ' +
      'if nvr_priority is High (100000002), make nvr_description required.';
    expect(extractEntityFromText(text)).toBe('nvr_labservicecase');
  });

  it('does not let a title-only Czech generic word override an explicit logical name in the description', () => {
    const title = '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu';
    const description = 'Create a JavaScript form script for the NVR Training Automation Lab table `nvr_labservicecase`.';
    // "případu" (accusative of "případ") would translate to 'incident' via the Czech keyword
    // table, but the explicit nvr_labservicecase table name in the description must win.
    expect(extractEntityFromText(`${title} ${description}`)).toBe('nvr_labservicecase');
  });

  it('still falls back to the Czech keyword mapping when no explicit nvr_ table name is present', () => {
    const title = '[TEST] Oprava chyby ve servisním případu';
    expect(extractEntityFromText(title)).toBe('incident');
  });

  it('does not treat known nvr_ field names (e.g. nvr_priority, nvr_description) as the entity', () => {
    const text = 'Update nvr_priority and nvr_description on the form.';
    // Neither token is a valid entity name — falls through to the final fallback.
    expect(extractEntityFromText(text)).toBe('account');
  });
});
