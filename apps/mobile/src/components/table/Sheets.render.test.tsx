import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { Platform } from 'react-native';
import { render, screen, within } from '@testing-library/react-native';
import { LeaveSheet } from './LeaveSheet';
import { ConfirmSheet } from './ConfirmSheet';
import { LegalScreen } from '../../legal/LegalScreen';
import { FakeProviders } from '../../test/providers';

/**
 * The exit sheet, a yes/no question (Home's replace-table question) and the legal sheet, as a screen reader and the
 * keyboard meet them on the web: each dialog has a name (react-native-web makes the Modal the dialog, so it takes the
 * name), its question is a heading, and the legal sheet's Back is outside its scroll box (the sheet's focus trap then
 * moves Tab and Shift+Tab between the two both ways; with Back inside it, the box itself was the trap's first and last stop).
 */
const realOS = Platform.OS;
function setOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}
afterEach(() => setOS(realOS));

/** The props of the rendered Modal (the host element react-native's Modal draws), searched from the root. */
function modalProps(): Record<string, unknown> {
  type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  const find = (n: Node): Node | null => {
    if (n && typeof n === 'object' && n.type === 'Modal') return n;
    for (const c of n?.children ?? []) {
      const hit = typeof c === 'object' && c ? find(c as Node) : null;
      if (hit) return hit;
    }
    return null;
  };
  const modal = find(screen.root as unknown as Node);
  if (!modal?.props) throw new Error('no Modal rendered');
  return modal.props;
}
const modalName = () => modalProps()['aria-label'];

describe('the sheets are named dialogs', () => {
  it('the exit sheet: named by its question on the web, which is a heading', async () => {
    setOS('web');
    await render(<LeaveSheet visible online={false} onChoose={() => undefined} />);
    expect(modalName()).toBe('Leave the table?');
    expect(within(screen.getByTestId('leave-sheet')).getByRole('header')).toHaveTextContent('Leave the table?');
  });

  it("Home's replace-table question: named by the question on the web, which is a heading", async () => {
    setOS('web');
    await render(<ConfirmSheet visible title="Start a new match?" body="The table you left will end." yes="Start new match" no="Keep it" onYes={() => undefined} onNo={() => undefined} testID="replace-table" />);
    expect(modalName()).toBe('Start a new match?');
    expect(within(screen.getByTestId('replace-table')).getByRole('header')).toHaveTextContent('Start a new match?');
  });

  it('on a phone the Modal is a window of its own and takes no web name', async () => {
    setOS('ios');
    await render(<LeaveSheet visible online={false} onChoose={() => undefined} />);
    expect(modalName()).toBeUndefined();
  });
});

describe('the legal sheet', () => {
  it('keeps Back outside the scroll box that holds the text', async () => {
    await render(
      <FakeProviders>
        <LegalScreen doc="terms" onBack={() => undefined} />
      </FakeProviders>,
    );
    const box = screen.getByTestId('legal-terms');
    expect(screen.getByTestId('legal-back')).toBeOnTheScreen();
    expect(within(box).queryByTestId('legal-back')).toBeNull();
  });
});
