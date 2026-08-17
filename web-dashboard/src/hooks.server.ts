import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { verifyToken, isPublicPath } from '$lib/auth/token';

export const COOKIE_NAME = 'dash_auth';

/**
 * Password gate for the whole dashboard.
 *
 * Before this existed, every route -- including /api/alpaca, which returned live
 * account balances, and /api/portfolio-history, which returned the entire trade
 * ledger -- was readable by anyone who knew the URL. Vercel Authentication on
 * this plan protects deployment URLs but exempts the production domain, so the
 * gate has to be here.
 *
 * Fails CLOSED: if DASHBOARD_PASSWORD is unset, verifyToken() returns false for
 * everything and the site is locked rather than silently public.
 */
export const handle: Handle = async ({ event, resolve }) => {
  if (isPublicPath(event.url.pathname)) {
    return resolve(event);
  }

  const token = event.cookies.get(COOKIE_NAME);
  if (verifyToken(token, env.DASHBOARD_PASSWORD ?? '')) {
    return resolve(event);
  }

  // API callers get a machine-readable 401; browsers get sent to the login page.
  // Redirecting an API request would hand back an HTML login form where JSON was
  // expected, which reads as a parse failure rather than "you are logged out".
  if (event.url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const target = event.url.pathname + event.url.search;
  return new Response(null, {
    status: 303,
    headers: { location: `/login?next=${encodeURIComponent(target)}` },
  });
};
