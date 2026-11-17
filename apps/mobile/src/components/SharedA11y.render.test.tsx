/**
 * What a screen reader is given by the shared pieces every screen builds on: the line that speaks a result or an
 * error (Live), the shared buttons' names (Ui.tsx) and the names of tiles that are only shown, not pressed (Tile).
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo, Platform, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { kindFromCode } from '@mjm/engine';
import { Live } from './Live';
import { Button, IconButton } from './Ui';
import { Tile } from './Tile';
import { setLocalePreference } from '../i18n';

/** Platform.OS for one test (jest-expo runs as iOS); put back after each test. */
const realOS = Platform.OS;
function setOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}
afterEach(() => setOS(realOS));

afterEach(() => {
  jest.restoreAllMocks();
  setLocalePreference('auto');
});

function onPlatform(os: 'ios' | 'android') {
  setOS(os);
  return jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
}

describe('a live line (results and errors away from the table)', () => {
  it('is a polite live region on Android and the web, and says nothing itself there', async () => {
    const said = onPlatform('android');
    await render(
      <Live message="Saved" testID="line">
        <Text>Saved</Text>
      </Live>,
    );
    expect(screen.getByTestId('line').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('line').props.accessibilityRole).toBeUndefined();
    // Android reads the region on its own; an announcement as well would read it twice.
    expect(said).not.toHaveBeenCalled();
  });

  it('is an assertive alert when it reports an error', async () => {
    onPlatform('android');
    await render(
      <Live message="That code is not a club" assertive testID="line">
        <Text>That code is not a club</Text>
      </Live>,
    );
    const line = screen.getByTestId('line');
    expect(line.props.accessibilityLiveRegion).toBe('assertive');
    expect(line.props.accessibilityRole).toBe('alert');
    expect(line).toHaveTextContent('That code is not a club');
  });

  it('is announced on iOS, which ignores live regions, each time its words change', async () => {
    const said = onPlatform('ios');
    const line = (message: string | null) => (
      <Live message={message}>
        <Text>{message}</Text>
      </Live>
    );
    await render(line(null));
    expect(said).not.toHaveBeenCalled();
    await screen.rerender(line('Correct'));
    await screen.rerender(line('Not quite'));
    expect(said.mock.calls).toEqual([['Correct'], ['Not quite']]);
  });
});

describe('the shared buttons', () => {
  it('are named after their title, or the label given in its place', async () => {
    await render(<Button title="Play" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeOnTheScreen();
    await render(<Button title="Open" accessibilityLabel="Open: Find the waits" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open: Find the waits' })).toBeOnTheScreen();
  });

  it('name an icon button after its label, or after its icon when it has none', async () => {
    await render(<IconButton icon="cog" label="Table settings" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Table settings' })).toBeOnTheScreen();
    await render(<IconButton icon="cog" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeOnTheScreen();
  });
});

describe('tiles a screen reader meets', () => {
  it('names a tile that is only shown (a pond, a meld, the win reveal) as an image, in the UI language', async () => {
    await render(<Tile kind={kindFromCode('E')} />);
    expect(screen.getByRole('image', { name: 'East Wind' })).toBeOnTheScreen();
    setLocalePreference('zh-TW');
    await render(<Tile kind={kindFromCode('5m')} />);
    expect(screen.getByRole('image', { name: '五萬' })).toBeOnTheScreen();
  });

  it('names a tile in the hand in the UI language too, not in English', async () => {
    setLocalePreference('zh-TW');
    await render(<Tile kind={kindFromCode('E')} onPress={() => {}} />);
    expect(screen.getByRole('button', { name: '東' })).toBeOnTheScreen();
    expect(screen.queryByRole('image')).toBeNull();
  });
});
