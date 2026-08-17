import { describe, it, expect } from 'vitest';
import { issueToken, verifyToken, isPublicPath } from './token';

const SECRET = 'correct-horse-battery-staple';

describe('issueToken / verifyToken', () => {
  it('accepts a token it just issued', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    const t = issueToken(SECRET, now);
    expect(verifyToken(t, SECRET, now)).toBe(true);
  });

  it('REJECTS a token signed with a different secret', () => {
    // The whole point: possession of the cookie must not be enough, the
    // signature must match the server's secret.
    const now = Date.parse('2026-08-17T12:00:00Z');
    const t = issueToken('some-other-password', now);
    expect(verifyToken(t, SECRET, now)).toBe(false);
  });

  it('REJECTS a token whose expiry has been tampered with', () => {
    // Forging a longer life must invalidate the signature, not extend access.
    const now = Date.parse('2026-08-17T12:00:00Z');
    const t = issueToken(SECRET, now);
    const [exp, sig] = t.split('.');
    const forged = `${Number(exp) + 86_400_000}.${sig}`;
    expect(verifyToken(forged, SECRET, now)).toBe(false);
  });

  it('REJECTS an expired token', () => {
    const issued = Date.parse('2026-08-17T12:00:00Z');
    const t = issueToken(SECRET, issued);
    const muchLater = issued + 31 * 24 * 3600 * 1000;
    expect(verifyToken(t, SECRET, muchLater)).toBe(false);
  });

  it('REJECTS malformed input rather than throwing', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    for (const bad of ['', 'garbage', 'a.b.c', '.', 'null.null', 'NaN.deadbeef']) {
      expect(verifyToken(bad, SECRET, now)).toBe(false);
    }
  });

  it('REJECTS everything when the secret is empty', () => {
    // An unset DASHBOARD_PASSWORD must fail CLOSED. Failing open would leave the
    // exact hole this exists to close.
    const now = Date.parse('2026-08-17T12:00:00Z');
    expect(verifyToken(issueToken('', now), '', now)).toBe(false);
  });
});

describe('isPublicPath', () => {
  it('lets the login page through, or nobody could ever log in', () => {
    expect(isPublicPath('/login')).toBe(true);
  });

  it('lets build assets through so the login page can render', () => {
    expect(isPublicPath('/_app/immutable/entry/start.js')).toBe(true);
    expect(isPublicPath('/favicon.png')).toBe(true);
  });

  it('does NOT let the API through', () => {
    // The leak was API routes returning account data to anonymous callers.
    expect(isPublicPath('/api/alpaca')).toBe(false);
    expect(isPublicPath('/api/portfolio-history')).toBe(false);
  });

  it('does NOT let pages through', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/portfolio')).toBe(false);
  });

  it('is not fooled by a path that merely starts with a public-looking prefix', () => {
    expect(isPublicPath('/loginsecrets')).toBe(false);
    expect(isPublicPath('/api/login')).toBe(false);
  });
});
