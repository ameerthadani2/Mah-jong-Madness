/**
 * What deleting the account takes with it, for the confirmation in Settings → Account. A live
 * subscription is billed by the App Store or Google Play, not by us, so deleting the account
 * does not stop it: the player is shown the plan, a link to the store's subscription page, and
 * must confirm they understand before the delete button works.
 *
 * Pure TypeScript, unit-tested.
 */
import type { CoachTier } from './catalog';
import { coachRenewal, coachTier, totalDiamonds, trustedNow, type Wallet } from './wallet';

/** The platform pages where a player cancels a subscription. */
export const MANAGE_SUBSCRIPTION_URLS = {
  ios: 'https://apps.apple.com/account/subscriptions',
  android: 'https://play.google.com/store/account/subscriptions',
} as const;

/** The store page that manages this platform's subscriptions (the App Store page on the web). */
export function manageSubscriptionUrl(platform: string): string {
  return platform === 'android' ? MANAGE_SUBSCRIPTION_URLS.android : MANAGE_SUBSCRIPTION_URLS.ios;
}

export interface DeletionLosses {
  /** The live plan, or null when there is none. */
  subscription: { tier: Exclude<CoachTier, 'free'>; renewsAt: number | null } | null;
  diamonds: number;
  looks: number;
  /** True when the confirmation must also include the subscription acknowledgement. */
  needsSubscriptionAck: boolean;
}

export function deletionLosses(wallet: Wallet, now: number = trustedNow(wallet)): DeletionLosses {
  const tier = coachTier(wallet, now);
  const subscription = tier === 'free' ? null : { tier, renewsAt: coachRenewal(wallet, now) };
  return { subscription, diamonds: totalDiamonds(wallet), looks: wallet.cosmetics.length, needsSubscriptionAck: subscription !== null };
}

/** The delete button works once the word is typed and, with a live plan, the billing notice is acknowledged. */
export function canConfirmDeletion(typed: string, word: string, losses: DeletionLosses, acknowledged: boolean): boolean {
  return typed.trim() === word && (!losses.needsSubscriptionAck || acknowledged);
}
