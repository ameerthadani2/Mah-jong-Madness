import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { exitPlan, leaveSheetBody, onExitIcon } from './exit';
import { en, zhTW } from '../../i18n/locales';

describe('table exit', () => {
  it('one tap on the exit icon only opens the sheet: nothing is closed or forgotten', () => {
    const r = onExitIcon();
    expect(r.openSheet).toBe(true);
    expect(r.plan).toEqual({ closeSession: false, forgetTable: false, goHome: false, keepSeat: false });
  });

  it('keeps the table on "Keep playing"', () => {
    expect(exitPlan('stay')).toEqual({ closeSession: false, forgetTable: false, goHome: false, keepSeat: false });
  });

  it('keeps the Home resume card when stepping away', () => {
    expect(exitPlan('away')).toEqual({ closeSession: true, forgetTable: false, goHome: true, keepSeat: false });
  });

  it('forgets the table only when the player confirms abandoning it', () => {
    expect(exitPlan('abandon')).toEqual({ closeSession: true, forgetTable: true, goHome: true, keepSeat: false });
  });

  it('asks before leaving from the shuffle screen while a match is on', () => {
    // Rendered elsewhere: the result sheet's Leave opening the exit sheet (src/screens/TablePlay.render.test.tsx, "the
    // end of a hand"); Android's Back key asking mid-match and leaving at once after it, and the match-over card's
    // direct Back to home in place of the last result sheet (src/screens/TableBack.render.test.tsx).
    const src = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    expect(src).toMatch(/title=\{t\('table\.leave'\)\} onPress=\{\(\) => setLeaveAsk\(true\)\}/);
  });

  it('stepping away from a quick-match table keeps the seat: the table would close at once if its only player left on purpose', () => {
    expect(exitPlan('away', { quickMatch: true })).toEqual({ closeSession: true, forgetTable: false, goHome: true, keepSeat: true });
    // Abandoning still gives the seat up, and "Keep playing" changes nothing.
    expect(exitPlan('abandon', { quickMatch: true }).keepSeat).toBe(false);
    expect(exitPlan('stay', { quickMatch: true }).keepSeat).toBe(false);
    // That the table screen follows this plan is rendered in src/screens/TableLeave.render.test.tsx ("at a quick-match table ...").
  });

  it('the exit sheet at a quick-match table says how long the table waits with nobody at it', () => {
    expect(leaveSheetBody({ online: false })).toBe('table.leaveSheet.bodyLocal');
    expect(leaveSheetBody({ online: true })).toBe('table.leaveSheet.bodyOnline');
    expect(leaveSheetBody({ online: true, quickMatch: true })).toBe('table.leaveSheet.bodyQuick');
    expect((en as { table: { leaveSheet: Record<string, string> } }).table.leaveSheet.bodyQuick).toMatch(/two minutes/);
    expect((zhTW as { table: { leaveSheet: Record<string, string> } }).table.leaveSheet.bodyQuick).toMatch(/兩分鐘/);
  });
});
