import type { Indicators } from './entry-types';

/** All series here are CLOSES newest-first (index 0 = most recent), matching AV ordering. */

/** Mean of the most recent `n` values. Null if fewer than `n`. */
export function movingAverage(closes: number[], n: number): number | null {
  if (closes.length < n || n <= 0) return null;
  const slice = closes.slice(0, n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** Sample stdev of daily simple returns across the whole series. 0 if <2 points. */
export function dailyVolatility(closes: number[]): number {
  if (closes.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 0; i < closes.length - 1; i++) {
    const newer = closes[i];
    const older = closes[i + 1];
    if (older > 0) returns.push((newer - older) / older);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** Minimum of the most recent `n` lows. Null if empty. */
export function recentSwingLow(lows: number[], n: number): number | null {
  if (lows.length === 0) return null;
  return Math.min(...lows.slice(0, Math.min(n, lows.length)));
}

interface DailyBar { close: number; low: number; high: number; volume: number }

/**
 * Fetch daily bars from Alpha Vantage (newest-first) and compute indicators.
 * Uses outputsize=compact (~100 trading days) — outputsize=full is an AV premium
 * feature on TIME_SERIES_DAILY. The 8/20/50-day MAs, volatility, and recent swing
 * low are exact; the "52-week" fields approximate over the available ~100 bars.
 * Returns null if AV returns no series (premium note / rate-limited / unknown ticker).
 */
export async function fetchIndicators(ticker: string, apiKey: string): Promise<Indicators | null> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AlphaVantage TIME_SERIES_DAILY HTTP ${res.status}`);
  const data: unknown = await res.json();
  const series = (data as Record<string, unknown>)?.['Time Series (Daily)'];
  if (!series) return null;

  // Object keys are dates; build newest-first arrays.
  const bars: DailyBar[] = Object.entries(series as Record<string, unknown>)
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .map(([, v]) => {
      const row = v as Record<string, string>;
      return {
        close: parseFloat(row['4. close']),
        low: parseFloat(row['3. low']),
        high: parseFloat(row['2. high']),
        volume: parseInt(row['5. volume'], 10),
      };
    });

  const closes = bars.map((b) => b.close);
  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);
  const vols = bars.map((b) => b.volume);

  const window252 = closes.slice(0, 252);
  const vol30 = vols.slice(0, 30);
  const avgVolume30d = vol30.length ? Math.round(vol30.reduce((a, b) => a + b, 0) / vol30.length) : null;
  const latestVolume = vols[0] ?? null;
  const dailyVol = dailyVolatility(closes.slice(0, 21)); // ~last month
  const band: Indicators['volatilityBand'] = dailyVol < 0.02 ? 'low' : dailyVol < 0.04 ? 'medium' : 'high';

  return {
    currentPrice: closes[0],
    ma8: movingAverage(closes, 8),
    ma20: movingAverage(closes, 20),
    ma50: movingAverage(closes, 50),
    ma52w: window252.length ? window252.reduce((a, b) => a + b, 0) / window252.length : null,
    high52w: highs.length ? Math.max(...highs.slice(0, 252)) : null,
    low52w: lows.length ? Math.min(...lows.slice(0, 252)) : null,
    recentSwingLow: recentSwingLow(lows, 20),
    dailyVol,
    avgVolume30d,
    latestVolume,
    relativeVolume: avgVolume30d && latestVolume ? latestVolume / avgVolume30d : null,
    volatilityBand: band,
  };
}
