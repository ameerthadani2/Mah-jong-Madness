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

  it('wires the HUD exit icon to the sheet, never straight to leaving', () => {
    const src = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    const hud = src.slice(src.indexOf('<TableHud'), src.indexOf('/>', src.indexOf('<TableHud')));
    expect(hud).toMatch(/onLeave=\{\(\) => setLeaveAsk\(true\)\}/);
    expect(src).toContain('<LeaveSheet');
  });

  it('asks before leaving from the result sheet, the shuffle screen and the Android Back key while a match is on', () => {
    const src = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    const sheet = src.slice(src.indexOf('<ResultSheet'), src.indexOf('/>', src.indexOf('<ResultSheet')));
    expect(sheet).toMatch(/onLeave=\{\(\) => setLeaveAsk\(true\)\}/);
    expect(src).toMatch(/title=\{t\('table\.leave'\)\} onPress=\{\(\) => setLeaveAsk\(true\)\}/);
    expect(src).toContain('useHardwareBack(() => (state?.matchOver ? leave() : setLeaveAsk(true)));');
    // Only the match-over card leaves directly.
    expect(src.match(/onLeave=\{leave\}/g)).toHaveLength(1);
    expect(src).toContain('<MatchOverSheet state={state} onLeave={leave} />');
  });

  it("takes the last hand's result sheet away once the match-over card is up", () => {
    const src = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    expect(src).toContain('{state.lastResult && showResult && !state.matchOver && <ResultSheet');
  });

  it('stepping away from a quick-match table keeps the seat: the table would close at once if its only player left on purpose', () => {
    expect(exitPlan('away', { quickMatch: true })).toEqual({ closeSession: true, forgetTable: false, goHome: true, keepSeat: true });
    // Abandoning still gives the seat up, and "Keep playing" changes nothing.
    expect(exitPlan('abandon', { quickMatch: true }).keepSeat).toBe(false);
    expect(exitPlan('stay', { quickMatch: true }).keepSeat).toBe(false);
    const src = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    expect(src).toContain('const plan = exitPlan(choice, { quickMatch: session?.quickMatch });');
    expect(src).toContain('app.setSession(null, { keepSeat: plan.keepSeat });');
  });

  it('the exit sheet at a quick-match table says how long the table waits with nobody at it', () => {
    expect(leaveSheetBody({ online: false })).toBe('table.leaveSheet.bodyLocal');
    expect(leaveSheetBody({ online: true })).toBe('table.leaveSheet.bodyOnline');
    expect(leaveSheetBody({ online: true, quickMatch: true })).toBe('table.leaveSheet.bodyQuick');
    expect((en as { table: { leaveSheet: Record<string, string> } }).table.leaveSheet.bodyQuick).toMatch(/two minutes/);
    expect((zhTW as { table: { leaveSheet: Record<string, string> } }).table.leaveSheet.bodyQuick).toMatch(/兩分鐘/);
  });
});
