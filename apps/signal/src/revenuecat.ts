/**
 * RevenueCat webhooks (v1): authentication and the mapping from RevenueCat's event payload to
 * the vendor-neutral `StoreEvent` that WalletService applies. Swapping vendors means replacing
 * this file, not the wallet.
 *
 * RevenueCat posts `{ api_version: "1.0", event: { id, type, app_user_id, original_app_user_id,
 * aliases, product_id, transaction_id, purchased_at_ms, expiration_at_ms, store, environment,
 * price_in_purchased_currency, currency, cancel_reason, transferred_from, transferred_to, … } }`
 * with the Authorization header value configured in its dashboard; we expect
 * `Bearer <REVENUECAT_WEBHOOK_SECRET>`. The app configures the SDK with our user id as the app
 * user id, so `app_user_id` is the account to grant.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { StoreEvent } from './wallet';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 255): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => x !== null) : []);

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function webhookAuthorised(header: string | string[] | undefined, secret: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(.+?)\s*$/i.exec(raw ?? '');
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** The StoreEvent in a RevenueCat webhook body, or null when the body is not one. */
export function parseRevenueCatWebhook(body: unknown): StoreEvent | null {
  if (!isObject(body) || !isObject(body.event)) return null;
  const ev = body.event;
  const eventId = str(ev.id);
  const type = str(ev.type, 64);
  if (!eventId || !type) return null;
  const userIds = [str(ev.app_user_id), str(ev.original_app_user_id), ...strings(ev.aliases)].filter((x): x is string => x !== null);
  const price = num(ev.price_in_purchased_currency) ?? num(ev.price);
  const currency = num(ev.price_in_purchased_currency) !== null ? str(ev.currency, 3) : num(ev.price) !== null ? 'USD' : null;
  return {
    vendor: 'revenuecat',
    eventId,
    type: type.toUpperCase(),
    userIds: [...new Set(userIds)],
    storeProductId: str(ev.product_id),
    transactionId: str(ev.transaction_id),
    expiresAt: ms(ev.expiration_at_ms),
    purchasedAt: ms(ev.purchased_at_ms),
    price,
    currency: currency ? currency.toUpperCase() : null,
    store: (str(ev.store, 32) ?? 'unknown').toLowerCase(),
    environment: str(ev.environment, 32),
    cancelReason: str(ev.cancel_reason, 64),
    transferredFrom: strings(ev.transferred_from),
    transferredTo: strings(ev.transferred_to),
    raw: body,
  };
}
