import { etDateString } from './trade-restrictions.js';
import type { EntryCategory } from '../types/index.js';

/** Matches a bare calendar date, as stored in entry_catalyst_date. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a catalyst date to its ET calendar date.
 *
 * A bare 'YYYY-MM-DD' is already a calendar date and is returned as is —
 * parsing it through Date would land on midnight UTC, which is 20:00 ET the
 * previous day. That is the same mistake that made the same-day-sell gate
 * unreachable for five weeks; it is not repeated here.
 */
function toEtDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return etDateString(d);
}

/**
 * Whole ET calendar days from today until the catalyst. Negative once it has
 * passed, 0 on the day itself, null if the date is missing or unparseable.
 */
export function daysToCatalyst(
  catalystDate: Date | string | null | undefined,
  todayEt: string
): number | null {
  const catalyst = toEtDate(catalystDate);
  if (catalyst === null) return null;
  const from = Date.parse(`${todayEt}T00:00:00Z`);
  const to = Date.parse(`${catalyst}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

export interface PreEarningsExitInput {
  category: EntryCategory | null;
  catalystDate: Date | string | null;
  todayEt: string;
  /** Exit when days-to-earnings <= this. 0 disables the rule entirely. */
  exitDays: number;
}

/**
 * True when a position should be closed ahead of its earnings print.
 *
 * The bot cannot exit a position on the day it was bought, so it cannot react
 * to a print: a bad number gaps overnight, past the stop, while the market is
 * closed. Rather than avoid these entries altogether — the run-up into earnings
 * is the thesis — the exit is scheduled ahead of the event.
 *
 * Fires only for earnings_event. entry_catalyst_date is populated for that
 * category alone (198/198 historically, null for all others), but the category
 * is checked explicitly rather than trusting that to hold.
 *
 * Deliberately does NOT fire once the catalyst has passed; that case belongs to
 * catalyst_fade, which has its own reason code and its own window.
 */
export function exitsBeforeEarnings({
  category,
  catalystDate,
  todayEt,
  exitDays,
}: PreEarningsExitInput): boolean {
  if (exitDays <= 0) return false;
  if (category !== 'earnings_event') return false;
  const d2e = daysToCatalyst(catalystDate, todayEt);
  if (d2e === null) return false;
  return d2e >= 0 && d2e <= exitDays;
}

export interface PreEarningsEntryInput {
  catalystDate: Date | string | null;
  todayEt: string;
  /** Same value as the exit rule — see below. */
  exitDays: number;
}

/**
 * True when a candidate is too close to its print to be opened at all.
 *
 * The exit rule alone is not enough: a position bought today cannot be sold
 * until tomorrow, so if the print is tomorrow there is no session in which the
 * exit rule could act. Such an entry is a guaranteed hold-through.
 *
 * This shares `exitDays` with exitsBeforeEarnings on purpose. One number drives
 * both halves so they cannot drift out of sync and open a window where an entry
 * is admitted that the exit rule can never rescue.
 */
export function blocksEntryBeforeEarnings({
  catalystDate,
  todayEt,
  exitDays,
}: PreEarningsEntryInput): boolean {
  if (exitDays <= 0) return false;
  const d2e = daysToCatalyst(catalystDate, todayEt);
  if (d2e === null) return false;
  return d2e >= 0 && d2e <= exitDays;
}
