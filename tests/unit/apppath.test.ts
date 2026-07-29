/**
 * resolveWithin is the entire security boundary of the app:// protocol handler:
 * every renderer asset request funnels through it, and the failure mode it
 * guards — a traversal escaping the renderer directory — would hand file read
 * access to the page. Pure function, so the boundary cases are pinned here
 * without an Electron runtime.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveWithin } from '../../src/main/util/apppath.js';

const ROOT = path.join(path.sep, 'srv', 'app', 'renderer');

describe('apppath resolveWithin', () => {
  test('a normal file resolves inside the root', () => {
    assert.equal(resolveWithin(ROOT, '/index.html'), path.join(ROOT, 'index.html'));
  });

  test('a nested asset resolves inside the root', () => {
    assert.equal(
      resolveWithin(ROOT, '/assets/index-Bx1.js'),
      path.join(ROOT, 'assets', 'index-Bx1.js'),
    );
  });

  test("'' and '/' both serve /index.html — the SPA entry", () => {
    assert.equal(resolveWithin(ROOT, ''), path.join(ROOT, 'index.html'));
    assert.equal(resolveWithin(ROOT, '/'), path.join(ROOT, 'index.html'));
  });

  test('percent-escapes decode before resolution', () => {
    assert.equal(resolveWithin(ROOT, '/my%20file.html'), path.join(ROOT, 'my file.html'));
  });

  test('a plain ../ traversal is refused', () => {
    assert.equal(resolveWithin(ROOT, '/../secret'), null);
    assert.equal(resolveWithin(ROOT, '/../../etc/passwd'), null);
  });

  test('an ENCODED traversal is refused — the check runs after decoding', () => {
    // %2F is '/', so the decoded pathname is '/../secret'. Checking the raw
    // string for '..' before decoding would pass this; resolveWithin must not.
    assert.equal(resolveWithin(ROOT, '/..%2Fsecret'), null);
  });

  test('a sibling directory sharing the root as a string prefix is refused', () => {
    // Decodes to '/../renderer-evil/f' → <parent>/renderer-evil/f, which a naive
    // startsWith(root) — without the trailing separator — would wrongly allow.
    assert.equal(resolveWithin(ROOT, '/..%2Frenderer-evil%2Ff'), null);
  });

  test('a malformed percent-escape is refused rather than thrown', () => {
    // decodeURIComponent throws URIError on '%zz'; that must surface as null,
    // not as an exception inside the protocol handler.
    assert.equal(resolveWithin(ROOT, '/%zz'), null);
    assert.equal(resolveWithin(ROOT, '/file%'), null);
  });

  test(
    'backslash sequences do not escape the root on posix',
    { skip: process.platform === 'win32' ? 'posix path semantics only' : false },
    () => {
      // On posix a backslash is an ordinary filename character, not a separator,
      // so '..\..\secret' is a single (weird) filename inside the root — allowed,
      // but contained. The property under test is containment, not the exact path.
      for (const pathname of ['/..%5C..%5Csecret', '/\\..\\secret']) {
        const out = resolveWithin(ROOT, pathname);
        assert.ok(
          out === null || out.startsWith(ROOT + path.sep),
          `${pathname} resolved outside the root: ${out}`,
        );
      }
    },
  );
});
