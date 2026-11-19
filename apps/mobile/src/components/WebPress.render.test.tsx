/**
 * The web ignores hitSlop, so a control drawn under 44 px is padded to a 44 px press there, with an equal negative
 * margin that keeps its place in the layout (Ui.tsx webPress), as the table's HUD icons are. A phone keeps its hitSlop.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { Button, Chip, GemCounter, Stepper, webPress } from './Ui';

const realOS = Platform.OS;
function onPlatform(os: 'ios' | 'android' | 'web') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
}
afterEach(() => {
  onPlatform(realOS as 'ios');
});

describe('a press of at least 44 px on the web', () => {
  it('pads a short control by half the difference each way, or all of it above, and leaves a 44 px one alone', () => {
    onPlatform('web');
    expect(webPress(34)).toEqual({ paddingVertical: 5, marginVertical: -5, minHeight: 44 });
    expect(webPress(42, true)).toEqual({ paddingTop: 2, marginTop: -2, minHeight: 44 });
    expect(webPress(44)).toBeUndefined();
    expect(webPress(53)).toBeUndefined();
    onPlatform('ios');
    expect(webPress(34)).toBeUndefined();
  });

  it('pads Home’s and Settings’ chips, small buttons, the stepper’s value and the diamond counter', async () => {
    onPlatform('web');
    await render(
      <>
        <Chip label="Beginner" selected onPress={() => {}} />
        <Button small title="Open" onPress={() => {}} />
        <Stepper label="Starting points" value={100} onChange={() => {}} />
        <GemCounter amount={0} onPress={() => {}} testID="gems" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Beginner' })).toHaveStyle({ paddingVertical: 5, marginVertical: -5, minHeight: 44 });
    expect(screen.getByRole('button', { name: 'Open' })).toHaveStyle({ paddingTop: 2, marginTop: -2, minHeight: 44 });
    expect(screen.getByRole('button', { name: 'Starting points: 100' })).toHaveStyle({ paddingVertical: 10, marginVertical: -10, minHeight: 44 });
    expect(screen.getByTestId('gems')).toHaveStyle({ paddingVertical: 2, marginVertical: -2, minHeight: 44 });
  });

  it('keeps hitSlop alone on a phone', async () => {
    onPlatform('ios');
    await render(<Chip label="Beginner" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Beginner' })).not.toHaveStyle({ minHeight: 44 });
  });
});
