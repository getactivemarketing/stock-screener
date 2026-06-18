import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { buildEntryAnalysis, savePlan } from '$lib/research/entry-analysis';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const ticker = String(body.ticker ?? '').toUpperCase().trim();
  const desiredUsd = Number(body.desiredUsd);

  if (!ticker) return json({ error: 'Missing ticker' }, { status: 400 });
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) {
    return json({ error: 'desiredUsd must be a positive number' }, { status: 400 });
  }

  const avKey = env.ALPHA_VANTAGE_API_KEY;
  const pplxKey = env.PERPLEXITY_API_KEY;
  if (!avKey || !pplxKey) return json({ error: 'Data API keys not configured' }, { status: 503 });

  try {
    const payload = await buildEntryAnalysis(ticker, desiredUsd, avKey, pplxKey);
    const planId = await savePlan(payload);
    return json({ planId, plan: payload });
  } catch (err) {
    console.error(`[research/entry] build failed for ${ticker}:`, err);
    return json({ error: `Failed to build entry plan for ${ticker}` }, { status: 500 });
  }
};
