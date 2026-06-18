import type { EntryInput, Tranche } from './entry-types';

const VOL_LOW = 0.02;
const VOL_HIGH = 0.04;
const STEP_MIN = 0.01;
const STEP_MAX = 0.06;
const MIN_NOTIONAL = 100;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Deterministic staged-entry plan. See the plan doc "tranche algorithm" section.
 * Pure: no I/O, no LLM. Prices never exceed currentPrice; total cost <= desiredUsd.
 */
export function buildTranches(input: EntryInput): Tranche[] {
  const { desiredUsd, currentPrice, ma8, low52w, recentSwingLow, dailyVol } = input;

  const band: 'low' | 'medium' | 'high' = dailyVol < VOL_LOW ? 'low' : dailyVol < VOL_HIGH ? 'medium' : 'high';
  const N = band === 'low' ? 3 : band === 'medium' ? 4 : 6;

  const stepFrac = clamp(dailyVol, STEP_MIN, STEP_MAX);
  const firstDiscount = 0.5 * dailyVol;
  const anchor = Math.min(
    currentPrice * (1 - firstDiscount),
    ma8 ?? currentPrice,
    recentSwingLow ?? currentPrice
  );
  const floor = Math.max(low52w ?? 0, currentPrice * (1 - N * stepFrac));

  const prices: number[] = [];
  for (let i = 0; i < N; i++) {
    prices.push(round2(Math.max(anchor * (1 - stepFrac * i), floor)));
  }

  // Weights
  const rawWeights: number[] = [];
  for (let i = 0; i < N; i++) {
    rawWeights.push(band === 'low' ? 1 : band === 'medium' ? 1 + 0.5 * i : 1 + i);
  }
  let weightSum = rawWeights.reduce((a, b) => a + b, 0);
  let weights = rawWeights.map((w) => w / weightSum);

  // Shares; drop sub-MIN_NOTIONAL tranches and redistribute once.
  function sizeTranches(ws: number[]): { shares: number; price: number }[] {
    return ws.map((w, i) => {
      const targetUsd = desiredUsd * w;
      const shares = Math.floor(targetUsd / prices[i]);
      return { shares, price: prices[i] };
    });
  }

  let sized = sizeTranches(weights);
  const keep = sized.map((t) => t.shares * t.price >= MIN_NOTIONAL);
  if (keep.some((k) => !k) && keep.some((k) => k)) {
    const keptIdx = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    const keptWeightSum = keptIdx.reduce((s, i) => s + rawWeights[i], 0);
    weights = rawWeights.map((w, i) => (keep[i] ? w / keptWeightSum : 0));
    sized = sizeTranches(weights);
  }

  // Build tranches (only positive-share, notional>=MIN_NOTIONAL ones), then enforce total <= desiredUsd.
  let tranches: Tranche[] = [];
  let n = 1;
  for (let i = 0; i < N; i++) {
    const { shares, price } = sized[i];
    if (shares <= 0 || shares * price < MIN_NOTIONAL) continue;
    const pctBelow = round2(((currentPrice - price) / currentPrice) * 100);
    tranches.push({
      trancheN: n,
      shares,
      limitPrice: price,
      rationale: `Tranche ${n}: ${shares} sh @ $${price.toFixed(2)} (~${pctBelow}% below current). Volatility band: ${band}.`,
    });
    n++;
  }

  // Enforce total cost <= desiredUsd by trimming the largest-notional tranche.
  const totalCost = () => tranches.reduce((s, t) => s + t.shares * t.limitPrice, 0);
  while (totalCost() > desiredUsd && tranches.length > 0) {
    let bigIdx = 0;
    for (let i = 1; i < tranches.length; i++) {
      if (tranches[i].shares * tranches[i].limitPrice > tranches[bigIdx].shares * tranches[bigIdx].limitPrice) bigIdx = i;
    }
    tranches[bigIdx].shares -= 1;
    if (tranches[bigIdx].shares <= 0) tranches.splice(bigIdx, 1);
  }

  // Renumber sequentially after any drops.
  tranches = tranches.map((t, i) => ({ ...t, trancheN: i + 1 }));
  return tranches;
}
