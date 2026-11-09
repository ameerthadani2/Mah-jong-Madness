import { describe, expect, it } from 'vitest';
import { canConfirmDeletion, deletionLosses, manageSubscriptionUrl } from './deletion';
import { EMPTY_WALLET, mirrorMe, type MeWallet } from './wallet';

const S = Date.parse('2026-11-09T12:00:00.000Z');
const me = (extra: Partial<MeWallet>): MeWallet => ({ user: { id: 'u1' }, wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], serverNow: '2026-11-09T12:00:00.000Z', ...extra });

describe('account deletion with a live subscription', () => {
  it('shows the live plan and its renewal, and needs the billing acknowledgement before deleting', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ wallet: { diamonds: 250, bonusDiamonds: 50 }, entitlements: [{ entitlement: 'fourwinds.month', expiresAt: '2026-12-01T00:00:00.000Z' }], cosmetics: ['theme.jade'] }), S);
    const losses = deletionLosses(w, S);
    expect(losses).toEqual({ subscription: { tier: 'fourwinds', renewsAt: Date.parse('2026-12-01T00:00:00.000Z') }, diamonds: 300, looks: 1, needsSubscriptionAck: true });
    expect(canConfirmDeletion('DELETE', 'DELETE', losses, false)).toBe(false);
    expect(canConfirmDeletion('DELETE', 'DELETE', losses, true)).toBe(true);
    expect(canConfirmDeletion('DELET', 'DELETE', losses, true)).toBe(false);
  });

  it('without a plan the typed word is enough', () => {
    const losses = deletionLosses(mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'coach.gold.month', expiresAt: '2026-11-01T00:00:00.000Z' }] }), S), S);
    expect(losses.subscription).toBeNull();
    expect(canConfirmDeletion(' DELETE ', 'DELETE', losses, false)).toBe(true);
  });

  it('links to the store page that cancels the subscription', () => {
    expect(manageSubscriptionUrl('ios')).toBe('https://apps.apple.com/account/subscriptions');
    expect(manageSubscriptionUrl('android')).toBe('https://play.google.com/store/account/subscriptions');
    expect(manageSubscriptionUrl('web')).toBe('https://apps.apple.com/account/subscriptions');
  });
});
