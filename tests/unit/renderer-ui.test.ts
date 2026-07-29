/**
 * Renderer UI seams that are pure enough to run headless: the "reset the view"
 * store action behind the empty-state button, and the two event-target
 * classifiers the Review hotkeys use to decide when NOT to swallow a keystroke.
 *
 * Both classifiers walk `parentElement` by hand instead of calling
 * `Element.closest`, precisely so they can be pinned here against a plain
 * object chain — there is no DOM in the test runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isActivationTarget, isInOverlayLayer, type ElementLike } from '../../src/renderer/lib/utils.js';
import { useUi } from '../../src/renderer/store/ui.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake elements
// ─────────────────────────────────────────────────────────────────────────────

function el(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: ElementLike | null = null,
): ElementLike {
  return {
    tagName,
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: parent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resetView — the "Reset filters" button in Review's empty state
// ─────────────────────────────────────────────────────────────────────────────

test('resetView clears the toggle chips, not just the filter and the search', () => {
  const s = useUi.getState();
  s.setFilter('rejected');
  s.setSearch('acme');
  s.toggle('hasVerifiedEmail');
  s.toggle('noInhouseTa');
  s.toggle('staleOnly');

  const narrowed = useUi.getState();
  assert.equal(narrowed.filter, 'rejected');
  assert.deepEqual(narrowed.toggles, {
    hasVerifiedEmail: true,
    noInhouseTa: true,
    staleOnly: true,
  });

  useUi.getState().resetView();

  const after = useUi.getState();
  assert.equal(after.filter, 'all');
  assert.equal(after.search, '');
  // Pin: a "Reset filters" button that left a toggle set would drop the
  // operator back onto the same empty list they clicked it to escape.
  assert.deepEqual(after.toggles, {
    hasVerifiedEmail: false,
    noInhouseTa: false,
    staleOnly: false,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isActivationTarget — why `space` must not preventDefault everywhere
// ─────────────────────────────────────────────────────────────────────────────

test('isActivationTarget matches buttons, links and ARIA widgets, through ancestors', () => {
  assert.equal(isActivationTarget(el('BUTTON')), true);
  assert.equal(isActivationTarget(el('A')), true);
  // Radix renders its Select trigger and Switch as buttons carrying a role.
  assert.equal(isActivationTarget(el('DIV', { role: 'combobox' })), true);
  assert.equal(isActivationTarget(el('DIV', { role: 'switch' })), true);
  // The label span inside a button is what a click actually targets.
  assert.equal(isActivationTarget(el('SPAN', {}, el('BUTTON'))), true);
});

test('isActivationTarget leaves the list and the field rows alone', () => {
  // The virtualized list container is focusable (tabIndex -1) and becomes the
  // key event target after a row click; space must still peek there.
  assert.equal(isActivationTarget(el('DIV', { role: 'listbox' })), false);
  assert.equal(isActivationTarget(el('DIV', { 'data-field-row': '' })), false);
  assert.equal(isActivationTarget(el('BODY')), false);
  assert.equal(isActivationTarget(null), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// isInOverlayLayer — screen hotkeys must not decide the record behind a popover
// ─────────────────────────────────────────────────────────────────────────────

test('isInOverlayLayer detects the Radix popper portal and dialogs', () => {
  const popper = el('DIV', { 'data-radix-popper-content-wrapper': '' });
  assert.equal(isInOverlayLayer(el('BUTTON', {}, el('DIV', {}, popper))), true);
  assert.equal(isInOverlayLayer(el('DIV', { role: 'dialog' })), true);
  assert.equal(isInOverlayLayer(el('DIV', { role: 'alertdialog' })), true);
});

test('isInOverlayLayer ignores the ranked list, which is also a listbox', () => {
  // Regression guard: keying off role="listbox" would disable every Review
  // hotkey the moment the operator clicked a row, because the scroll container
  // carries that role and takes focus on mousedown.
  const row = el('DIV', { role: 'option' }, el('DIV', { role: 'listbox' }));
  assert.equal(isInOverlayLayer(row), false);
  assert.equal(isInOverlayLayer(el('BODY')), false);
});
