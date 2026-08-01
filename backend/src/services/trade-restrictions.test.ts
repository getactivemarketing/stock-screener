import { describe, it, expect } from 'vitest';
import { isSameTradingDay, resolveEntryState } from './trade-restrictions';

describe('isSameTradingDay', () => {
  it('true for two times a few hours apart on the same ET date', () => {
    // 2026-06-18 14:00 ET and 19:30 ET
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-18T23:30:00Z'))).toBe(true);
  });

  it('false for entry vs the next ET morning', () => {
    // entry 2026-06-18 14:00 ET, now 2026-06-19 09:30 ET
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-19T13:30:00Z'))).toBe(false);
  });

  it('false Friday -> Monday', () => {
    // 2026-06-19 is a Friday; 2026-06-22 Monday
    expect(isSameTradingDay('2026-06-19T18:00:00Z', new Date('2026-06-22T13:30:00Z'))).toBe(false);
  });

  it('UTC-vs-ET boundary: 02:00Z is the previous ET calendar day', () => {
    // 2026-06-19T02:00:00Z = 2026-06-18 22:00 ET; 2026-06-18T18:00:00Z = 14:00 ET -> same ET day
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-19T02:00:00Z'))).toBe(true);
  });

  it('accepts a Date entryDate as well as a string', () => {
    expect(isSameTradingDay(new Date('2026-06-18T18:00:00Z'), new Date('2026-06-18T20:00:00Z'))).toBe(true);
  });
});

/**
 * Regression tests for the bug that made the no-same-day-sell gate unreachable.
 *
 * portfolio_state.entry_date holds an ET *calendar date*, not an instant. The
 * old code stored it as a UTC date-only string in a TIMESTAMPTZ column, so it
 * came back as midnight UTC — which is 20:00 ET the PREVIOUS day. Every ET-date
 * comparison then said "entered yesterday" and the gate never fired: 195
 * same-day round trips over 29 trading days with the flag switched on.
 *
 * A date-only 'YYYY-MM-DD' string must therefore be read as an ET calendar date
 * and never parsed through Date (which would treat it as midnight UTC again).
 */
describe('isSameTradingDay — entry_date read back from Postgres', () => {
  it('treats a date-only string as an ET calendar date, not midnight UTC', () => {
    // SPCX: entry_date '2026-07-31', sell attempt 2026-07-31 14:40 ET.
    // Parsing '2026-07-31' via Date gives midnight UTC = 2026-07-30 20:00 ET,
    // which is what silently disabled the gate.
    expect(isSameTradingDay('2026-07-31', new Date('2026-07-31T18:40:22Z'))).toBe(true);
  });

  it('still false on the next session after a date-only entry', () => {
    expect(isSameTradingDay('2026-07-31', new Date('2026-08-03T13:30:00Z'))).toBe(false);
  });

  it('date-only entry stays same-day through the late-ET evening', () => {
    // 2026-08-01T01:00Z = 2026-07-31 21:00 ET — still the entry ET date.
    expect(isSameTradingDay('2026-07-31', new Date('2026-08-01T01:00:00Z'))).toBe(true);
  });

  it('rejects an unparseable entry date rather than blocking every exit', () => {
    expect(isSameTradingDay('not-a-date', new Date('2026-07-31T18:40:22Z'))).toBe(false);
  });
});

/**
 * entry_date used to be inherited unconditionally from the previous
 * portfolio_state row, so a ticker that was sold flat and re-bought kept its
 * original date forever: NVDA re-entered 2026-07-31 still read entry_date
 * 2026-06-15 / days_held 46, sailing straight past the gate and past max-hold.
 */
describe('resolveEntryState', () => {
  const now = new Date('2026-07-31T18:10:02Z'); // 14:10 ET

  it('starts a fresh entry when there is no prior row', () => {
    expect(resolveEntryState({ prevEntryDate: null, prevQuantity: null, now }))
      .toEqual({ entryDate: '2026-07-31', daysHeld: 0 });
  });

  it('RESETS entry_date when the position was previously flat (re-entry)', () => {
    expect(resolveEntryState({ prevEntryDate: '2026-06-15', prevQuantity: 0, now }))
      .toEqual({ entryDate: '2026-07-31', daysHeld: 0 });
  });

  it('keeps entry_date while the position is continuously held', () => {
    expect(resolveEntryState({ prevEntryDate: '2026-07-27', prevQuantity: 8, now }))
      .toEqual({ entryDate: '2026-07-27', daysHeld: 4 });
  });

  it('counts days_held in ET calendar days, not 24h blocks', () => {
    // Entry 2026-07-30, now 2026-07-31 00:30 ET — one calendar day, ~10h apart.
    expect(resolveEntryState({
      prevEntryDate: '2026-07-30',
      prevQuantity: 5,
      now: new Date('2026-07-31T04:30:00Z'),
    })).toEqual({ entryDate: '2026-07-30', daysHeld: 1 });
  });

  it('is same-day immediately after a fresh entry, so the gate blocks the exit', () => {
    const { entryDate } = resolveEntryState({ prevEntryDate: '2026-06-15', prevQuantity: 0, now });
    expect(isSameTradingDay(entryDate, now)).toBe(true);
  });
});
