import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';
import {
  buildEpisodes, summarizeClosed, behaviourStats, type TradeRow,
} from '$lib/portfolio/episodes';

interface TradeDbRow {
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  filled_price: string | null;   // DECIMAL arrives as a STRING from node-postgres
  filled_at: Date | string;
  classification: string | null;
  trade_rationale: string | null;
}

export const GET: RequestHandler = async () => {
  try {
    // Only filled rows: a pending order must never open an episode.
    // COALESCE guards the handful of legacy rows with a null filled_at.
    const rows = await query<TradeDbRow>(
      `SELECT ticker, action, quantity, filled_price,
              COALESCE(filled_at, created_at) AS filled_at,
              classification, trade_rationale
         FROM trades
        WHERE status = 'filled'
        ORDER BY ticker, COALESCE(filled_at, created_at), id`
    );

    // Counted but NOT included: a null-price fill would invent a cost basis
    // out of nothing, so it is skipped -- loudly, via the anomaly below.
    const nullPriceCount = rows.filter((r) => r.filled_price === null).length;

    const trades: TradeRow[] = rows
      // A fill with no price cannot contribute a cost basis; skip rather than
      // treat it as free shares, which would invent profit.
      .filter((r) => r.filled_price !== null)
      .map((r) => ({
        ticker: r.ticker,
        action: r.action,
        quantity: Number(r.quantity),
        filledPrice: Number(r.filled_price),
        filledAt: new Date(r.filled_at).toISOString(),
        classification: r.classification,
        rationale: r.trade_rationale,
      }));

    // Partial-status trades never enter the ledger (only 'filled' does), but
    // a dropped partial can leave an episode stuck open, so count them too.
    const partialRows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM trades WHERE status = 'partial'`
    );
    const partialCount = Number(partialRows[0]?.count ?? 0);

    // Tickers with a BUY the broker may already have filled but that
    // reconcilePendingOrders() has not yet stamped as filled. The next pipeline
    // cycle clears these, so they are a normal lag -- not a ledger disagreement.
    const pendingBuyRows = await query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM trades WHERE status = 'pending' AND action = 'BUY'`
    );
    const pendingBuyTickers = pendingBuyRows.map((r) => r.ticker);

    const { episodes, anomalies } = buildEpisodes(trades);

    const routeAnomalies = [...anomalies];
    if (nullPriceCount > 0) {
      routeAnomalies.push(
        `${nullPriceCount} filled trade${nullPriceCount === 1 ? '' : 's'} skipped: null filled_price`
      );
    }
    if (partialCount > 0) {
      routeAnomalies.push(
        `${partialCount} partial-status trade${partialCount === 1 ? '' : 's'} excluded from the ledger`
      );
    }

    return json({
      episodes,
      summary: summarizeClosed(episodes),
      behaviour: behaviourStats(episodes),
      anomalies: routeAnomalies,
      pendingBuyTickers,
    });
  } catch (error) {
    console.error('portfolio-history error:', error);
    return json({ error: 'Failed to build portfolio history' }, { status: 500 });
  }
};
