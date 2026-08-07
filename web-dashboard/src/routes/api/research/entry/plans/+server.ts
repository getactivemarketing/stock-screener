import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listOpenPlans } from '$lib/research/entry-analysis';

/**
 * Staged plans that may still have live GTC orders on the broker.
 *
 * Read-only and broker-free: it reports what the database knows so the page can
 * offer a way back into a plan after a reload. Reconciling against Alpaca stays
 * with /api/research/entry/status, which the page calls once a plan is resumed.
 */
export const GET: RequestHandler = async () => {
  try {
    return json({ plans: await listOpenPlans() });
  } catch (err) {
    console.error('[research/entry/plans] failed:', err);
    return json({ error: 'Failed to load plans' }, { status: 500 });
  }
};
