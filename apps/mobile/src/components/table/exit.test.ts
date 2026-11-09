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
});
