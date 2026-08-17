import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session token for the dashboard password gate.
 *
 * Why this exists: the dashboard has no user accounts, and every API route
 * returned live account balances, positions and the full trade ledger to any
 * anonymous caller. Vercel Authentication covers deployment URLs but exempts the
 * production domain on this plan, so the gate has to live in the app.
 *
 * The token is `<expiry-ms>.<hmac>`, signed with the dashboard password itself.
 * Signing the expiry is what stops a client extending its own session: change
 * the number and the signature no longer matches.
 */

const TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function sign(expiry: number, secret: string): string {
  return createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

export function issueToken(secret: string, now: number = Date.now()): string {
  const expiry = now + TTL_MS;
  return `${expiry}.${sign(expiry, secret)}`;
}

export function verifyToken(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now()
): boolean {
  // An unset password must fail CLOSED. Failing open would leave exactly the
  // hole this gate exists to close.
  if (!secret) return false;
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [expiryRaw, sig] = parts;
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry <= now) return false;

  const expected = sign(expiry, secret);
  if (sig.length !== expected.length) return false;

  // Constant-time compare so a caller cannot narrow the signature byte by byte.
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Exact paths reachable without a session. */
const PUBLIC_PATHS = new Set(['/login', '/favicon.png', '/favicon.ico', '/robots.txt']);
/** Prefixes for build output that must load so the login page can render. */
const PUBLIC_PREFIXES = ['/_app/'];

/**
 * Whether a path may be served without a session.
 *
 * Matching is exact or on an explicit prefix ending in '/', so '/loginsecrets'
 * and '/api/login' are NOT public just because they contain 'login'.
 */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}
