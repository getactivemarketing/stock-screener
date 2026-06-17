import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getPlan, stagePlan } from '$lib/research/entry-analysis';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });

  const key = env.ALPACA_API_KEY;
  const secret = env.ALPACA_API_SECRET;
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });

  const plan = await getPlan(planId);
  if (!plan) return json({ error: 'Plan not found' }, { status: 404 });
  if (plan.status !== 'draft') return json({ error: `Plan already ${plan.status}` }, { status: 409 });

  // Safety: total cost must not exceed the desired position.
  if (plan.plan.totalCost > plan.plan.desiredUsd) {
    return json({ error: 'Plan total exceeds desired position' }, { status: 400 });
  }

  try {
    const orders = await stagePlan(planId, key, secret);
    return json({ planId, status: 'staged', orders });
  } catch (err) {
    console.error(`[research/entry/execute] plan ${planId} failed:`, err);
    return json({ error: 'Failed to stage orders' }, { status: 500 });
  }
};
