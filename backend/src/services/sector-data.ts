// backend/src/services/sector-data.ts
import { fetchWithRetry } from '../lib/http.js';

export interface SectorEtfRow {
  ticker: string;  // e.g. 'XLK'
  sector: string;  // 'Technology'
  change1d: number | null;
  change5d: number | null;
  change1mo: number | null;
  change3mo: number | null;
  volume: number | null;
  avgVolume: number | null;
}

export interface FinvizSectorRow {
  sector: string;
  perfWeek: number | null;
  perfMonth: number | null;
  pctAboveSma50: number | null;
}

export interface NewsItem {
  headline: string;
  source: string;
  publishedAt: string;
}

const SECTOR_ETFS: Array<{ ticker: string; sector: string }> = [
  { ticker: 'XLK', sector: 'Technology' },
  { ticker: 'XLF', sector: 'Financials' },
  { ticker: 'XLE', sector: 'Energy' },
  { ticker: 'XLV', sector: 'Health Care' },
  { ticker: 'XLY', sector: 'Consumer Discretionary' },
  { ticker: 'XLP', sector: 'Consumer Staples' },
  { ticker: 'XLI', sector: 'Industrials' },
  { ticker: 'XLU', sector: 'Utilities' },
  { ticker: 'XLB', sector: 'Materials' },
  { ticker: 'XLRE', sector: 'Real Estate' },
  { ticker: 'XLC', sector: 'Communication Services' },
];

// fetchWithRetry returns a parsed JSON body (T), not a Response.
// For HTML/XML endpoints we fall back to plain fetch() — same pattern as finviz.ts.

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Finviz uses one-word "Healthcare" while our SECTOR_ETFS table uses GICS "Health Care".
// Compare via this normalizer so neither rendering silently drops the XLV row.
const normalizeSector = (s: string): string => s.toLowerCase().replace(/\s+/g, '');

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
  };
}

export async function fetchSectorEtfPerf(): Promise<SectorEtfRow[]> {
  const rows: SectorEtfRow[] = [];
  for (const { ticker, sector } of SECTOR_ETFS) {
    try {
      // Yahoo chart endpoint — public, no auth needed
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=3mo&interval=1d`;
      const json = await fetchWithRetry<YahooChartResponse>(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const result = json?.chart?.result?.[0];
      const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? []).filter((v): v is number => v != null);
      const volumes: number[] = (result?.indicators?.quote?.[0]?.volume ?? []).filter((v): v is number => v != null);
      const lastClose = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const close5d = closes[closes.length - 6];
      const close1mo = closes[closes.length - 22];
      const close3mo = closes[0];
      const pct = (from: number | undefined, to: number | undefined): number | null =>
        typeof from === 'number' && typeof to === 'number' && from !== 0
          ? ((to - from) / from) * 100
          : null;
      const recentVolumes = volumes.slice(-20).filter((v) => v != null);
      const avgVol =
        recentVolumes.length > 0
          ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
          : null;
      rows.push({
        ticker,
        sector,
        change1d: pct(prevClose, lastClose),
        change5d: pct(close5d, lastClose),
        change1mo: pct(close1mo, lastClose),
        change3mo: pct(close3mo, lastClose),
        volume: volumes[volumes.length - 1] ?? null,
        avgVolume: avgVol,
      });
    } catch (e) {
      console.warn(`[sector-data] yahoo ${ticker} failed: ${(e as Error).message}`);
    }
    // Polite delay between Yahoo calls
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

export async function fetchFinvizSectors(): Promise<FinvizSectorRow[]> {
  try {
    const url = 'https://finviz.com/groups.ashx?g=sector&v=110';
    // Plain fetch for HTML — fetchWithRetry only handles JSON.
    // Use the same full UA + Accept header as finviz.ts; a bare "Mozilla/5.0"
    // is a known bot fingerprint Finviz returns 403 / CAPTCHA for.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': BROWSER_UA },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const html = await res.text();
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const rows: FinvizSectorRow[] = [];
    const matches = html.matchAll(rowRegex);
    for (const m of matches) {
      const cells: string[] = [];
      const cellMatches = m[1].matchAll(cellRegex);
      for (const c of cellMatches) {
        cells.push(c[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length < 10) continue;
      const finvizSector = cells[1] || cells[0];
      // Match canonical name via normalized key, then re-emit the GICS name we know.
      const matched = SECTOR_ETFS.find(
        (s) => normalizeSector(s.sector) === normalizeSector(finvizSector)
      );
      if (!matched) continue;
      const sector = matched.sector;
      const parsePct = (s: string | undefined): number | null => {
        if (!s) return null;
        const cleaned = s.replace('%', '').trim();
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      };
      // Finviz v=110 column order may shift; the column indices below match the
      // current layout. If parsing returns nulls, log the raw cells array of
      // one known sector and remap the indices.
      rows.push({
        sector,
        perfWeek: parsePct(cells[7]),
        perfMonth: parsePct(cells[8]),
        pctAboveSma50: parsePct(cells[10]),
      });
    }
    return rows;
  } catch (e) {
    console.warn(`[sector-data] finviz failed: ${(e as Error).message}`);
    return [];
  }
}

export async function fetchSectorNews(sector: string): Promise<NewsItem[]> {
  try {
    // Google News RSS — public, no auth
    const q = encodeURIComponent(`${sector} sector stocks`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    // Plain fetch for XML — fetchWithRetry only handles JSON
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const xml = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const matches = xml.matchAll(itemRegex);
    for (const m of matches) {
      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(m[1]);
      const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1]);
      const pubMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1]);
      if (!titleMatch) continue;
      items.push({
        headline: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        source: sourceMatch?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? 'unknown',
        publishedAt: pubMatch?.[1]?.trim() ?? '',
      });
      if (items.length >= 8) break;
    }
    return items;
  } catch (e) {
    console.warn(`[sector-data] google news ${sector} failed: ${(e as Error).message}`);
    return [];
  }
}
