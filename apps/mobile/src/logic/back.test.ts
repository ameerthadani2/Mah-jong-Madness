import { describe, expect, it } from 'vitest';
import { backToDealtTable, betweenHands, hardwareBackPlan, justReturned, replacesTable, RETURNED_NOTICE_MS } from './back';

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

describe('the next hand dealt while Review or Fair play is open', () => {
  it('takes the player back to the table, marked with the moment', () => {
    expect(backToDealtTable(stack('home', 'online', 'lobby', 'table', 'review'), 5000)).toEqual([...stack('home', 'online', 'lobby'), { name: 'table', returnedAt: 5000 }]);
    expect(backToDealtTable(stack('home', 'table', 'fairness'), 5000)).toEqual([{ name: 'home' }, { name: 'table', returnedAt: 5000 }]);
    expect(backToDealtTable(stack('home', 'table', 'fairness', 'review'), 7)).toEqual([{ name: 'home' }, { name: 'table', returnedAt: 7 }]);
  });

  it('leaves every other stack alone: the table itself, Settings, or a review with no table under it', () => {
    for (const st of [stack('home', 'table'), stack('home', 'table', 'settings'), stack('home', 'review'), stack('home')]) expect(backToDealtTable(st, 1)).toBe(st);
  });

  it('counts as between hands only while a result is up and the match is not over', () => {
    expect(betweenHands({ lastResult: { type: 'win' } })).toBe(true);
    expect(betweenHands({ lastResult: null })).toBe(false);
    expect(betweenHands({ lastResult: { type: 'draw' }, matchOver: true })).toBe(false);
  });

  it('lets the table say why it is back for a few seconds, and not on a later visit', () => {
    expect(justReturned({ name: 'table', returnedAt: 1000 }, 1500)).toBe(true);
    expect(justReturned({ name: 'table', returnedAt: 1000 }, 1000 + RETURNED_NOTICE_MS)).toBe(false);
    expect(justReturned({ name: 'table' }, 1500)).toBe(false);
    expect(justReturned({ name: 'review', returnedAt: 1000 }, 1500)).toBe(false);
  });

  it('is watched by the app provider for every table, and said on the table', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const provider = readFileSync(join(__dirname, '../app-state.tsx'), 'utf8');
    expect(provider).toContain('if (waiting && !betweenHands(st)) setStack((stk) => backToDealtTable(stk, Date.now()) as Screen[]);');
    const table = readFileSync(join(__dirname, '../screens/TableScreen.tsx'), 'utf8');
    expect(table).toContain("justReturned(app.screen, Date.now())");
    expect(table).toContain("t('table.nextHandStarted')");
  });
});
