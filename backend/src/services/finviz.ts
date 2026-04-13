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
  | 'insider_buying' | 'unusual_volume' | 'oversold_bounce'
  | 'smallcap_value' | 'midcap_catalyst';

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': UA },
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
  // Sort by cheapest P/E (not market cap) so undervalued small/mid caps surface
  value_setup:       'https://finviz.com/screener.ashx?v=111&f=fa_pe_u15,fa_pb_u3,sh_avgvol_o200&ft=4&o=pe',
  // Sort by strongest recommendation (1=strong buy first)
  analyst_upgrade:   'https://finviz.com/screener.ashx?v=111&f=an_recom_buybetter,sh_avgvol_o200&ft=4&o=recommendationmean',
  // Earnings catalyst — sort by soonest earnings date
  earnings_catalyst: 'https://finviz.com/screener.ashx?v=111&f=earningsdate_nextdays5,sh_avgvol_o200&ft=4&o=earningsdate',
  // Insider buying — sort by insider transaction value (most positive first)
  insider_buying:    'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o200,sh_insidertrans_veryposlarge&ft=4&o=-insidertransactions',
  // Unusual volume — sort by relative volume (highest first), already correct
  unusual_volume:    'https://finviz.com/screener.ashx?v=111&f=sh_relvol_o2,sh_avgvol_o200&ft=4&o=-relativevolume',
  // Oversold — sort by lowest RSI first (most oversold)
  oversold_bounce:   'https://finviz.com/screener.ashx?v=111&f=fa_curratio_o1,sh_avgvol_o200,ta_rsi_os30&ft=4&o=rsi',
  // Small-cap value: $300M-$2B market cap, P/E under 20, volume > 200K
  smallcap_value:    'https://finviz.com/screener.ashx?v=111&f=cap_smallover,fa_pe_u20,sh_avgvol_o200,sh_price_o2&ft=4&o=pe',
  // Mid-cap catalyst: $2B-$10B, earnings within 2 weeks, analyst buy+
  midcap_catalyst:   'https://finviz.com/screener.ashx?v=111&f=cap_midover,cap_midunder,an_recom_buybetter,sh_avgvol_o200&ft=4&o=recommendationmean',
};

/**
 * Fetch all 8 Finviz screens in two batches to avoid rate limiting.
 * Returns flat list — same ticker may appear from multiple sources.
 */
export async function fetchAllFinvizSignals(): Promise<FinvizTicker[]> {
  const entries = Object.entries(QUERIES) as Array<[FinvizSource, string]>;
  const batch1 = entries.slice(0, 4);
  const batch2 = entries.slice(4);

  const results1 = await Promise.all(batch1.map(([source, url]) => fetchFinvizScreen(url, source)));
  // Small delay between batches to avoid 429s
  await new Promise(r => setTimeout(r, 2000));
  const results2 = await Promise.all(batch2.map(([source, url]) => fetchFinvizScreen(url, source)));

  const flat: FinvizTicker[] = [];
  for (const list of [...results1, ...results2]) flat.push(...list);
  return flat;
}

export type { FinvizTicker, FinvizSource };
