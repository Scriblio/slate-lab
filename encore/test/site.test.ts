import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encorePage, page, renderMarkdown, thanksPage } from '../scripts/site.mjs';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('the public pages', () => {
  it('renders the Markdown the policies use', () => {
    const html = renderMarkdown(
      ['# Title', '', 'A **bold** [link](https://example.com/x) and <b>html</b>.', '', '- one', '  - nested', '', '  continued', '- two', '', 'After.'].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong> <a href="https://example.com/x">link</a> and &lt;b&gt;html&lt;/b&gt;.');
    expect(html).toMatch(/<ul><li>\none\n<ul><li>\nnested\n<p>continued<\/p>\n<\/li><\/ul>\n<\/li><li>\ntwo\n<\/li><\/ul>\n<p>After.<\/p>/);
  });

  // YouTube's audit checks these, so they mustn't quietly disappear.
  it.each(['PRIVACY.md', 'TERMS.md'])('%s links YouTube’s terms and Google’s privacy policy, with no placeholders', (file) => {
    const md = read(file);
    expect(md).toContain('https://www.youtube.com/t/terms');
    expect(md).toContain('https://policies.google.com/privacy');
    expect(md).toMatch(/agree to be bound by the \[YouTube Terms of Service\]/);
    expect(md).not.toMatch(/\[(?:Scriblio|date|support email)[^\]]*\](?!\()/);
  });

  it('says how YouTube data is stored and deleted in the privacy policy', () => {
    const md = read('PRIVACY.md');
    expect(md).toContain('## YouTube API Services');
    expect(md).toMatch(/30 days/);
    expect(md).toMatch(/security\.google\.com\/settings\/security\/permissions/);
    expect(md).toMatch(/Deleting your information/);
  });

  it('puts the policy links on every page', () => {
    for (const html of [encorePage(), thanksPage(), page({ title: 't', description: 'd', body: '' })]) {
      for (const href of ['/privacy', '/terms', 'https://www.youtube.com/t/terms', 'https://policies.google.com/privacy']) expect(html).toContain(`href="${href}"`);
      expect(html).not.toMatch(/<script/i); // the site's CSP allows only its own scripts; these pages need none
    }
  });

  describe('the page Stripe sends a KJ to after paying', () => {
    const html = thanksPage();

    it('tells them what to do if Encore has not noticed, and keeps out of search results', () => {
      expect(html).toContain('<title>Thank you: Encore Karaoke</title>');
      expect(html).toMatch(/Check again/);
      expect(html).toContain('<meta name="robots" content="noindex">');
      // The other pages are for finding.
      expect(encorePage()).not.toContain('noindex');
    });

    it('names no price and unlocks nothing: it is only a page', () => {
      expect(html).not.toMatch(/\$\s?\d|price|per year|subscri/i);
      expect(html).not.toMatch(/<script|<form|<input/i);
    });

    it('is built into the join site as /thanks, next to the other pages', () => {
      const build = read('scripts/build-sing.mjs');
      expect(build).toMatch(/join\(out, 'thanks\.html'\), thanksPage\(\)/);
    });
  });
});
