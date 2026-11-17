import { describe, expect, it, jest } from '@jest/globals';
import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccountCard } from './AccountCard';
import { FakeProviders } from '../test/providers';
import type { AuthContextValue } from '../auth/AuthProvider';
import { EMPTY_WALLET, type Wallet } from '../monetisation/wallet';

/**
 * Settings → Account against a faked sign-in layer: a small stand-in for the auth provider that changes its state the
 * way the real one does (busy while a call is out, then the account it signed in to, or the error it hit), so the card
 * is seen to follow each step of signing in, linking, signing out and deleting the account.
 */
type Auth = Partial<AuthContextValue>;
type Step = (set: (next: Auth) => void, auth: Auth) => Promise<boolean>;

const GUEST: Auth = { status: 'guest', user: { id: 'u-guest-1', displayName: 'Mei', kind: 'guest' }, providers: [{ id: 'apple', linked: false }, { id: 'google', linked: false }], linkedCount: 0 };
const ACCOUNT: Auth = { status: 'account', user: { id: 'u-acct-1', displayName: 'Mei', kind: 'account' }, providers: [{ id: 'apple', linked: true }, { id: 'google', linked: true }], linkedCount: 2 };

/** One server round trip: busy first, then what the call left behind. */
function call(after: (auth: Auth) => Auth, ok = true): Step & jest.Mock {
  return jest.fn<Step>(async (set, auth) => {
    set({ ...auth, busy: true, error: null });
    await Promise.resolve();
    set({ ...after(auth), busy: false });
    return ok;
  }) as Step & jest.Mock;
}

function renderCard(initial: Auth, steps: Partial<Record<'signInApple' | 'signInGoogle' | 'signOut' | 'deleteAccount', Step>> & { unlink?: (set: (a: Auth) => void, auth: Auth, p: string) => Promise<boolean> } = {}, wallet: Wallet = EMPTY_WALLET) {
  const refresh = jest.fn(async () => undefined);
  function Harness() {
    const [auth, setAuth] = useState<Auth>(initial);
    const wire = (name: keyof typeof steps) => (...args: unknown[]) => (steps[name] as (...a: unknown[]) => Promise<boolean>)?.(setAuth, auth, ...args) ?? Promise.resolve(true);
    const value: Auth = { ...auth, refresh, signInApple: wire('signInApple'), signInGoogle: wire('signInGoogle'), signOut: wire('signOut'), deleteAccount: wire('deleteAccount'), unlink: wire('unlink') as AuthContextValue['unlink'] };
    return (
      <FakeProviders app={{ wallet }} auth={value}>
        <AccountCard />
      </FakeProviders>
    );
  }
  return { refresh, rendered: render(<Harness />) };
}
const settle = () => act(async () => undefined);

describe('the account card', () => {
  it('offline: says so, and offers neither sign-in, sign-out nor deletion', async () => {
    const { refresh, rendered } = renderCard({ status: 'offline' });
    await rendered;
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText(/Not connected to the game server yet/)).toBeOnTheScreen();
    for (const name of ['Sign in with Apple', 'Sign in with Google', 'Sign out', 'Delete account']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('a guest signs in with Google: Working… while it runs, then Signed in with Google linked', async () => {
    const signInGoogle = call((a) => ({ ...a, status: 'account', user: { id: 'u-guest-1', displayName: 'Mei', kind: 'account' }, providers: [{ id: 'apple', linked: false }, { id: 'google', linked: true }], linkedCount: 1 }));
    await renderCard(GUEST, { signInGoogle }).rendered;
    expect(screen.getByText('Guest account')).toBeOnTheScreen();
    expect(screen.getByText('Player id: u-guest-1')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in with Google' }));
    await settle();
    expect(signInGoogle).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Signed in')).toBeOnTheScreen();
    expect(screen.getByText('Google linked')).toBeOnTheScreen();
    // Apple can still be added; with one way in, Google cannot be removed.
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows Working… and holds the buttons while a sign-in is out', async () => {
    let finish!: () => void;
    const signInApple: Step = async (set, auth) => {
      set({ ...auth, busy: true });
      await new Promise<void>((r) => (finish = r));
      set({ ...auth, busy: false });
      return true;
    };
    await renderCard(GUEST, { signInApple }).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in with Apple' }));
    expect(screen.getByText('Working…')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await act(async () => finish());
    expect(screen.queryByText('Working…')).toBeNull();
  });

  it('a failed sign-in is spoken at once, and a cancelled one leaves no banner', async () => {
    const signInApple = call((a) => ({ ...a, error: Object.assign(new Error('Network request failed'), { name: 'TypeError' }) }), false);
    await renderCard(GUEST, { signInApple }).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in with Apple' }));
    await settle();
    const banner = screen.getByTestId('account-error');
    expect(banner.props.accessibilityLiveRegion).toBe('assertive');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(screen.getByText('Guest account')).toBeOnTheScreen();
  });

  it('a banned account says so once, with no second banner for the refusal that revealed it', async () => {
    await renderCard({ ...GUEST, status: 'signed_out', banned: true, error: { code: 'banned', message: 'banned' } }).rendered;
    expect(screen.getByTestId('account-banned')).toBeOnTheScreen();
    expect(screen.queryByTestId('account-error')).toBeNull();
  });

  it('with two ways in, either can be removed', async () => {
    const unlink = jest.fn(async (set: (a: Auth) => void, auth: Auth, p: string) => {
      set({ ...auth, providers: auth.providers!.map((x) => (x.id === p ? { ...x, linked: false } : x)), linkedCount: 1 });
      return true;
    });
    await renderCard(ACCOUNT, { unlink }).rendered;
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    await fireEvent.press(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await settle();
    expect(unlink.mock.calls[0][2]).toBe('apple');
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('a guest is warned before signing out; Cancel keeps it, Sign out anyway signs out', async () => {
    const signOut = call((a) => ({ ...a, status: 'offline', user: null, providers: [] }));
    await renderCard(GUEST, { signOut }).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByText(/this guest cannot be recovered afterwards/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/this guest cannot be recovered afterwards/)).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out anyway' }));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a signed-in account signs out without the guest warning', async () => {
    const signOut = call((a) => ({ ...a, status: 'offline', user: null, providers: [] }));
    await renderCard(ACCOUNT, { signOut }).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/cannot be recovered/)).toBeNull();
  });

  it('deleting the account takes the typed word, then says it is done in a polite live region', async () => {
    const deleteAccount = call((a) => ({ ...a, status: 'offline', user: null, providers: [], linkedCount: 0 }));
    await renderCard(ACCOUNT, { deleteAccount }).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));
    const confirm = () => screen.getByRole('button', { name: 'Delete for good' });
    expect(confirm()).toBeDisabled();
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELET');
    expect(confirm()).toBeDisabled();
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    expect(confirm()).toBeEnabled();
    await fireEvent.press(confirm());
    await settle();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    const notice = screen.getByTestId('account-notice');
    expect(notice.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText('Your account has been deleted.')).toBeOnTheScreen();
  });

  it('with a live plan, deletion also needs the billing notice acknowledged', async () => {
    const wallet: Wallet = { ...EMPTY_WALLET, entitlements: [{ entitlement: 'coach.gold.month', expiresAt: Date.now() + 10 * 86_400_000 }] };
    const deleteAccount = call((a) => a);
    await renderCard(ACCOUNT, { deleteAccount }, wallet).rendered;
    await fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));
    expect(screen.getByTestId('delete-subscription')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    expect(screen.getByRole('button', { name: 'Delete for good' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete for good' })).toBeEnabled();
    // Cancel closes the form and deletes nothing.
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('delete-subscription')).toBeNull();
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});
