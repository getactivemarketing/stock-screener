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

    const { episodes, anomalies } = buildEpisodes(trades);

    return json({
      episodes,
      summary: summarizeClosed(episodes),
      behaviour: behaviourStats(episodes),
      anomalies,
    });
  } catch (error) {
    console.error('portfolio-history error:', error);
    return json({ error: 'Failed to build portfolio history' }, { status: 500 });
  }
};
