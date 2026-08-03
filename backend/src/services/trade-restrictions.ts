/** Matches a bare calendar date, e.g. the 'YYYY-MM-DD' we store in entry_date. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a timestamp to its America/New_York calendar date as YYYY-MM-DD.
 * en-CA locale yields ISO-style date parts.
 */
export function etDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Resolve a stored entry_date to the ET calendar date it represents.
 *
 * A bare 'YYYY-MM-DD' is ALREADY an ET calendar date and must be returned as
 * is. Passing it through Date would parse it as midnight UTC — 20:00 ET the
 * previous day — which is precisely the bug that made the no-same-day-sell gate
 * unreachable for its first five weeks in production. Anything else is treated
 * as an instant and converted to its ET date.
 *
 * Returns null when the value cannot be interpreted, so callers can decide how
 * to handle it rather than silently comparing against a garbage date.
 */
function toEtDate(entryDate: Date | string): string | null {
  if (typeof entryDate === 'string' && DATE_ONLY.test(entryDate)) return entryDate;
  const entry = typeof entryDate === 'string' ? new Date(entryDate) : entryDate;
  if (Number.isNaN(entry.getTime())) return null;
  return etDateString(entry);
}

/**
 * True when both timestamps fall on the same America/New_York calendar date.
 * Used to enforce the no-same-day-sell rule: a position opened on an ET date
 * cannot be sold again until a later ET date (the next session the bot runs).
 * Pure/deterministic; no external tz library.
 */
export function isSameTradingDay(entryDate: Date | string, now: Date): boolean {
  const entry = toEtDate(entryDate);
  if (entry === null) return false;
  return entry === etDateString(now);
}

/** Whole calendar days between two 'YYYY-MM-DD' ET dates. */
function calendarDaysBetween(fromEtDate: string, toEtDate: string): number {
  const from = Date.parse(`${fromEtDate}T00:00:00Z`);
  const to = Date.parse(`${toEtDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

export interface EntryStateInput {
  /** entry_date from the most recent portfolio_state row ('YYYY-MM-DD' ET), or null. */
  prevEntryDate: string | null;
  /** quantity on that row. 0 means the position had been closed out; null means no prior row. */
  prevQuantity: number | null;
  now: Date;
}

export interface EntryState {
  /** ET calendar date the current holding period began. */
  entryDate: string;
  /** Whole ET calendar days since entryDate. */
  daysHeld: number;
}

/**
 * Decide the entry date and holding length for a currently-held position.
 *
 * A position that was flat at the previous observation (prevQuantity <= 0) is a
 * NEW holding period and gets today's ET date. Inheriting the old date instead
 * is what left NVDA reading entry_date 2026-06-15 / days_held 46 after it was
 * sold out and re-bought the same morning — old enough to clear both the
 * same-day-sell gate and every max-hold check.
 *
 * days_held is counted in ET calendar days rather than elapsed 24h blocks, so
 * it matches the calendar boundary the trading rules are written against.
 */
export function resolveEntryState({ prevEntryDate, prevQuantity, now }: EntryStateInput): EntryState {
  const today = etDateString(now);
  const wasHeld = prevQuantity !== null && prevQuantity > 0;

  if (!prevEntryDate || !wasHeld) {
    return { entryDate: today, daysHeld: 0 };
  }

  const entryDate = toEtDate(prevEntryDate) ?? today;
  return { entryDate, daysHeld: calendarDaysBetween(entryDate, today) };
}
