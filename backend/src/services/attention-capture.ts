import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { fetchAllSentimentData, mergeSentimentByTicker } from '../pipeline-unified.js';
import type { MergedSentiment } from '../types/index.js';

/**
 * Attention capture.
 *
 * pipeline-unified.ts merges every sentiment source into a full universe and then
 * truncates to MAX_CANDIDATES=40 before persisting ~18 rows. The rest is discarded
 * every 30 minutes, so a ticker only ever enters scan_results AFTER it made the cut.
 * That makes velocity uncomputable for exactly the stocks worth catching early.
 *
 * This service persists the WHOLE universe, and nothing else. No market data, no
 * classifier, no AI -- those are the expensive, rate-limited calls, and omitting them
 * is what makes running this around the clock affordable.
 */

/** Internal candidate feed, not a measure of public attention. */
const NON_ATTENTION_SOURCES = new Set(['sector-research']);

export interface SnapshotRow {
  ticker: string;
  totalMentions: number;
  apewisdomMentions: number | null;
  apewisdomRank: number | null;
  stocktwitsMentions: number | null;
  swaggyMentions: number | null;
  sourcesPresent: string[];
  avgSentiment: number | null;
}

export function toSnapshotRows(merged: Record<string, MergedSentiment>): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const m of Object.values(merged)) {
    const sources = Object.entries(m.sources).filter(
      ([name, data]) => !!data && !NON_ATTENTION_SOURCES.has(name)
    );
    // Sorted so stored arrays compare order-independently downstream.
    const sourcesPresent = sources.map(([name]) => name).sort();

    const ape = sources.filter(([n]) => n.startsWith('apewisdom')).map(([, d]) => d!);
    const apewisdomMentions = ape.length
      ? ape.reduce((sum, d) => sum + (d.mentions ?? 0), 0)
      : null;
    const ranked = ape.find((d) => typeof (d as { rank?: number }).rank === 'number');

    rows.push({
      ticker: m.ticker.toUpperCase(),
      totalMentions: m.totalMentions,
      apewisdomMentions,
      apewisdomRank: (ranked as { rank?: number } | undefined)?.rank ?? null,
      stocktwitsMentions: m.sources.stocktwits?.mentions ?? null,
      swaggyMentions: m.sources.swaggy?.mentions ?? null,
      sourcesPresent,
      avgSentiment: Number.isFinite(m.avgSentiment) ? m.avgSentiment : null,
    });
  }
  return rows;
}

/**
 * Fetch, map, and persist one capture run. Returns the number of rows written.
 *
 * A partial capture must NOT write partial rows: if the fetch throws, the run is
 * abandoned and the gap stays visible. A gap returns null downstream; a silently
 * half-written run would instead look like a universe-wide collapse in mentions and
 * would manufacture fake breakouts on recovery.
 */
export async function captureAttention(): Promise<number> {
  const { sentiment } = await fetchAllSentimentData();
  const merged = mergeSentimentByTicker(sentiment);
  const rows = toSnapshotRows(merged);

  if (rows.length === 0) {
    console.error('[AttentionCapture] Universe is EMPTY -- writing nothing, leaving a visible gap.');
    return 0;
  }

  for (const r of rows) {
    await db.query(
      `INSERT INTO attention_snapshots (
         id, ticker, total_mentions, apewisdom_mentions, apewisdom_rank,
         stocktwits_mentions, swaggy_mentions, sources_present, avg_sentiment
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), r.ticker, r.totalMentions, r.apewisdomMentions, r.apewisdomRank,
       r.stocktwitsMentions, r.swaggyMentions, r.sourcesPresent, r.avgSentiment]
    );
  }

  console.log(`[AttentionCapture] Wrote ${rows.length} snapshots.`);
  return rows.length;
}
