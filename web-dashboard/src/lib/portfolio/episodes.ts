/**
 * Round-trip episode ledger.
 *
 * An episode is one time the bot was in a name: it opens on the buy that lifts
 * quantity off zero and closes when quantity returns to zero. Partial sells and
 * top-ups stay INSIDE the episode, because that is the unit the bot actually
 * decides in. FIFO lot matching was rejected in design: it fragments the observed
 * full-in/full-out pattern into rows corresponding to no decision.
 *
 * Pure module -- no db, no fetch, no clock.
 */

export interface TradeRow {
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  filledPrice: number;
  /** ISO instant. */
  filledAt: string;
  classification: string | null;
  rationale: string | null;
}

export interface Episode {
  ticker: string;
  /** 0-based position of this episode within the ticker's history. */
  index: number;
  openedAt: string;
  closedAt: string | null;
  openEtDate: string;
  closeEtDate: string | null;
  peakQuantity: number;
  totalCost: number;
  totalProceeds: number;
  /** null while open -- never 0, which would claim it broke even. */
  realizedPl: number | null;
  realizedPlPct: number | null;
  holdDays: number | null;
  isOpen: boolean;
  sameEtDay: boolean;
  classificationAtEntry: string | null;
  rationaleAtEntry: string | null;
}

export interface EpisodeResult {
  episodes: Episode[];
  /** Tickers whose ledger would go negative. Surfaced, never silently dropped. */
  anomalies: string[];
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The America/New_York calendar date of an instant, as YYYY-MM-DD.
 * Never derive this from toISOString(): a 21:00 ET fill is the NEXT day in UTC,
 * and that off-by-one is what made the same-day-sell gate unreachable for five
 * weeks in production.
 */
export function etDateString(iso: string): string {
  return ET_DATE_FMT.format(new Date(iso));
}

/** Whole calendar days between two YYYY-MM-DD ET dates. */
export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function buildEpisodes(trades: TradeRow[]): EpisodeResult {
  const byTicker = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const list = byTicker.get(t.ticker) ?? [];
    list.push(t);
    byTicker.set(t.ticker, list);
  }

  const episodes: Episode[] = [];
  const anomalies: string[] = [];

  for (const [ticker, rows] of byTicker) {
    // Sorts by timestamp alone. Two trades sharing an identical filledAt keep
    // the order the CALLER handed them in, because Array.prototype.sort has
    // been specified STABLE since ES2019 -- this relies on the route's
    // `ORDER BY ticker, filled_at, id` to have already put same-instant rows
    // in true fill order (e.g. BUY before a same-millisecond SELL). A caller
    // that hands in unordered same-timestamp rows can flip that pairing and
    // manufacture a false "sell with no position" anomaly.
    rows.sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));

    let running = 0;
    let index = 0;
    let current: Episode | null = null;
    let negative = false;

    for (const t of rows) {
      if (t.action === 'BUY') {
        if (current === null) {
          current = {
            ticker,
            index,
            openedAt: t.filledAt,
            closedAt: null,
            openEtDate: etDateString(t.filledAt),
            closeEtDate: null,
            peakQuantity: 0,
            totalCost: 0,
            totalProceeds: 0,
            realizedPl: null,
            realizedPlPct: null,
            holdDays: null,
            isOpen: true,
            sameEtDay: false,
            classificationAtEntry: t.classification,
            rationaleAtEntry: t.rationale,
          };
        }
        running += t.quantity;
        current.totalCost += t.quantity * t.filledPrice;
        current.peakQuantity = Math.max(current.peakQuantity, running);
      } else {
        if (current === null) {
          // A sell with no open position: the ledger disagrees with reality.
          negative = true;
          break;
        }
        running -= t.quantity;
        current.totalProceeds += t.quantity * t.filledPrice;

        if (running < 0) {
          negative = true;
          break;
        }
        if (running === 0) {
          current.closedAt = t.filledAt;
          current.closeEtDate = etDateString(t.filledAt);
          current.isOpen = false;
          current.sameEtDay = current.openEtDate === current.closeEtDate;
          current.realizedPl = current.totalProceeds - current.totalCost;
          current.realizedPlPct =
            current.totalCost > 0 ? (current.realizedPl / current.totalCost) * 100 : null;
          current.holdDays = calendarDaysBetween(current.openEtDate, current.closeEtDate);
          episodes.push(current);
          current = null;
          index++;
        }
      }
    }

    if (negative) {
      anomalies.push(
        `${ticker}: sell quantity exceeds buys -- episodes omitted, ledger disagrees with reality`
      );
      // Drop every episode for this ticker: the whole walk is untrustworthy.
      for (let i = episodes.length - 1; i >= 0; i--) {
        if (episodes[i].ticker === ticker) episodes.splice(i, 1);
      }
      continue;
    }

    if (current !== null) episodes.push(current);
  }

  episodes.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return { episodes, anomalies };
}

export interface ClosedSummary {
  count: number;
  realizedPl: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  avgHoldDays: number | null;
}

/**
 * Half a cent. A round trip built from partial exits can land at a realizedPl
 * of ~1e-13 instead of exactly 0 from float accumulation; without this, that
 * shows as a "win" of $0.00. Applied ONLY to win/loss bucketing -- the summed
 * realizedPl total is left exact.
 */
const FLAT_EPSILON = 0.005;

/**
 * Performance over CLOSED episodes only. Open positions are excluded entirely:
 * they have no realized result, and counting one as a zero would drag the win
 * rate down with a trade that has not finished happening.
 *
 * winRatePct is win / (win + loss): exactly-flat episodes are neither a win
 * nor a loss, so they are excluded from both the numerator and denominator
 * rather than diluting the rate with a trade that did neither.
 */
export function summarizeClosed(episodes: Episode[]): ClosedSummary {
  const done = episodes.filter((e) => !e.isOpen && e.realizedPl !== null);
  if (done.length === 0) {
    return { count: 0, realizedPl: 0, winCount: 0, lossCount: 0, winRatePct: null, avgHoldDays: null };
  }
  const realizedPl = done.reduce((sum, e) => sum + (e.realizedPl ?? 0), 0);
  const winCount = done.filter((e) => (e.realizedPl ?? 0) > FLAT_EPSILON).length;
  const lossCount = done.filter((e) => (e.realizedPl ?? 0) < -FLAT_EPSILON).length;
  const decided = winCount + lossCount;
  const holds = done.map((e) => e.holdDays ?? 0);
  return {
    count: done.length,
    realizedPl,
    winCount,
    lossCount,
    winRatePct: decided > 0 ? (winCount / decided) * 100 : null,
    avgHoldDays: holds.reduce((a, b) => a + b, 0) / holds.length,
  };
}

export interface BehaviourStats {
  reEntries: Array<{ ticker: string; episodes: number }>;
  sameDayByDate: Array<{ etDate: string; count: number }>;
  holdBuckets: Array<{ label: string; count: number }>;
}

/**
 * How the bot behaved, as opposed to how it performed. Re-entry counts and
 * same-day round trips are the signals that surfaced the no_same_day_sell gate
 * leak by hand on 2026-08-13; this makes them visible without writing SQL.
 */
export function behaviourStats(episodes: Episode[]): BehaviourStats {
  const perTicker = new Map<string, number>();
  for (const e of episodes) {
    perTicker.set(e.ticker, (perTicker.get(e.ticker) ?? 0) + 1);
  }
  const reEntries = [...perTicker.entries()]
    .map(([ticker, count]) => ({ ticker, episodes: count }))
    .sort((a, b) => b.episodes - a.episodes || a.ticker.localeCompare(b.ticker));

  const perDate = new Map<string, number>();
  for (const e of episodes) {
    if (!e.sameEtDay || !e.closeEtDate) continue;
    perDate.set(e.closeEtDate, (perDate.get(e.closeEtDate) ?? 0) + 1);
  }
  const sameDayByDate = [...perDate.entries()]
    .map(([etDate, count]) => ({ etDate, count }))
    .sort((a, b) => a.etDate.localeCompare(b.etDate));

  const buckets = [
    { label: 'same day', count: 0 },
    { label: '1-3d', count: 0 },
    { label: '4-7d', count: 0 },
    { label: '8d+', count: 0 },
  ];
  for (const e of episodes) {
    if (e.isOpen || e.holdDays === null) continue;
    if (e.holdDays === 0) buckets[0].count++;
    else if (e.holdDays <= 3) buckets[1].count++;
    else if (e.holdDays <= 7) buckets[2].count++;
    else buckets[3].count++;
  }

  return { reEntries, sameDayByDate, holdBuckets: buckets };
}

export interface SameDayRegression {
  preFixCount: number;
  postFixCount: number;
  postFixDates: string[];
}

/**
 * Splits same-day round-trip counts into before/after a gate fix date. This
 * IS the regression monitor for the no_same_day_sell gate leak: hoisted out
 * of the Behaviour tab component so it is testable.
 *
 * Uses STRICTLY GREATER than fixDate for post-fix -- the fix date's own rows
 * are pre-fix, because the gate closed at 11:20 ET that day, after those
 * trades had already happened.
 */
export function sameDayRegression(
  sameDayByDate: Array<{ etDate: string; count: number }>,
  fixDate: string
): SameDayRegression {
  const postFixDates: string[] = [];
  let preFixCount = 0;
  let postFixCount = 0;
  for (const d of sameDayByDate) {
    if (d.etDate > fixDate) {
      postFixCount += d.count;
      postFixDates.push(d.etDate);
    } else {
      preFixCount += d.count;
    }
  }
  return { preFixCount, postFixCount, postFixDates };
}

export interface BrokerReconciliation {
  /** Held at the broker but unexplained by the ledger. */
  brokerOnly: string[];
  /** Open in the ledger but not held at the broker. */
  ledgerOnly: string[];
  /** Broker-only tickers explained by a BUY still awaiting fill reconciliation. */
  awaitingFill: string[];
  /** True only when a difference is NOT explained by a pending fill. */
  disagrees: boolean;
}

/**
 * Compare what the broker says we hold against what the ledger can account for.
 *
 * A ticker whose BUY is still `status='pending'` is EXEMPT in the broker-only
 * direction. The bot buys roughly every 30 minutes and writes a pending row
 * until the next cycle reconciles the fill, so without the exemption this
 * warning fires several times a day. A monitor that cries wolf gets tuned out --
 * which is precisely how the same-day-sell gate stayed invisible for five weeks.
 *
 * The exemption is deliberately one-directional. A pending BUY can explain
 * "the broker has it and we don't yet"; it can never explain "we think we hold
 * something the broker has never heard of", which means the ledger invented a
 * position and always warrants a warning.
 */
export function reconcileWithBroker(
  brokerTickers: string[],
  ledgerOpenTickers: string[],
  pendingBuyTickers: string[]
): BrokerReconciliation {
  const norm = (t: string) => t.trim().toUpperCase();
  const broker = new Set(brokerTickers.map(norm));
  const ledger = new Set(ledgerOpenTickers.map(norm));
  const pending = new Set(pendingBuyTickers.map(norm));

  const brokerOnly: string[] = [];
  const awaitingFill: string[] = [];
  for (const t of [...broker].sort()) {
    if (ledger.has(t)) continue;
    if (pending.has(t)) awaitingFill.push(t);
    else brokerOnly.push(t);
  }

  const ledgerOnly = [...ledger].sort().filter((t) => !broker.has(t));

  return {
    brokerOnly,
    ledgerOnly,
    awaitingFill,
    disagrees: brokerOnly.length > 0 || ledgerOnly.length > 0,
  };
}
