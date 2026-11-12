import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { exitPlan, onExitIcon } from './exit';

describe('table exit', () => {
  it('one tap on the exit icon only opens the sheet: nothing is closed or forgotten', () => {
    const r = onExitIcon();
    expect(r.openSheet).toBe(true);
    expect(r.plan).toEqual({ closeSession: false, forgetTable: false, goHome: false });
  });

  it('keeps the table on "Keep playing"', () => {
    expect(exitPlan('stay')).toEqual({ closeSession: false, forgetTable: false, goHome: false });
  });

  it('keeps the Home resume card when stepping away', () => {
    expect(exitPlan('away')).toEqual({ closeSession: true, forgetTable: false, goHome: true });
  });

  it('forgets the table only when the player confirms abandoning it', () => {
    expect(exitPlan('abandon')).toEqual({ closeSession: true, forgetTable: true, goHome: true });
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
});
