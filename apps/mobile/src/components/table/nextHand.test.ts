import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { I18n } from 'i18n-js';
import { en, zhTW } from '../../i18n/locales';
import { secondsLeft } from '../../game/useTable';
import { nextHandAnnouncement, nextHandNote } from './nextHand';

const i18n = new I18n({ en, 'zh-TW': zhTW });
const tr = (locale: string) => (key: string, params?: Record<string, unknown>) => i18n.t(key, { ...params, locale });
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('the countdown to the next hand online', () => {
  it('shows the seconds left in both languages, or the general sentence when the host did not say', () => {
    expect(nextHandNote(tr('en'), 12)).toBe('Next hand in 12 s');
    expect(nextHandNote(tr('zh-TW'), 12)).toBe('12 秒後開下一局');
    expect(nextHandNote(tr('en'), null)).toBe('Online, the next hand starts by itself in a few seconds.');
  });

  it('counts down on the host deadline the client keeps', () => {
    const deadline = 1_000_000 + 12_000;
    expect(nextHandNote(tr('en'), secondsLeft(deadline, 1_000_000))).toBe('Next hand in 12 s');
    expect(nextHandNote(tr('en'), secondsLeft(deadline, 1_000_000 + 4_500))).toBe('Next hand in 8 s');
  });

  it('is announced once per hand, not every second', () => {
    const t = tr('en');
    const deadline = 5_000;
    const first = nextHandAnnouncement(t, deadline, 12, null);
    expect(first).toBe('The next hand starts in 12 seconds.');
    // Ticking: the same deadline is not announced again.
    for (const s of [11, 10, 3, 0]) expect(nextHandAnnouncement(t, deadline, s, deadline)).toBeNull();
    // The next hand's intermission is.
    expect(nextHandAnnouncement(tr('zh-TW'), 99_000, 12, deadline)).toBe('下一局將在 12 秒後開始。');
    expect(nextHandAnnouncement(t, null, null, deadline)).toBeNull();
  });

  it('the online result sheet uses the countdown, and its visible line is not a live region', () => {
    expect(read('./ResultSheet.tsx')).toContain('<NextHandCountdown deadline={state.intermissionDeadline ?? null}');
    const parts = read('./ClockParts.tsx');
    const fn = parts.slice(parts.indexOf('export function NextHandCountdown'));
    expect(fn).toMatch(/<Text testID="result-auto-next" style=\{style\}>/);
    // Exactly one live region in it: the hidden one whose words change once per hand.
    expect(fn.slice(0, fn.indexOf('const styles')).match(/accessibilityLiveRegion/g)).toHaveLength(1);
  });
});
