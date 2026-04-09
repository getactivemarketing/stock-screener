// backend/src/services/finviz.ts
/**
 * Finviz Screener Service — unified screener (2026-04-08)
 * Six queries spanning the full universe (no price cap):
 * 1. Value setups        — low P/E, low P/B, liquid
 * 2. Analyst upgrades    — Buy or better
 * 3. Earnings catalysts  — earnings in next 5 days
 * 4. Insider buying      — recent large positive insider transactions
 * 5. Unusual volume      — >2x relative volume
 * 6. Oversold bounce     — RSI<30 + current ratio > 1
 */

type FinvizSource =
  | 'value_setup' | 'analyst_upgrade' | 'earnings_catalyst'
  | 'insider_buying' | 'unusual_volume' | 'oversold_bounce';

interface FinvizTicker {
  ticker: string;
  company: string;
  source: FinvizSource;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseFinvizHtml(html: string): string[] {
  const tickers: string[] = [];
  const seen = new Set<string>();
  const primary = /<a[^>]*href="quote\.ashx\?t=([A-Z.]{1,6})"[^>]*class="screener-link-primary"/gi;
  let m: RegExpExecArray | null;
  while ((m = primary.exec(html)) !== null) {
    const t = m[1].toUpperCase();
    if (!seen.has(t)) { seen.add(t); tickers.push(t); }
  }
  // Fallback: any quote.ashx link
  const fallback = /quote\.ashx\?t=([A-Z.]{1,6})(?:&|")/gi;
  while ((m = fallback.exec(html)) !== null) {
    const t = m[1].toUpperCase();
    if (!seen.has(t)) { seen.add(t); tickers.push(t); }
  }
  return tickers;
}

async function fetchFinvizScreen(url: string, source: FinvizSource): Promise<FinvizTicker[]> {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': UA },
    });
    if (!res.ok) {
      console.log(`    [Finviz ${source}] HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    return parseFinvizHtml(html).map(ticker => ({ ticker, company: '', source }));
  } catch (err) {
    console.log(`    [Finviz ${source}] failed:`, (err as Error).message);
    return [];
  }
}

const QUERIES: Record<FinvizSource, string> = {
  value_setup:       'https://finviz.com/screener.ashx?v=111&f=fa_pe_u15,fa_pb_u3,sh_avgvol_o500&ft=4&o=-marketcap',
  analyst_upgrade:   'https://finviz.com/screener.ashx?v=111&f=an_recom_buybetter,sh_avgvol_o500&ft=4&o=-marketcap',
  earnings_catalyst: 'https://finviz.com/screener.ashx?v=111&f=earningsdate_nextdays5,sh_avgvol_o500&ft=4&o=-marketcap',
  insider_buying:    'https://finviz.com/screener.ashx?v=111&f=ins_ownership_pos,sh_insidertrans_veryposlarge&ft=4&o=-marketcap',
  unusual_volume:    'https://finviz.com/screener.ashx?v=111&f=sh_relvol_o2,sh_avgvol_o500&ft=4&o=-relativevolume',
  oversold_bounce:   'https://finviz.com/screener.ashx?v=111&f=fa_curratio_o1,sh_avgvol_o500,ta_rsi_os30&ft=4&o=-marketcap',
};

/**
 * Fetch all 6 Finviz screens in parallel.
 * Returns flat list — same ticker may appear from multiple sources.
 */
export async function fetchAllFinvizSignals(): Promise<FinvizTicker[]> {
  const entries = Object.entries(QUERIES) as Array<[FinvizSource, string]>;
  const results = await Promise.all(entries.map(([source, url]) => fetchFinvizScreen(url, source)));
  const flat: FinvizTicker[] = [];
  for (const list of results) flat.push(...list);
  return flat;
}

export type { FinvizTicker, FinvizSource };
