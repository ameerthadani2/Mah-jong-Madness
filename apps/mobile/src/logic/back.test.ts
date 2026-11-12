import { describe, expect, it } from 'vitest';
import { hardwareBackPlan, replacesTable } from './back';

const stack = (...names: string[]) => names.map((name) => ({ name }));

describe('hardware Back', () => {
  it('asks at a live table instead of popping it off the stack', () => {
    expect(hardwareBackPlan(stack('home', 'table'), true)).toBe('ask');
    expect(hardwareBackPlan(stack('home', 'online', 'lobby', 'table'), true)).toBe('ask');
  });

  it("asks in a live table's lobby, so the open link is never left behind unseen", () => {
    expect(hardwareBackPlan(stack('home', 'online', 'lobby'), true)).toBe('ask');
  });

  it('pops the screens opened over a table (review, fair play) back to it', () => {
    expect(hardwareBackPlan(stack('home', 'table', 'review'), true)).toBe('pop');
    expect(hardwareBackPlan(stack('home', 'table', 'fairness'), true)).toBe('pop');
  });

  it('pops an ordinary screen, and a table screen that has no table', () => {
    expect(hardwareBackPlan(stack('home', 'learn'), false)).toBe('pop');
    expect(hardwareBackPlan(stack('home', 'table'), false)).toBe('pop');
  });

  it('leaves the first screen to the system', () => {
    expect(hardwareBackPlan(stack('home'), false)).toBe('system');
  });
});

describe('a new match over a table in progress', () => {
  const live = (matchOver: boolean) => ({ client: { state: { matchOver: matchOver ? {} : null } } });

  it('replaces a saved table, so Home asks first', () => {
    expect(replacesTable({ kind: 'local' }, null)).toBe(true);
  });

  it('replaces a live table that is not over', () => {
    expect(replacesTable(null, live(false))).toBe(true);
  });

  it('replaces nothing when no table is saved or the live one is over', () => {
    expect(replacesTable(null, null)).toBe(false);
    expect(replacesTable(null, live(true))).toBe(false);
  });
});
