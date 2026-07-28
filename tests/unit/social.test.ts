/**
 * LinkedIn company-URL extraction.
 *
 * This is the step that makes the whole LinkedIn feature reachable — nothing
 * else in the pipeline produces a company.linkedin_url. A wrong slug is worse
 * than none: it would attribute another company's recruiter headcount to this
 * one and corrupt the highest-signal input to the score. So these tests care
 * far more about false positives than about coverage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractLinkedInSlug } from '../../src/main/sources/social.js';

describe('extractLinkedInSlug', () => {
  test('pulls the slug out of a plain footer anchor', () => {
    const html = `<footer><a href="https://www.linkedin.com/company/rescale">LinkedIn</a></footer>`;
    assert.equal(extractLinkedInSlug(html), 'rescale');
  });

  test('handles slugs that are not derivable from the domain', () => {
    // Measured real cases — this is exactly why guessing is not a substitute
    // for reading the page.
    assert.equal(
      extractLinkedInSlug('<a href="https://linkedin.com/company/getsift">x</a>'),
      'getsift',
    );
    assert.equal(
      extractLinkedInSlug('<a href="https://linkedin.com/company/clerky-inc-">x</a>'),
      'clerky-inc-',
    );
    assert.equal(
      extractLinkedInSlug('<a href="https://linkedin.com/company/poll-everywhere-inc.">x</a>'),
      'poll-everywhere-inc.',
    );
  });

  test('accepts protocol-relative and scheme-less hrefs', () => {
    assert.equal(extractLinkedInSlug('<a href="//linkedin.com/company/docker">x</a>'), 'docker');
    assert.equal(extractLinkedInSlug('href="linkedin.com/company/zapier"'), 'zapier');
  });

  test('accepts country subdomains, which resolve to the same company page', () => {
    assert.equal(extractLinkedInSlug('https://uk.linkedin.com/company/mattermost'), 'mattermost');
    assert.equal(extractLinkedInSlug('https://de.linkedin.com/company/singlestore'), 'singlestore');
  });

  test('finds the slug inside JSON-LD sameAs blocks', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Organization","sameAs":["https://twitter.com/x","https://www.linkedin.com/company/quartzy"]}
    </script>`;
    assert.equal(extractLinkedInSlug(html), 'quartzy');
  });

  test('stops at a path, query or fragment', () => {
    assert.equal(extractLinkedInSlug('linkedin.com/company/stripe/jobs'), 'stripe');
    assert.equal(extractLinkedInSlug('linkedin.com/company/stripe?trk=nav'), 'stripe');
    assert.equal(extractLinkedInSlug('linkedin.com/company/stripe#about'), 'stripe');
  });

  test('strips trailing punctuation picked up from prose or JSON', () => {
    assert.equal(extractLinkedInSlug('see https://linkedin.com/company/notion),'), 'notion');
    assert.equal(extractLinkedInSlug(`"https://linkedin.com/company/figma"`), 'figma');
  });

  test('returns null when there is no company link at all', () => {
    assert.equal(extractLinkedInSlug('<html><body>no socials here</body></html>'), null);
    assert.equal(extractLinkedInSlug(''), null);
  });

  test('ignores personal profiles, schools and showcase pages', () => {
    // /in/ is a person, not a company — attributing a person's page to a
    // company would silently produce nonsense recruiter counts.
    assert.equal(extractLinkedInSlug('<a href="https://linkedin.com/in/jane-doe">x</a>'), null);
    assert.equal(extractLinkedInSlug('<a href="https://linkedin.com/school/mit">x</a>'), null);
  });

  test('rejects LinkedIn’s own non-company slugs', () => {
    for (const reserved of ['login', 'feed', 'directory', 'shareArticle']) {
      assert.equal(
        extractLinkedInSlug(`<a href="https://linkedin.com/company/${reserved}">x</a>`),
        null,
        `${reserved} should not be treated as a company`,
      );
    }
  });

  test('rejects a purely numeric slug, which is a tracking id not a company', () => {
    assert.equal(extractLinkedInSlug('linkedin.com/company/1234567'), null);
  });

  test('takes the first company link when a page lists several', () => {
    // Footers commonly link the company first and partners afterwards.
    const html = `
      <a href="https://linkedin.com/company/acme">us</a>
      <a href="https://linkedin.com/company/some-partner">partner</a>`;
    assert.equal(extractLinkedInSlug(html), 'acme');
  });

  test('does not run away on a pathological slug', () => {
    const long = 'a'.repeat(500);
    assert.equal(extractLinkedInSlug(`linkedin.com/company/${long}`), null);
  });
});
