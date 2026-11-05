/**
 * Typed authentication errors. The HTTP layer answers `status` with `{error: code}`; the
 * message is for logs only, so it never says which part of a credential was wrong.
 */
export const AUTH_ERRORS = {
  /** Malformed input (missing field, wrong type). */
  invalid: 400,
  /** The provider is not configured on this server (`GET /api/config` lists the enabled ones). */
  provider_disabled: 404,
  /** Guest id and secret do not match. */
  invalid_credentials: 401,
  /** A provider id token failed verification (signature, issuer, audience, expiry or nonce). */
  invalid_token: 401,
  /** No such session token. */
  invalid_session: 401,
  session_expired: 401,
  session_revoked: 401,
  /** The token was already rotated; it works until its grace window ends but cannot be rotated again. */
  session_rotated: 401,
  not_found: 404,
  /** Sign-in with a provider identity that belongs to no account; the client offers to attach it to this guest. */
  not_linked: 404,
  /** The identity belongs to another account and this account already has a provider, so they cannot merge. */
  identity_in_use: 409,
  /** Removing this identity would leave the account with no provider to sign in with. */
  last_identity: 409,
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

export class AuthError extends Error {
  readonly status: number;

  constructor(
    public readonly code: AuthErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'AuthError';
    this.status = AUTH_ERRORS[code];
  }
}

export const isAuthError = (e: unknown): e is AuthError => e instanceof AuthError;
