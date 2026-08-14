// Single source of truth for JWT secret/expiry. Every module that needs to sign or verify
// the access token (currently just AuthModule - see AuthModule's `exports: [JwtModule]`,
// which other modules should import instead of registering their own JwtModule) must go
// through this file, so the secret and token lifetime can never drift between modules.

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
// 90 days: refresh token rotation already gives a sliding window (every refresh — proactive
// or on app open — reissues a fresh 90-day token), so in practice a user who opens the app
// at least once every 90 days never sees the login screen again. This TTL is only the hard
// cap for continuous inactivity beyond that.
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const DEV_ONLY_FALLBACK_SECRET =
  'dev-only-insecure-jwt-secret-set-JWT_SECRET-in-env';

/**
 * Resolves the JWT signing secret. In production, a missing `JWT_SECRET` throws instead of
 * silently falling back to a known default - a hardcoded fallback would let anyone who has
 * read the source code forge valid tokens (including admin tokens) for a misconfigured
 * deployment. This is evaluated at module-load time (see AuthModule), so a misconfigured
 * production deploy fails at boot rather than serving requests with a forgeable secret.
 */
export function getJwtSecret(): string {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not configured. Refusing to start in production without it.',
    );
  }

  return DEV_ONLY_FALLBACK_SECRET;
}
