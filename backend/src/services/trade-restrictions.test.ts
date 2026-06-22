import { describe, it, expect } from 'vitest';
import { isSameTradingDay } from './trade-restrictions';

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
