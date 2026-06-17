import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { reconcilePlan, cancelRemaining } from '$lib/research/entry-analysis';

function alpacaKeys() {
  return { key: env.ALPACA_API_KEY, secret: env.ALPACA_API_SECRET };
}

export const GET: RequestHandler = async ({ url }) => {
  const planId = Number(url.searchParams.get('planId'));
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });
  const { key, secret } = alpacaKeys();
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });
  try {
    const orders = await reconcilePlan(planId, key, secret);
    return json({ planId, orders });
  } catch (err) {
    console.error(`[research/entry/status] plan ${planId} failed:`, err);
    return json({ error: 'Failed to reconcile' }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });
  const { key, secret } = alpacaKeys();
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });
  try {
    const cancelled = await cancelRemaining(planId, key, secret);
    return json({ planId, status: 'cancelled', cancelled });
  } catch (err) {
    console.error(`[research/entry/status] cancel plan ${planId} failed:`, err);
    return json({ error: 'Failed to cancel' }, { status: 500 });
  }
};
