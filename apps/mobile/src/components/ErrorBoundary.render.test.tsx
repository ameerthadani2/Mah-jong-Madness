import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ErrorBoundary } from './ErrorBoundary';

function Broken(): React.ReactElement {
  throw new Error('this screen broke');
}

async function renderBroken() {
  const onHome = jest.fn();
  const onClearTable = jest.fn();
  // React logs the caught error; the test expects it, so keep the run's output clean.
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
  await render(
    <ErrorBoundary resetKey="home" onHome={onHome} onClearTable={onClearTable}>
      <Broken />
    </ErrorBoundary>,
  );
  quiet.mockRestore();
  return { onHome, onClearTable };
}

describe('the error screen', () => {
  it('shows the screen while nothing has failed', async () => {
    await render(
      <ErrorBoundary resetKey="home" onHome={() => {}} onClearTable={() => {}}>
        <Text>Home</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Home')).toBeOnTheScreen();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('replaces a screen that throws with a card that offers both ways out', async () => {
    await renderBroken();
    expect(screen.getByText('Something went wrong')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Home' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Clear saved table and go Home' })).toBeOnTheScreen();
  });

  it('goes Home without touching the saved table', async () => {
    const { onHome, onClearTable } = await renderBroken();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Home' }));
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onClearTable).not.toHaveBeenCalled();
  });

  it('clears the saved table only when asked to', async () => {
    const { onHome, onClearTable } = await renderBroken();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear saved table and go Home' }));
    expect(onClearTable).toHaveBeenCalledTimes(1);
    expect(onHome).not.toHaveBeenCalled();
  });
});
