import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { TileId } from '@mjm/engine';
import { setLocalePreference } from '../i18n';
import { DiscardPool, earlierChip } from './TableParts';

/**
 * A pond keeping only its newest rows (the portrait felt on a small phone, display/portraitFit.ts): the newest discard
 * is always drawn, and a chip in the first place left says how many earlier ones are not, to the eye and to a screen
 * reader, in the reader's language.
 */
const tiles = (n: number) => Array.from({ length: n }, (_, i) => (i * 4) as TileId);
const drawn = () => screen.getAllByTestId(/^tile-/).length;

describe('a pond keeping its newest rows', () => {
  afterEach(() => setLocalePreference('auto'));

  it('draws every discard and no chip when it keeps them all', async () => {
    await render(<DiscardPool tiles={tiles(10)} perRow={4} size={16} />);
    expect(drawn()).toBe(10);
    expect(screen.queryByTestId('pond-earlier')).toBeNull();
  });

  it('draws the newest rows after a "+N" chip that a screen reader hears as earlier discards not shown', async () => {
    await render(<DiscardPool tiles={tiles(10)} perRow={4} size={16} keepRows={1} latest={tiles(10)[9]} />);
    // Rows of four: the kept row is filled with the newest three, after the chip.
    expect(drawn()).toBe(3);
    const chip = screen.getByTestId('pond-earlier');
    expect(chip).toHaveTextContent('+7');
    expect(chip.props.accessibilityLabel).toBe('Earlier discards not shown: 7');
    await render(<DiscardPool tiles={tiles(12)} perRow={4} size={16} keepRows={2} />);
    // Two full rows: the first gives its oldest tile up to the chip.
    expect(screen.getByTestId('pond-earlier')).toHaveTextContent('+5');
    expect(drawn()).toBe(7);
  });

  it('puts a two-digit count under its "+" on the smallest tiles, never cut to "+…"', async () => {
    // 16 px wide: "+12" is wider than the chip on one line; "+9" fits.
    expect(earlierChip(12, 16)).toMatchObject({ text: '+\n12', lines: 2 });
    expect(earlierChip(9, 16)).toMatchObject({ text: '+9', lines: 1 });
    expect(earlierChip(12, 20)).toMatchObject({ text: '+12', lines: 1 });
    await render(<DiscardPool tiles={tiles(16)} perRow={4} size={16} keepRows={1} />);
    const text = screen.getByText('+\n13');
    expect(text.props.numberOfLines).toBe(2);
  });

  it('says it in Traditional Chinese too', async () => {
    setLocalePreference('zh-TW');
    await render(<DiscardPool tiles={tiles(9)} perRow={3} size={16} keepRows={1} />);
    expect(screen.getByTestId('pond-earlier').props.accessibilityLabel).toBe('較早的 7 張棄牌未顯示');
  });
});
