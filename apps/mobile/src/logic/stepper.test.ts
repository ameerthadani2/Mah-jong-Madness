import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_LIMITS } from '@mjm/engine';
import { atLimit, HOLD_REPEAT_MS, holdMultiplier, stepped, typedValue } from './stepper';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('a number in the rule editor', () => {
  const points = { min: RULE_LIMITS.startingPoints[0], max: RULE_LIMITS.startingPoints[1], step: 100 };

  it('stops at its limits, and says so by disabling the button', () => {
    expect(stepped(0, -1, points)).toBe(points.min);
    expect(stepped(points.max, 1, points)).toBe(points.max);
    expect(atLimit(points.min, -1, points)).toBe(true);
    expect(atLimit(points.max, 1, points)).toBe(true);
    expect(atLimit(500, -1, points)).toBe(false);
    const ui = read('components/Ui.tsx');
    expect(ui).toMatch(/disabled=\{atLimit\(value, -1, limits\)\}/);
    expect(ui).toMatch(/disabled=\{atLimit\(value, 1, limits\)\}/);
  });

  it('reaches the largest value by holding the button in seconds, not thousands of presses', () => {
    let value = points.min;
    let repeats = 0;
    while (value < points.max && repeats < 10_000) value = stepped(value, 1, points, holdMultiplier(repeats++));
    expect(value).toBe(points.max);
    expect((repeats * HOLD_REPEAT_MS) / 1000).toBeLessThan(15);
    // The first repeats still move one step at a time, so a small change does not overshoot.
    expect(holdMultiplier(0)).toBe(1);
    expect(holdMultiplier(14)).toBe(1);
  });

  it('takes a typed whole number, pulled inside the limits, and ignores anything else', () => {
    expect(typedValue('25000', points)).toBe(25000);
    expect(typedValue(' 25,000 ', points)).toBe(25000);
    expect(typedValue('99999999', points)).toBe(points.max);
    expect(typedValue('', points)).toBeNull();
    expect(typedValue('12.5', points)).toBeNull();
    expect(typedValue('-5', points)).toBeNull();
    expect(typedValue('abc', points)).toBeNull();
    expect(typedValue('2', { min: 3, max: 120, step: 1 })).toBe(3);
  });
});

describe('house rules in Settings', () => {
  it('are edited with the same editor, names and limits as a club\'s rules', () => {
    const settings = read('screens/SettingsScreen.tsx');
    expect(settings).toMatch(/<RuleEditor value=\{rules\} onChange=\{\(next\) => setSettings\(\{ \.\.\.settings, rules: next \}\)\} \/>/);
    // No second set of steppers with limits of its own.
    expect(settings).not.toMatch(/<Stepper /);
    expect(read('components/RuleEditor.tsx')).toMatch(/const \[min, max\] = RULE_LIMITS\[f\.key\];/);
  });
});
