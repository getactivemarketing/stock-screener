import { describe, it, expect } from 'vitest';
import { buildCommitted, addCommitment, type Commitment } from './committed-portfolio';
import type { AlpacaOrder, AlpacaPosition } from '../types/index.js';

const pos = (ticker: string, marketValue: number): AlpacaPosition =>
  ({ ticker, marketValue }) as AlpacaPosition;

const order = (ticker: string, quantity: number, o: Partial<AlpacaOrder> = {}): AlpacaOrder =>
  ({
    id: ticker, ticker, side: 'buy', quantity, type: 'market', status: 'accepted',
    filledAvgPrice: null, filledAt: null, createdAt: '2026-08-07T20:11:15Z', ...o,
  }) as AlpacaOrder;

/**
 * Regression tests for the collective over-commit defect.
 *
 * validateBuy() checks max_positions, the duplicate-holding rule and portfolio
 * heat against the Alpaca POSITIONS array. That array is captured once per cycle
 * and never reflects (a) orders still working from an earlier cycle, or (b)
 * buys already approved earlier in THIS cycle. Every candidate therefore
 * validated as though it were the only one.
 *
 * Observed live: on 2026-08-07 the bot held 2 positions and queued 8 more orders
 * across three cycles — five of them in the 20:38 cycle alone, each sizing
 * itself at ~10% of equity as if the other four did not exist. At Monday's open
 * all 8 filled, leaving 10 positions and 99% portfolio heat against a configured
 * max_positions of 5 and max_portfolio_heat_pct of 40.
 *
 * The limit had been breached on 12 of the 26 trading days since 2026-07-06,
 * peaking at 8 concurrent positions before this. It was never a one-off.
 */
describe('buildCommitted', () => {
  it('starts from real positions', () => {
    expect(buildCommitted([pos('NBIS', 11_842), pos('NVDA', 11_422)], [])).toEqual([
      { ticker: 'NBIS', marketValue: 11_842 },
      { ticker: 'NVDA', marketValue: 11_422 },
    ]);
  });

  it('counts a working buy order as committed capital', () => {
    const c = buildCommitted([pos('NBIS', 11_842)], [order('WDC', 26, { limitPrice: 427.92 })]);
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.ticker === 'WDC')?.marketValue).toBeCloseTo(11_125.92, 2);
  });

  it('falls back to lastPrice when the order has no limit price', () => {
    const c = buildCommitted([], [order('SOUN', 1440)], { SOUN: 7.67 });
    expect(c.find((x) => x.ticker === 'SOUN')?.marketValue).toBeCloseTo(11_044.8, 2);
  });

  it('ignores an order it cannot price rather than counting it as free', () => {
    // Better to under-count one order than to treat unknown capital as zero and
    // silently re-open the gap; the ticker is still present so the duplicate and
    // position-count checks hold.
    const c = buildCommitted([], [order('XYZ', 100)]);
    expect(c).toEqual([{ ticker: 'XYZ', marketValue: 0 }]);
  });

  it('ignores sell orders', () => {
    expect(buildCommitted([], [order('NVDA', 51, { side: 'sell' })])).toEqual([]);
  });

  it('ignores terminal orders', () => {
    expect(buildCommitted([], [order('AAA', 10, { status: 'filled' })])).toEqual([]);
    expect(buildCommitted([], [order('BBB', 10, { status: 'canceled' })])).toEqual([]);
  });

  it('does not double-count a position that also has a working add-on order', () => {
    // The position is already in `positions` at full market value; adding the
    // order on top would overstate heat and could double-count a slot.
    const c = buildCommitted([pos('ONDS', 11_659)], [order('ONDS', 1268, { limitPrice: 9.48 })]);
    expect(c).toEqual([{ ticker: 'ONDS', marketValue: 11_659 }]);
  });

  it('reconstructs the 2026-08-07 20:38 cycle', () => {
    // What the bot actually saw: 2 positions. What it should have seen: 2
    // positions plus WDC and SOUN already working from the 20:11 cycle.
    const positions = [pos('NBIS', 11_842), pos('NVDA', 11_422)];
    const working = [
      order('WDC', 26, { limitPrice: 427.92 }),
      order('SOUN', 1440, { limitPrice: 7.67 }),
    ];
    expect(buildCommitted(positions, working)).toHaveLength(4);
  });

  it('counts a SHORT as positive exposure, never as negative heat', () => {
    // Alpaca reports market_value negative for a short. Passed through as-is it
    // would SUBTRACT from the heat total in risk.ts:59 — a $10k short granting
    // $10k of extra headroom on the cap that exists to prevent over-exposure.
    // A short is exposure like any other, so it is counted at absolute value.
    expect(buildCommitted([pos('SHRT', -10_000)], [])).toEqual([
      { ticker: 'SHRT', marketValue: 10_000 },
    ]);
  });

  it('leaves a long position value untouched', () => {
    // Guards the absolute-value fix above from changing ordinary behaviour.
    expect(buildCommitted([pos('NBIS', 11_842)], [])).toEqual([
      { ticker: 'NBIS', marketValue: 11_842 },
    ]);
  });
});

describe('addCommitment', () => {
  it('appends an approved buy so later candidates in the cycle see it', () => {
    const c: Commitment[] = [{ ticker: 'NBIS', marketValue: 11_842 }];
    const next = addCommitment(c, 'MP', 12_102);
    expect(next).toHaveLength(2);
    expect(next.find((x) => x.ticker === 'MP')?.marketValue).toBe(12_102);
  });

  it('does not mutate the input', () => {
    const c: Commitment[] = [{ ticker: 'NBIS', marketValue: 11_842 }];
    addCommitment(c, 'MP', 12_102);
    expect(c).toHaveLength(1);
  });

  it('is idempotent for a ticker already committed', () => {
    const c: Commitment[] = [{ ticker: 'MP', marketValue: 12_102 }];
    expect(addCommitment(c, 'MP', 999)).toEqual(c);
  });

  it('accumulating five buys in one cycle reaches the position count', () => {
    // The 20:38 cycle approved MP, DOCS, TTWO, MU, ONDS. With accumulation the
    // fifth sees four predecessors instead of none.
    let c = buildCommitted([pos('NBIS', 11_842), pos('NVDA', 11_422)], []);
    for (const [t, v] of [['MP', 12_102], ['DOCS', 10_853], ['TTWO', 11_500], ['MU', 11_265]] as const) {
      c = addCommitment(c, t, v);
    }
    expect(c).toHaveLength(6);
    const heat = c.reduce((s, x) => s + x.marketValue, 0);
    expect(heat).toBeCloseTo(68_984, 0);
  });
});
