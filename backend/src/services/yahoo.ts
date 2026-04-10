// backend/src/services/yahoo.ts
//
// Yahoo Finance requires a crumb + matching session cookies for unauthenticated
// API calls (enforced since mid-2023). The finance.yahoo.com page sends headers
// that exceed Node's default 8 KB limit, causing undici (built-in fetch) to throw
// HPE_HEADER_OVERFLOW. We work around this by using node:https directly for the
// session-init request and the crumb fetch, then use that crumb for API calls.
// Production Railway deployments should set NODE_OPTIONS=--max-http-header-size=65536.

import https from 'https';
import { sleep } from '../lib/http.js';
import type { YahooQuoteSummary } from '../types/index.js';

const BASE = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const MODULES = 'financialData,defaultKeyStatistics,summaryDetail';

// Yahoo throttles aggressively; keep a small inter-call delay
let lastCallAt = 0;
const MIN_GAP_MS = 250;

// Session state: crumb + cookie jar
let _crumb: string | null = null;
let _cookie: string | null = null;
let _sessionInitAt = 0;
const SESSION_TTL_MS = 30 * 60 * 1000; // re-init every 30 min

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  // Yahoo sometimes wraps values in { raw, fmt, longFmt }
  if (typeof v === 'object' && v !== null && 'raw' in v) {
    const raw = (v as { raw: unknown }).raw;
    return typeof raw === 'number' && isFinite(raw) ? raw : null;
  }
  return null;
}

/**
 * Low-level HTTPS GET using node:https directly to avoid undici header-size limits.
 * Returns status, cookies (parsed from Set-Cookie), and body text.
 */
function nodeGet(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; cookies: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        maxHeaderSize: 65536,
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...extraHeaders,
        },
      },
      (res) => {
        // Extract Set-Cookie values from raw headers (handles multiple cookies correctly)
        const cookies: string[] = [];
        for (let i = 0; i < res.rawHeaders.length - 1; i += 2) {
          if (res.rawHeaders[i].toLowerCase() === 'set-cookie') {
            cookies.push(res.rawHeaders[i + 1].split(';')[0].trim());
          }
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookies, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Establish a Yahoo Finance session by visiting the quote page and fetching a crumb.
 * Yahoo requires a valid crumb + matching cookies for API calls since mid-2023.
 */
async function initSession(): Promise<boolean> {
  try {
    // Step 1: Get session cookies from the finance homepage
    const pageRes = await nodeGet('https://finance.yahoo.com/quote/AAPL/');
    if (pageRes.status !== 200 || pageRes.cookies.length === 0) {
      console.warn(`[Yahoo] session init page returned status ${pageRes.status}, cookies: ${pageRes.cookies.length}`);
      return false;
    }
    _cookie = pageRes.cookies.join('; ');

    await sleep(300);

    // Step 2: Fetch the crumb using the session cookies
    const crumbRes = await nodeGet('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      'Cookie': _cookie,
      'Referer': 'https://finance.yahoo.com/',
      'Accept': '*/*',
    });

    if (crumbRes.status !== 200) {
      console.warn(`[Yahoo] crumb fetch HTTP ${crumbRes.status}: ${crumbRes.body.substring(0, 80)}`);
      return false;
    }

    const crumb = crumbRes.body.trim();
    if (!crumb || crumb.length > 50 || crumb.includes('{')) {
      console.warn(`[Yahoo] unexpected crumb: ${crumb.substring(0, 80)}`);
      return false;
    }

    _crumb = crumb;
    _sessionInitAt = Date.now();
    console.log(`[Yahoo] session initialized, crumb: ${_crumb}`);
    return true;
  } catch (err) {
    console.warn('[Yahoo] session init failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function ensureSession(): Promise<boolean> {
  if (_crumb && _cookie && Date.now() - _sessionInitAt < SESSION_TTL_MS) {
    return true;
  }
  return initSession();
}

export async function fetchQuoteSummary(ticker: string): Promise<YahooQuoteSummary | null> {
  try {
    // Ensure we have a valid Yahoo session
    const hasSession = await ensureSession();
    if (!hasSession) {
      console.warn(`[Yahoo] ${ticker} skipped — no session`);
      return null;
    }

    const now = Date.now();
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - now);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    const url = `${BASE}/${encodeURIComponent(ticker)}?modules=${MODULES}&crumb=${encodeURIComponent(_crumb!)}`;

    const apiRes = await nodeGet(url, {
      'Cookie': _cookie!,
      'Referer': 'https://finance.yahoo.com/',
      'Accept': 'application/json',
    });

    if (apiRes.status !== 200) {
      console.warn(`[Yahoo] ${ticker} HTTP ${apiRes.status}`);
      // Invalidate session on auth errors so next call re-inits
      if (apiRes.status === 401 || apiRes.status === 403) {
        _crumb = null;
        _cookie = null;
      }
      return null;
    }

    const json = JSON.parse(apiRes.body) as { quoteSummary?: { result?: Array<Record<string, Record<string, unknown>>> } };
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return null;

    const fd = result.financialData ?? {};
    const dks = result.defaultKeyStatistics ?? {};
    const sd = result.summaryDetail ?? {};

    return {
      ticker,
      targetMeanPrice:         num(fd.targetMeanPrice),
      targetHighPrice:         num(fd.targetHighPrice),
      targetLowPrice:          num(fd.targetLowPrice),
      numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions) ?? 0,
      recommendationMean:      num(fd.recommendationMean),
      trailingPE:              num(sd.trailingPE),
      forwardPE:               num(sd.forwardPE),
      priceToBook:             num(dks.priceToBook),
      priceToSales:            num(sd.priceToSalesTrailing12Months),
      high52w:                 num(sd.fiftyTwoWeekHigh),
      low52w:                  num(sd.fiftyTwoWeekLow),
    };
  } catch (err) {
    console.warn(`[Yahoo] ${ticker} fetch failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export default { fetchQuoteSummary };
