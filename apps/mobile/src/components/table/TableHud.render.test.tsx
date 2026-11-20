import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { TableView } from '@mjm/engine';
import { TableHud } from './TableHud';
import { MIN_TOUCH } from './layout';

type Slop = number | { top?: number; bottom?: number; left?: number; right?: number } | undefined;
const side = (s: Slop, k: 'top' | 'bottom' | 'left' | 'right') => (typeof s === 'number' ? s : (s?.[k] ?? 0));

/** The press target of a pressable, in points: its own box (padding included) and, on a phone, its hitSlop. */
function target(el: ReturnType<typeof screen.getByLabelText>, withSlop: boolean): { w: number; h: number; margin: number } {
  const style = StyleSheet.flatten(el.props.style) ?? {};
  // The drawn button is the first sized view inside.
  type Node = { props: { style?: unknown }; children?: Array<Node | string> };
  const find = (n: Node): Node | null => {
    for (const c of n.children ?? []) {
      if (typeof c === 'string') continue;
      if (typeof (StyleSheet.flatten(c.props.style as never) as { width?: unknown } | undefined)?.width === 'number') return c;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const inner = find(el as unknown as Node)!;
  const face = StyleSheet.flatten(inner.props.style as never) as { width: number; height: number };
  const pad = (style.padding as number) ?? 0;
  const slop = withSlop ? (el.props.hitSlop as Slop) : 0;
  return {
    w: (face.width as number) + 2 * pad + side(slop, 'left') + side(slop, 'right'),
    h: (face.height as number) + 2 * pad + side(slop, 'top') + side(slop, 'bottom'),
    margin: (style.margin as number) ?? 0,
  };
}

describe('the table HUD icons', () => {
  it('each take a press of at least 44 x 44 pt, without hitSlop (the web) and with it (a phone), in the same place', async () => {
    const view = { prevailingWind: 0, handNumber: 0, dealerStreak: 0, drawsLeft: 80 } as unknown as TableView;
    await render(
      <TableHud view={view} roomCode="ABCD" quickMatch portrait clock={{ deadline: null, total: 15, bank: false }} myMove={false} timeBank={0} status={null} emotesOpen={false} onEmotes={() => {}} coachAllowed coachOpen={false} onCoach={() => {}} onLeave={() => {}} />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(3);
    for (const b of buttons) {
      const web = target(b, false);
      const phone = target(b, true);
      expect(web.w).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(web.h).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(phone.w).toBeGreaterThanOrEqual(MIN_TOUCH);
      // The padding that grows the press is taken back by a negative margin: the icons do not move.
      const pad = (StyleSheet.flatten(b.props.style).padding as number) ?? 0;
      expect(web.margin).toBe(-pad);
    }
  });

  it('shows the table code at a private table in landscape, never at a quick-match table nobody can join by code', async () => {
    const view = { prevailingWind: 0, handNumber: 0, dealerStreak: 0, drawsLeft: 80 } as unknown as TableView;
    const hud = (quickMatch: boolean) => (
      <TableHud view={view} roomCode="6TYR8N" quickMatch={quickMatch} portrait={false} clock={{ deadline: null, total: 15, bank: false }} myMove={false} timeBank={0} status={null} emotesOpen={false} onEmotes={() => {}} coachAllowed coachOpen={false} onCoach={() => {}} onLeave={() => {}} />
    );
    await render(hud(false));
    expect(screen.getByText('6TYR8N')).toBeOnTheScreen();
    await screen.rerender(hud(true));
    expect(screen.queryByText('6TYR8N')).toBeNull();
  });
});

describe('the HUD’s status line (short landscape)', () => {
  it('takes up to three short lines rather than end before the tile, no taller than the HUD’s icons', async () => {
    const view = { prevailingWind: 0, handNumber: 0, dealerStreak: 0, drawsLeft: 80 } as unknown as TableView;
    await render(
      <TableHud view={view} roomCode="ABCD" quickMatch={false} portrait={false} oneRow clock={{ deadline: null, total: 15, bank: false }} myMove={false} timeBank={0} status="阿花 (Bot) discarded 4 Character" emotesOpen={false} onEmotes={() => {}} coachAllowed coachOpen={false} onCoach={() => {}} onLeave={() => {}} />,
    );
    const text = screen.getByText('阿花 (Bot) discarded 4 Character');
    expect(text.props.numberOfLines).toBe(3);
    const line = StyleSheet.flatten(text.props.style) as { lineHeight: number };
    const pill = StyleSheet.flatten(screen.getByTestId('table-status').props.style) as { paddingVertical: number };
    // Three lines and the pill's padding stay under the 40 pt icons, so the felt keeps its height between turns.
    expect(3 * line.lineHeight + 2 * pill.paddingVertical).toBeLessThanOrEqual(40);
  });
});
