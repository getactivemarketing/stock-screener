import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { computeVelocity, BASELINE_DAYS, type Snapshot } from './attention-velocity.js';

export interface SnapshotDbRow {
  captured_at: string | Date;
  total_mentions: number;
  sources_present: string[] | null;
}

export function rowsToSeries(rows: SnapshotDbRow[]): Snapshot[] {
  return rows.map((r) => ({
    capturedAt: r.captured_at instanceof Date ? r.captured_at : new Date(r.captured_at),
    mentions: r.total_mentions,
    sourcesPresent: r.sources_present ?? [],
  }));
}

/**
 * Compute and persist velocity for every ticker seen recently.
 *
 * The written row is the frozen record of what a consumer saw at decision time -- the
 * same reason config_snapshot and entry_composite are stamped onto entry rows today.
 * When a velocity-driven decision goes wrong, the triggering numbers must be
 * recoverable without recomputation against data that has since changed.
 */
export async function materializeVelocity(now: Date = new Date()): Promise<number> {
  const tickers = await db.query<{ ticker: string }>(
    `SELECT DISTINCT ticker FROM attention_snapshots
      WHERE captured_at > now() - interval '2 hours'`
  );

  let written = 0;
  for (const { ticker } of tickers) {
    // make_interval keeps this parameterized. Do NOT interpolate the interval into
    // the SQL string -- the project rule is parameterized queries without exception,
    // and a constant today becomes a config value tomorrow.
    const rows = await db.query<SnapshotDbRow>(
      `SELECT captured_at, total_mentions, sources_present
         FROM attention_snapshots
        WHERE ticker = $1 AND captured_at > now() - make_interval(days => $2)
        ORDER BY captured_at ASC`,
      [ticker, BASELINE_DAYS]
    );
    const m = computeVelocity(rowsToSeries(rows), now);

    await db.query(
      `INSERT INTO attention_velocity (
         id, ticker, mentions_now, vel_1h, vel_6h, vel_24h, vel_7d,
         acceleration, baseline_mentions, sample_count, is_reliable
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), ticker, m.mentionsNow, m.vel1h, m.vel6h, m.vel24h, m.vel7d,
       m.acceleration, m.baselineMentions, m.sampleCount, m.isReliable]
    );
    written++;
  }

  console.log(`[AttentionMaterialize] Wrote ${written} velocity rows.`);
  return written;
}
