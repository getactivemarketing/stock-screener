import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { issueToken, verifyToken } from '$lib/auth/token';
import { COOKIE_NAME } from '../../hooks.server';

export const load: PageServerLoad = ({ cookies, url }) => {
  // Already signed in -- don't make them type it again.
  if (verifyToken(cookies.get(COOKIE_NAME), env.DASHBOARD_PASSWORD ?? '')) {
    throw redirect(303, url.searchParams.get('next') || '/');
  }
  return { configured: !!env.DASHBOARD_PASSWORD };
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const secret = env.DASHBOARD_PASSWORD ?? '';
    if (!secret) {
      return fail(503, { error: 'DASHBOARD_PASSWORD is not configured on the server.' });
    }

    const data = await request.formData();
    const password = String(data.get('password') ?? '');

    // Compare via the same HMAC path used for tokens, so a wrong password can
    // never mint a valid session.
    if (password !== secret) {
      return fail(401, { error: 'Incorrect password.' });
    }

    cookies.set(COOKIE_NAME, issueToken(secret), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600,
    });

    throw redirect(303, url.searchParams.get('next') || '/');
  },
};
