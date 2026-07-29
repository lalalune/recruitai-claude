/**
 * Regressions for defects found in the final hardening pass. Each test here
 * corresponds to something that was shipping broken.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateHost } from '../../src/main/util/http.js';
import { daysOpenPhrase } from '../../src/main/pipeline/drafts.js';

describe('isPrivateHost — the crawler follows redirects from arbitrary company sites', () => {
  test('refuses loopback in every spelling', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'app.localhost']) {
      assert.equal(isPrivateHost(h), true, `${h} should be refused`);
    }
  });

  test('refuses RFC1918 space', () => {
    for (const h of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255']) {
      assert.equal(isPrivateHost(h), true, `${h} should be refused`);
    }
  });

  test('refuses link-local, which is where cloud metadata lives', () => {
    assert.equal(isPrivateHost('169.254.169.254'), true);
  });

  test('refuses IPv6 unique-local and link-local', () => {
    for (const h of ['fc00::1', 'fd12:3456::1', 'fe80::1', '[fd00::1]']) {
      assert.equal(isPrivateHost(h), true, `${h} should be refused`);
    }
  });

  test('refuses .internal, which resolves privately on several clouds', () => {
    assert.equal(isPrivateHost('metadata.internal'), true);
  });

  test('allows the public hosts the pipeline actually needs', () => {
    for (const h of [
      'boards-api.greenhouse.io',
      'api.ashbyhq.com',
      'api.lever.co',
      'yc-oss.github.io',
      'hn.algolia.com',
      'efts.sec.gov',
      'stripe.com',
      // 172.32 is outside RFC1918; the boundary is 172.16-172.31.
      '172.32.0.1',
      // Not loopback despite starting with the same digits.
      '10a.example.com',
    ]) {
      assert.equal(isPrivateHost(h), false, `${h} should be allowed`);
    }
  });
});

describe('daysOpenPhrase — this text reaches a real hiring manager', () => {
  test('drops the clause rather than saying "open 0 days"', () => {
    // A req first seen today reports 0. "Open 0 days" reads as broken software.
    assert.equal(daysOpenPhrase(0), null);
  });

  test('drops the clause below a week — there is no staleness story yet', () => {
    for (const d of [1, 3, 6]) assert.equal(daysOpenPhrase(d), null, `${d} days should be dropped`);
  });

  test('pluralises correctly once it does speak', () => {
    assert.equal(daysOpenPhrase(7), 'open 7 days');
    assert.equal(daysOpenPhrase(71), 'open 71 days');
  });

  test('tolerates null, undefined and non-finite input', () => {
    assert.equal(daysOpenPhrase(null), null);
    assert.equal(daysOpenPhrase(undefined), null);
    assert.equal(daysOpenPhrase(Number.NaN), null);
    assert.equal(daysOpenPhrase(Number.POSITIVE_INFINITY), null);
  });

  test('floors a fractional day count instead of rendering a decimal', () => {
    assert.equal(daysOpenPhrase(45.9), 'open 45 days');
  });
});
