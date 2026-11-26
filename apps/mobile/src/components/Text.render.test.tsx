import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StyleSheet, type TextStyle } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { Hint } from '@mjm/engine';
import { CJK_FACE, Text } from './Text';
import { CoachPanel } from './table/CoachPanel';
import { CJK_WEIGHT, fonts } from '../theme';
import { setLocalePreference } from '../i18n';
import { FakeProviders } from '../test/providers';
import { DEFAULT_PROFILE, DEFAULT_PROGRESS } from '../storage';
import { HomeScreen } from '../screens/HomeScreen';
import { LearnScreen } from '../screens/LearnScreen';
import { resetAgeGateForTests } from '../legal/useAgeGate';

/**
 * The app's Text (./Text.tsx): Chinese in a Latin face takes the system's Chinese face, heavy, and its strings keep scoring
 * terms, tile names and numbers with units whole. Then whole screens in Traditional Chinese: no Chinese character drawn in
 * a Latin face, whose fallback for it is thin (the showcase review of 20 November).
 */

jest.setTimeout(30_000);

type Node = { type: unknown; props: { style?: unknown; children?: unknown }; children: Array<Node | string> };

const HAN = /[㐀-鿿]/;
const LATIN = new Set(Object.keys(CJK_WEIGHT));

/** Every Chinese string drawn in a Latin face, with the face: a host Text's own strings, in its face or the one it inherits. */
function thinChinese(node: Node | string, inherited?: string): string[] {
  if (typeof node === 'string') return [];
  const isText = node.type === 'Text';
  const own = isText ? (StyleSheet.flatten(node.props.style as TextStyle) ?? {}).fontFamily : undefined;
  const face = isText ? (own ?? inherited) : inherited;
  const here = isText && face && LATIN.has(face) ? node.children.filter((c): c is string => typeof c === 'string' && HAN.test(c)).map((c) => `${face}: ${c}`) : [];
  return [...here, ...node.children.flatMap((c) => thinChinese(c, face))];
}

/** The host Text drawing `text` (a whole string, as written), flattened style. */
function styleOf(text: string): TextStyle {
  return StyleSheet.flatten(screen.getByText(text).props.style as TextStyle) ?? {};
}

afterEach(() => {
  setLocalePreference('auto');
});

describe("the app's Text", () => {
  it('draws Chinese set in a display face in the Chinese face, heavy', async () => {
    await render(<Text style={{ fontFamily: fonts.display, fontSize: 19 }}>每日謎題</Text>);
    expect(styleOf('每日謎題')).toMatchObject({ fontFamily: CJK_FACE, fontWeight: '900', fontSize: 19 });
  });

  it('keeps an English title in its face, and puts a Chinese word inside it in the Chinese face', async () => {
    await render(<Text style={{ fontFamily: fonts.uiBold }}>Mei-Ling wins (胡牌)</Text>);
    expect(styleOf('Mei-Ling wins (胡牌)')).toMatchObject({ fontFamily: fonts.uiBold });
    expect(styleOf('胡牌')).toMatchObject({ fontFamily: CJK_FACE, fontWeight: '900' });
    await render(<Text style={{ fontFamily: fonts.display }}>Flowers</Text>);
    expect(styleOf('Flowers')).toEqual({ fontFamily: fonts.display });
  });

  it('weighs body text lighter than titles, and leaves text that names no Latin face alone', async () => {
    await render(<Text style={{ fontFamily: fonts.body }}>每天一題、人人同題，連續紀錄別中斷！</Text>);
    expect(styleOf('每天一題、人人同題，連續紀錄別中斷！')).toMatchObject({ fontFamily: CJK_FACE, fontWeight: '700' });
    await render(<Text style={{ fontWeight: '700' }}>差一張就聽牌了。</Text>);
    expect(styleOf('差一張就聽牌了。')).toEqual({ fontWeight: '700' });
  });

  it('gives Text nested in a Text the face it inherits', async () => {
    await render(
      <Text style={{ fontFamily: fonts.display }}>
        Round <Text style={{ color: 'red' }}>東風圈</Text>
      </Text>,
    );
    expect(styleOf('東風圈')).toMatchObject({ fontFamily: CJK_FACE, fontWeight: '900', color: 'red' });
  });

  it('keeps scoring terms, tile names and numbers with their units whole', async () => {
    await render(<Text>開槓可以補一張牌，補到胡牌還能加槓上開花（1 台）。</Text>);
    const drawn = String(screen.getByText(/槓上開花/).props.children);
    expect(drawn).toContain('槓⁠上⁠開⁠花');
    expect(drawn).toContain('（1 台）');
    await render(<Text>阿花 (Bot) discarded 9 Dot</Text>);
    expect(String(screen.getByText(/discarded/).props.children)).toContain('9 Dot');
  });
});

describe('screens in Traditional Chinese', () => {
  beforeEach(async () => {
    setLocalePreference('zh-TW');
    await AsyncStorage.clear();
    await AsyncStorage.setItem('mjm.age', JSON.stringify({ birthYear: 1990, at: 0, synced: true }));
    resetAgeGateForTests();
  });

  // Before 26 November 2026: 每日謎題, 謎題衝刺, 打哪張？ and the lesson titles (Lilita, Fredoka) drew thin.
  it('Learn: every card and lesson title in a heavy face', async () => {
    await render(
      <FakeProviders app={{ progress: DEFAULT_PROGRESS, screen: { name: 'learn' } }}>
        <LearnScreen />
      </FakeProviders>,
    );
    expect(screen.getByText('打哪張？')).toBeOnTheScreen();
    expect(thinChinese(screen.root as unknown as Node)).toEqual([]);
  });

  // Before: Home's 俱樂部, 學習 and 商店 kept Lilita with weight 900, which iOS draws in PingFang's regular weight.
  it('Home: the cards and the rules line', async () => {
    await render(
      <FakeProviders app={{ profile: { ...DEFAULT_PROFILE, name: '美玲' } }}>
        <HomeScreen />
      </FakeProviders>,
    );
    await screen.findByTestId('open-learn');
    expect(screen.getByText('去上課')).toBeOnTheScreen();
    expect(thinChinese(screen.root as unknown as Node)).toEqual([]);
  });

  // Before: the 教練 heading (Lilita) and the coach's first line (Fredoka) drew thin.
  it("the coach's panel", async () => {
    const hint: Hint = {
      seat: 0,
      phase: 'discard',
      shanten: 1,
      status: '',
      statusKey: 'hint.status.oneAway',
      statusParams: {},
      waits: [],
      discards: [],
      claims: [],
      valueTiles: [],
      discardReasonKey: 'hint.discard.isolated',
      discardReasonParams: { tile: 'N', tileName: '北 (North)', tileZh: '北' },
    } as unknown as Hint;
    await render(<CoachPanel hint={hint} onOpen={() => undefined} />);
    expect(screen.getByText('教練')).toBeOnTheScreen();
    expect(screen.getByText('差一張就聽牌了。')).toBeOnTheScreen();
    expect(thinChinese(screen.root as unknown as Node)).toEqual([]);
  });
});
