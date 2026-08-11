import { describe, it, expect } from 'vitest';
import { daysToCatalyst, exitsBeforeEarnings, blocksEntryBeforeEarnings } from './earnings-window';

/**
 * The pre-earnings exit rule.
 *
 * Every position must be held at least one overnight, so the bot cannot react
 * to an earnings print: a bad number gaps 15-25% overnight, well past the -12%
 * stop, and the stop cannot fire because the move happens while the market is
 * closed. No intraday stop-loss carve-out would help either.
 *
 * Meanwhile the catalyst score awards its LARGEST single bonus (+30, on a
 * component worth 35% of composite) for earnings within 5 days — it was
 * steering into the one event it structurally cannot manage. Historically 70 of
 * 198 earnings_event entries (35%) were opened within 5 days of the print.
 *
 * The fix is to schedule the exit instead of avoiding the entry: hold the
 * run-up, close out before the print. Two halves that must agree:
 *   EXIT  when days-to-earnings <= N
 *   BLOCK an entry when days-to-earnings <= N, because such a position could
 *         not be exited before the print — it is bought today, and the earliest
 *         possible sale is tomorrow, which is the print.
 * One config value drives both so they cannot drift apart.
 */
describe('daysToCatalyst', () => {
  it('counts whole ET calendar days ahead', () => {
    expect(daysToCatalyst('2026-08-14', '2026-08-11')).toBe(3);
  });

  it('is 0 on the catalyst date itself', () => {
    expect(daysToCatalyst('2026-08-11', '2026-08-11')).toBe(0);
  });

  it('goes negative once the catalyst has passed', () => {
    expect(daysToCatalyst('2026-08-10', '2026-08-11')).toBe(-1);
  });

  it('a UTC-midnight Date resolves to the PREVIOUS ET day — read dates as text', () => {
    // node-postgres parses a DATE column (OID 1082) into a JS Date at midnight
    // in the process timezone. On a UTC container that is 20:00 ET the day
    // before, so the same value read as a Date is one day short of the value
    // read as text. This is the entry_date bug's exact shape.
    //
    // The function reports what it is actually given; correctness therefore
    // depends on the CALLER reading entry_catalyst_date with to_char(). This
    // test exists to make that requirement visible rather than to bless the
    // Date path.
    expect(daysToCatalyst(new Date('2026-08-14T00:00:00Z'), '2026-08-11')).toBe(2);
    expect(daysToCatalyst('2026-08-14', '2026-08-11')).toBe(3);
  });

  it('returns null for a missing or unparseable date', () => {
    expect(daysToCatalyst(null, '2026-08-11')).toBeNull();
    expect(daysToCatalyst('not-a-date', '2026-08-11')).toBeNull();
  });

  it('does not shift a date-only string through UTC midnight', () => {
    // The entry_date bug in miniature: parsing '2026-08-11' via Date gives
    // midnight UTC = 20:00 ET on 08-10, which would report 1 day, not 0.
    expect(daysToCatalyst('2026-08-11', '2026-08-11')).toBe(0);
  });
});

describe('exitsBeforeEarnings', () => {
  const todayEt = '2026-08-11';

  it('exits the day before the print', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-12', todayEt, exitDays: 1,
    })).toBe(true);
  });

  it('exits on the print date itself, as a backstop', () => {
    // Should not be reachable if the entry guard holds, but if a position gets
    // here we still want out rather than through.
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-11', todayEt, exitDays: 1,
    })).toBe(true);
  });

  it('holds while the print is still several days out', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-14', todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('does not fire once the catalyst has passed — that is catalyst_fade', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-09', todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('only applies to earnings_event', () => {
    // entry_catalyst_date is populated for earnings_event only (198/198) and
    // null for every other category, but guard explicitly rather than relying
    // on that staying true.
    expect(exitsBeforeEarnings({
      category: 'value_rerating', catalystDate: '2026-08-12', todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('is disabled when exitDays is 0', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-12', todayEt, exitDays: 0,
    })).toBe(false);
  });

  it('does nothing without a catalyst date', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: null, todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('a wider window exits earlier', () => {
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-14', todayEt, exitDays: 3,
    })).toBe(true);
  });
});

describe('blocksEntryBeforeEarnings', () => {
  const todayEt = '2026-08-11';

  it('blocks an entry that could never be exited before the print', () => {
    // Bought today, print tomorrow: the earliest legal sale IS the print day.
    expect(blocksEntryBeforeEarnings({
      catalystDate: '2026-08-12', todayEt, exitDays: 1,
    })).toBe(true);
  });

  it('allows an entry with room for one overnight and then an exit', () => {
    // Buy today (d2e 2) -> tomorrow d2e is 1 -> exit rule fires -> sold before
    // the print, having been held exactly one overnight.
    expect(blocksEntryBeforeEarnings({
      catalystDate: '2026-08-13', todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('blocks on the print date itself', () => {
    expect(blocksEntryBeforeEarnings({
      catalystDate: '2026-08-11', todayEt, exitDays: 1,
    })).toBe(true);
  });

  it('ignores a catalyst already in the past', () => {
    expect(blocksEntryBeforeEarnings({
      catalystDate: '2026-08-10', todayEt, exitDays: 1,
    })).toBe(false);
  });

  it('does not block when there is no catalyst date', () => {
    expect(blocksEntryBeforeEarnings({ catalystDate: null, todayEt, exitDays: 1 })).toBe(false);
  });

  it('is disabled when exitDays is 0', () => {
    expect(blocksEntryBeforeEarnings({
      catalystDate: '2026-08-12', todayEt, exitDays: 0,
    })).toBe(false);
  });

  it('entry guard and exit rule agree at the boundary', () => {
    // Anything the entry guard admits must survive to at least one exit
    // evaluation before the print. d2e=2 admitted today; tomorrow d2e=1 exits.
    const exitDays = 1;
    expect(blocksEntryBeforeEarnings({ catalystDate: '2026-08-13', todayEt, exitDays })).toBe(false);
    expect(exitsBeforeEarnings({
      category: 'earnings_event', catalystDate: '2026-08-13', todayEt: '2026-08-12', exitDays,
    })).toBe(true);
  });
});
