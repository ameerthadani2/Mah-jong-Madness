/**
 * Verifies the id tokens that Sign in with Apple, Google Sign-In and Facebook Limited Login
 * hand the app. The app sends the token (and the nonce it generated) to the server, which checks
 * the signature against the provider's published keys, then issuer, audience, expiry and nonce.
 * Only then is `sub` trusted as the identity key.
 *
 * Keys come from the provider's JWKS endpoint through jose, cached for 24 hours; if a refresh
 * fails, the last keys fetched keep working (a provider outage must not sign everyone out).
 * Tests inject a local key set instead.
 */
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { sha256Hex } from '@mjm/engine';
import { AuthError } from './errors';

export const PROVIDERS = ['apple', 'google', 'facebook'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

/** A key set to verify against: a jose key resolver, or a literal JWKS document. */
export type JwksSource = JWTVerifyGetKey | JSONWebKeySet;

export interface ProviderConfig {
  /** Sign in with Apple: the bundle id and/or Services ID the token is issued to. */
  apple?: { clientIds: string[]; jwks?: JwksSource };
  /** Google: the iOS, Android and web OAuth client ids. */
  google?: { clientIds: string[]; jwks?: JwksSource };
  /** Facebook Limited Login (OIDC): enabled only when an app id is configured. */
  facebook?: { appId: string; jwks?: JwksSource };
  /** The raw nonce the app generated for this sign-in. */
  nonce?: string;
  /** Clock for expiry checks (tests). */
  now?: () => number;
}

export interface VerifiedIdentity {
  provider: Provider;
  subject: string;
  /** Present only when the provider says the address is verified. */
  email?: string;
}

const JWKS_URLS: Record<Provider, string> = {
  apple: 'https://appleid.apple.com/auth/keys',
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  facebook: 'https://limited.facebook.com/.well-known/oauth/openid/jwks/',
};

const ISSUERS: Record<Provider, string[]> = {
  apple: ['https://appleid.apple.com'],
  google: ['https://accounts.google.com', 'accounts.google.com'],
  facebook: ['https://www.facebook.com', 'https://facebook.com'],
};

/** Asymmetric algorithms only: never 'none' or an HMAC that a public key could be abused as. */
const ALGORITHMS = ['RS256', 'ES256'];
const CLOCK_TOLERANCE_SEC = 30;
const DAY_MS = 86_400_000;

/** One remote key set per provider for the life of the process, so the cache is shared. */
const remoteSets = new Map<Provider, JWTVerifyGetKey>();

function remoteKeys(provider: Provider): JWTVerifyGetKey {
  let getKey = remoteSets.get(provider);
  if (!getKey) {
    const remote = createRemoteJWKSet(new URL(JWKS_URLS[provider]), { cacheMaxAge: DAY_MS, timeoutDuration: 5_000 });
    getKey = async (header, token) => {
      try {
        return await remote(header, token);
      } catch (e) {
        // Serve stale: keys this provider published earlier are still the provider's keys.
        const cached = remote.jwks();
        if (!cached) throw e;
        try {
          return await createLocalJWKSet(cached)(header, token);
        } catch {
          throw e;
        }
      }
    };
    remoteSets.set(provider, getKey);
  }
  return getKey;
}

function keysFor(provider: Provider, source: JwksSource | undefined): JWTVerifyGetKey {
  if (!source) return remoteKeys(provider);
  return typeof source === 'function' ? source : createLocalJWKSet(source);
}

function audiences(provider: Provider, cfg: ProviderConfig): string[] {
  if (provider === 'facebook') return cfg.facebook?.appId ? [cfg.facebook.appId] : [];
  return (cfg[provider]?.clientIds ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Which providers this configuration enables, for `GET /api/config`. */
export function enabledProviders(cfg: ProviderConfig): Provider[] {
  return PROVIDERS.filter((p) => audiences(p, cfg).length > 0);
}

/** Apple and Google may send `email_verified` as a boolean or as the string "true". */
const isTrue = (v: unknown) => v === true || v === 'true';

function describe(e: unknown): string {
  if (e instanceof errors.JWTExpired) return 'token expired';
  if (e instanceof errors.JWTClaimValidationFailed) return 'claim "' + e.claim + '" failed: ' + e.reason;
  if (e instanceof errors.JOSEError) return e.code;
  return (e as Error)?.message ?? 'verification failed';
}

export async function verifyProviderToken(provider: unknown, token: unknown, cfg: ProviderConfig): Promise<VerifiedIdentity> {
  if (!isProvider(provider)) throw new AuthError('invalid', 'Unknown provider');
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) throw new AuthError('invalid', 'Missing id token');
  const audience = audiences(provider, cfg);
  if (!audience.length) throw new AuthError('provider_disabled', provider + ' sign-in is not configured');
  const source = provider === 'facebook' ? cfg.facebook?.jwks : cfg[provider]?.jwks;

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keysFor(provider, source), {
      issuer: ISSUERS[provider],
      audience,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: CLOCK_TOLERANCE_SEC,
      ...(cfg.now ? { currentDate: new Date(cfg.now()) } : {}),
    }));
  } catch (e) {
    throw new AuthError('invalid_token', provider + ' token rejected: ' + describe(e));
  }

  // Apple puts sha256(nonce) in the token (the app passes the hash to Apple); Google and Facebook echo the nonce itself.
  const claimed = payload.nonce;
  if (cfg.nonce !== undefined) {
    const expected = provider === 'apple' ? sha256Hex(cfg.nonce) : cfg.nonce;
    if (typeof claimed !== 'string' || claimed !== expected) throw new AuthError('invalid_token', provider + ' token rejected: nonce mismatch');
  } else if (claimed !== undefined) {
    // The token was bound to a nonce we were not given, so its freshness cannot be checked.
    throw new AuthError('invalid_token', provider + ' token rejected: nonce missing from request');
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || !subject || subject.length > 255) throw new AuthError('invalid_token', provider + ' token rejected: bad subject');
  const email = typeof payload.email === 'string' && (provider === 'facebook' || isTrue(payload.email_verified)) ? payload.email.slice(0, 320) : undefined;
  return email ? { provider, subject, email } : { provider, subject };
}
