import { afterEach, describe, expect, it } from '@jest/globals';
import { setLocalePreference } from './index';

// On the web the page's title and lang follow the language the UI is shown in (resolve.ts applyDocumentLocale); this
// runs the module that switches the language against a stand-in page, as the web export has one.
const g = globalThis as { document?: unknown };
const realDocument = g.document;
afterEach(() => {
  g.document = realDocument;
  setLocalePreference('auto');
});

describe('the web page', () => {
  it('is titled with the app’s name in the language the UI is shown in, and follows a change of language', () => {
    const page = { documentElement: { lang: 'en' }, title: 'Mahjong Mania' };
    g.document = page;
    setLocalePreference('zh-TW');
    expect(page.title).toBe('麻將狂熱');
    expect(page.documentElement.lang).toBe('zh-Hant-TW');
    setLocalePreference('en');
    expect(page.title).toBe('Mahjong Mania');
    expect(page.documentElement.lang).toBe('en');
  });
});
