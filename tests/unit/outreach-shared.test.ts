/**
 * src/shared/outreach.ts — the copy layer both processes share.
 *
 * These functions are why "preview equals sent" holds: main generates and
 * gates with them, the renderer previews with them. A regression here shows
 * up as duplicated signatures or missing compliance footers in real mail.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OPT_OUT_LINE,
  HEADCOUNT_BANDS,
  BAND_LABELS,
  TEMPLATE_VARIABLES,
  renderTemplate,
  unknownTemplateVariables,
  assembleEmail,
  ensureCompliantFooter,
} from '../../src/shared/outreach.js';

describe('renderTemplate', () => {
  test('substitutes known variables', () => {
    const out = renderTemplate('Hi {firstName}, saw {companyName} is hiring a {reqTitle}.', {
      firstName: 'Ada',
      companyName: 'Acme',
      reqTitle: 'Staff Engineer',
    });
    assert.equal(out, 'Hi Ada, saw Acme is hiring a Staff Engineer.');
  });

  test('drops a whole line when a variable has no value — never "open  days"', () => {
    const out = renderTemplate(
      'Hi {firstName},\nYour {reqTitle} has been open {reqDaysOpen} days.\nStill interested?',
      { firstName: 'Ada', reqTitle: 'SRE', reqDaysOpen: null },
    );
    assert.equal(out, 'Hi Ada,\nStill interested?');
    assert.ok(!out.includes('days'));
  });

  test('drops lines containing unknown tokens rather than emitting them raw', () => {
    const out = renderTemplate('Hi {firstName},\n{madeUpThing} for you.', { firstName: 'Ada' });
    assert.equal(out, 'Hi Ada,');
  });

  test('numeric zero renders (it is a value, not an absence)', () => {
    const out = renderTemplate('{openReqCount} roles open.', { openReqCount: 0 });
    assert.equal(out, '0 roles open.');
  });

  test('collapses the blank runs dropped lines leave behind', () => {
    const out = renderTemplate('a\n\n{gone}\n\nb', {});
    assert.equal(out, 'a\n\nb');
  });
});

describe('unknownTemplateVariables', () => {
  test('names only the tokens that are not real variables', () => {
    assert.deepEqual(unknownTemplateVariables('{firstName} {bogus} {alsoBad} {fee}'), ['alsoBad', 'bogus']);
    assert.deepEqual(unknownTemplateVariables('plain text'), []);
  });

  test('every documented variable is considered known', () => {
    const all = TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(' ');
    assert.deepEqual(unknownTemplateVariables(all), []);
  });
});

describe('assembleEmail / ensureCompliantFooter', () => {
  const opts = { includeOptOutLine: true, signature: 'Shaw\nBay Area Recruiting', postalAddress: '548 Market St, SF CA' };

  test('assembles body, opt-out, signature, postal in order', () => {
    const out = assembleEmail('Body here.', opts);
    const idx = (s: string) => out.indexOf(s);
    assert.ok(idx('Body here.') < idx(DEFAULT_OPT_OUT_LINE));
    assert.ok(idx(DEFAULT_OPT_OUT_LINE) < idx('Shaw'));
    assert.ok(idx('Shaw') < idx('548 Market St'));
  });

  test('omits what is configured off or empty', () => {
    const out = assembleEmail('Body.', { includeOptOutLine: false, signature: '', postalAddress: '' });
    assert.equal(out, 'Body.');
  });

  test('ensureCompliantFooter re-appends a stripped opt-out line and postal address', () => {
    const out = ensureCompliantFooter('Edited body with footer removed.', {
      includeOptOutLine: true,
      postalAddress: '548 Market St, SF CA',
    });
    assert.ok(out.includes(DEFAULT_OPT_OUT_LINE));
    assert.ok(out.includes('548 Market St'));
  });

  test('ensureCompliantFooter is idempotent on an already-compliant body', () => {
    const once = ensureCompliantFooter(assembleEmail('Body.', opts), {
      includeOptOutLine: true,
      postalAddress: opts.postalAddress,
    });
    const twice = ensureCompliantFooter(once, { includeOptOutLine: true, postalAddress: opts.postalAddress });
    assert.equal(twice, once);
    assert.equal(twice.split(DEFAULT_OPT_OUT_LINE).length, 2, 'exactly one opt-out line');
  });
});

describe('band constants', () => {
  test('every band has a label', () => {
    for (const b of HEADCOUNT_BANDS) {
      assert.ok(BAND_LABELS[b].length > 0);
    }
  });
});
