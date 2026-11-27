import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { TableView } from '@mjm/engine';
import { setLocalePreference } from '../i18n';
import { unjoined } from '../logic/keepWhole';
import { Compass } from './TableParts';
import { TableHud } from './table/TableHud';
import type { Relation } from './table/hudSpeech';

type Facts = { round: number; myWind: number; dealerRel: Relation; drawsLeft: number };
const compass = (f: Facts) => <Compass prevailing="東" drawsLeft={f.drawsLeft} seatWinds={['南', '西', '北', '東']} active={null} size={72} round={f.round} myWind={f.myWind} dealerRel={f.dealerRel} />;
/** The text of the hidden polite live region beside the compass (what Android and the web speak). */
const notice = (): string => {
  const live = screen.getByTestId('compass-notice');
  expect(live.props.accessibilityLiveRegion).toBe('polite');
  const text = live.children[0] as unknown as { children: unknown[] };
  // As written: the app's Text joins a count and its word with a no-break space (src/logic/keepWhole.ts).
  return unjoined(text.children.filter((c) => typeof c === 'string').join(''));
};

describe('the compass and the wall count, as a screen reader hears them', () => {
  afterEach(() => setLocalePreference('auto'));

  it('reads the compass as one labelled item: the round, my seat, where the dealer sits and the wall', async () => {
    setLocalePreference('en');
    await render(compass({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 17 }));
    const plate = screen.getByTestId('compass');
    expect(plate.props.accessible).toBe(true);
    expect(plate.props.accessibilityRole).toBe('image');
    expect(plate.props.accessibilityLabel).toBe('East round, you are South, the dealer is on your left. 17 tiles left in the wall');
  });

  it('reads it in Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await render(compass({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 17 }));
    expect(screen.getByTestId('compass').props.accessibilityLabel).toBe('東風圈，你是南家，莊家是你的上家。牌牆剩 17 張');
  });

  it('speaks only when the wall drops to 10 or the seats turn, not on every draw', async () => {
    setLocalePreference('en');
    const { rerender } = await render(compass({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 12 }));
    expect(notice()).toBe('');
    await rerender(compass({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 11 }));
    expect(notice()).toBe('');
    await rerender(compass({ round: 0, myWind: 1, dealerRel: 3, drawsLeft: 10 }));
    expect(notice()).toBe('10 tiles left in the wall');
    // The next hand: a new wall says nothing, the new dealer is said.
    await rerender(compass({ round: 0, myWind: 0, dealerRel: 0, drawsLeft: 56 }));
    expect(notice()).toBe('East round, you are East and the dealer');
  });

  it("labels the HUD's wall chip and round chip in words, so a screen reader does not hear a bare number or 東", async () => {
    setLocalePreference('en');
    const view = { prevailingWind: 1, handNumber: 2, dealerStreak: 0, drawsLeft: 17 } as unknown as TableView;
    await render(
      <TableHud view={view} roomCode="ABCD" quickMatch portrait clock={{ deadline: null, total: 15, bank: false }} myMove={false} timeBank={0} status={null} emotesOpen={false} onEmotes={() => {}} coachAllowed coachOpen={false} onCoach={() => {}} onLeave={() => {}} />,
    );
    const wall = screen.getByTestId('hud-wall');
    expect(wall.props.accessibilityRole).toBe('image');
    expect(wall.props.accessibilityLabel).toBe('17 tiles left in the wall');
    expect(screen.getByLabelText('South round, hand 3')).toBeTruthy();
  });
});
