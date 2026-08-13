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
function calendarDaysBetween(from: string, to: string): number {
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
