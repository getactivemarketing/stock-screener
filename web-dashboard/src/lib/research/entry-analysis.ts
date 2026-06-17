import { query } from '$lib/db';
import { fetchIndicators } from './price-series';
import { buildTranches } from './entry-plan';
import { askPerplexityJSON, JSON_SYSTEM_PROMPT } from './perplexity';
import { placeGtcLimitBuy, getOrderById, cancelOrder } from './alpaca-orders';
import type { EntryPlanPayload, EntryNarrative, PlanStatus, EntryOrderRow } from './entry-types';

/** Build a full draft plan (indicators + narrative + tranches). Throws if AV has no series. */
export async function buildEntryAnalysis(ticker: string, desiredUsd: number, avKey: string, pplxKey: string): Promise<EntryPlanPayload> {
  const indicators = await fetchIndicators(ticker, avKey);
  if (!indicators) throw new Error(`No price series for ${ticker}`);

  const narr = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker}, return JSON {"volumeTrend":"<2-3 sentences on recent volume vs historical, flag fading-on-declining-volume>","shortInterest":"<2-3 sentences: % of float short and the trend>","holdersAndDrivers":"<2-3 sentences: biggest holders (institutional/insider/retail) and drivers of recent moves: buybacks, insider buying, institutional flows>"}`
  )) as any;
  const narrative: EntryNarrative = {
    volumeTrend: narr?.volumeTrend ?? 'Unavailable.',
    shortInterest: narr?.shortInterest ?? 'Unavailable.',
    holdersAndDrivers: narr?.holdersAndDrivers ?? 'Unavailable.',
  };

  const tranches = buildTranches({
    desiredUsd,
    currentPrice: indicators.currentPrice,
    ma8: indicators.ma8,
    ma20: indicators.ma20,
    ma50: indicators.ma50,
    low52w: indicators.low52w,
    recentSwingLow: indicators.recentSwingLow,
    dailyVol: indicators.dailyVol,
  });
  const totalShares = tranches.reduce((s, t) => s + t.shares, 0);
  const totalCost = tranches.reduce((s, t) => s + t.shares * t.limitPrice, 0);

  return { ticker, desiredUsd, indicators, narrative, tranches, totalShares, totalCost };
}

export async function savePlan(payload: EntryPlanPayload): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO entry_plans (ticker, desired_position_usd, plan, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [payload.ticker, payload.desiredUsd, payload]
  );
  return rows[0].id;
}

export async function getPlan(planId: number): Promise<{ id: number; ticker: string; status: PlanStatus; plan: EntryPlanPayload } | null> {
  const rows = await query<{ id: number; ticker: string; status: PlanStatus; plan: EntryPlanPayload }>(
    `SELECT id, ticker, status, plan FROM entry_plans WHERE id = $1`,
    [planId]
  );
  return rows[0] ?? null;
}

/** Place all tranches as tagged GTC limit buys; persist entry_orders; mark plan staged. */
export async function stagePlan(planId: number, key: string, secret: string): Promise<EntryOrderRow[]> {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== 'draft') throw new Error(`Plan ${planId} is already ${plan.status}`);

  const out: EntryOrderRow[] = [];
  for (const t of plan.plan.tranches) {
    const clientOrderId = `s2-${plan.ticker}-${t.trancheN}`;
    const r = await placeGtcLimitBuy(key, secret, plan.ticker, t.shares, t.limitPrice, clientOrderId);
    await query(
      `INSERT INTO entry_orders (entry_plan_id, tranche_n, client_order_id, alpaca_order_id, shares, limit_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_order_id) DO UPDATE SET alpaca_order_id = EXCLUDED.alpaca_order_id, status = EXCLUDED.status`,
      [planId, t.trancheN, clientOrderId, r.id, t.shares, t.limitPrice, r.status]
    );
    out.push({ trancheN: t.trancheN, clientOrderId, alpacaOrderId: r.id, shares: t.shares, limitPrice: t.limitPrice, status: r.status });
  }
  await query(`UPDATE entry_plans SET status = 'staged' WHERE id = $1`, [planId]);
  return out;
}

/** Refresh each order's live Alpaca status into entry_orders and return current rows. */
export async function reconcilePlan(planId: number, key: string, secret: string): Promise<EntryOrderRow[]> {
  const rows = await query<EntryOrderRow & { alpaca_order_id: string | null; tranche_n: number; client_order_id: string; limit_price: number }>(
    `SELECT tranche_n, client_order_id, alpaca_order_id, shares, limit_price, status FROM entry_orders WHERE entry_plan_id = $1 ORDER BY tranche_n`,
    [planId]
  );
  const out: EntryOrderRow[] = [];
  for (const row of rows) {
    let status = row.status;
    if (row.alpaca_order_id) {
      const live = await getOrderById(key, secret, row.alpaca_order_id);
      if (live?.status) {
        status = live.status;
        await query(`UPDATE entry_orders SET status = $1 WHERE client_order_id = $2`, [status, row.client_order_id]);
      }
    }
    out.push({
      trancheN: row.tranche_n, clientOrderId: row.client_order_id, alpacaOrderId: row.alpaca_order_id,
      shares: Number(row.shares), limitPrice: Number(row.limit_price), status,
    });
  }
  return out;
}

/** Cancel all still-open orders for a plan; mark plan cancelled. */
export async function cancelRemaining(planId: number, key: string, secret: string): Promise<number> {
  const rows = await query<{ alpaca_order_id: string | null; status: string }>(
    `SELECT alpaca_order_id, status FROM entry_orders WHERE entry_plan_id = $1`,
    [planId]
  );
  let cancelled = 0;
  for (const r of rows) {
    if (r.alpaca_order_id && !['filled', 'canceled', 'cancelled', 'expired', 'rejected'].includes(r.status)) {
      if (await cancelOrder(key, secret, r.alpaca_order_id)) cancelled++;
    }
  }
  await query(`UPDATE entry_plans SET status = 'cancelled' WHERE id = $1`, [planId]);
  return cancelled;
}
