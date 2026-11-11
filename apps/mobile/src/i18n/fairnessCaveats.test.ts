import { describe, expect, it } from 'vitest';
import { AUDIT_CAVEATS, caveatKey } from '@mjm/net';
import { en, zhTW } from './locales';

/**
 * The table client explains an amber hand with one of a fixed set of reasons, and the Fair play
 * screen and the result sheet show each one by its key (`fairness.caveat.<key>`). A reason with no
 * text would show as a raw key.
 */
describe('fairness caveats', () => {
  it('every reason the table client can give has text in both languages', () => {
    for (const key of Object.keys(AUDIT_CAVEATS)) {
      const english = (en.fairness.caveat as Record<string, string>)[key];
      const chinese = (zhTW.fairness.caveat as Record<string, string>)[key];
      expect(english, `en fairness.caveat.${key}`).toBeTruthy();
      expect(chinese, `zh-TW fairness.caveat.${key}`).toBeTruthy();
      expect(chinese, `zh-TW fairness.caveat.${key} is translated`).not.toBe(english);
    }
  });

  it('there is no text for a reason the client no longer gives', () => {
    for (const key of Object.keys(en.fairness.caveat)) expect(Object.keys(AUDIT_CAVEATS)).toContain(key);
  });

  it('each reason maps back to its key', () => {
    for (const [key, text] of Object.entries(AUDIT_CAVEATS)) expect(caveatKey(text)).toBe(key);
  });
});
