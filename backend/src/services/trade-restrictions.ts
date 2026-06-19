/**
 * Format a timestamp to its America/New_York calendar date as YYYY-MM-DD.
 * en-CA locale yields ISO-style date parts.
 */
function etDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * True when both timestamps fall on the same America/New_York calendar date.
 * Used to enforce the no-same-day-sell rule: a position opened on an ET date
 * cannot be sold again until a later ET date (the next session the bot runs).
 * Pure/deterministic; no external tz library.
 */
export function isSameTradingDay(entryDate: Date | string, now: Date): boolean {
  const entry = typeof entryDate === 'string' ? new Date(entryDate) : entryDate;
  if (Number.isNaN(entry.getTime())) return false;
  return etDateString(entry) === etDateString(now);
}
