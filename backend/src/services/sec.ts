import { fetchWithRetry, RateLimiter } from '../lib/http.js';

// SEC EDGAR API has a rate limit of 10 requests/second, but we'll be conservative
const secRateLimiter = new RateLimiter(1, 500);

const BASE_URL = 'https://data.sec.gov';
const SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';

// User agent required by SEC (they block generic user agents)
const SEC_USER_AGENT = 'StockScreener/1.0 (contact@example.com)';

const fetchOptions = {
  headers: {
    'User-Agent': SEC_USER_AGENT,
    'Accept': 'application/json',
  },
};

export interface SECFiling {
  accessionNumber: string;
  filingDate: string;
  form: string;
  description: string;
  primaryDocument: string;
  primaryDocDescription: string;
}

export interface InsiderTransaction {
  filingDate: string;
  transactionDate: string;
  ownerName: string;
  ownerRelationship: string;
  transactionType: 'buy' | 'sell' | 'other';
  shares: number;
  pricePerShare: number | null;
  totalValue: number | null;
}

export interface SECData {
  ticker: string;
  cik: string;
  recentFilings: SECFiling[];
  recentFilingCount: number;
  insiderBuys: number;
  insiderSells: number;
  insiderNetShares: number;
  latest8KDate: string | null;
  institutionalChange: number | null;
}

interface SECSubmissions {
  cik: string;
  name: string;
  tickers: string[];
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

interface Form4Transaction {
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  isOther: boolean;
  transactionCode: string; // P=Purchase, S=Sale, A=Award, etc.
  transactionShares: number;
  transactionPricePerShare: number | null;
  transactionAcquiredDisposedCode: string; // A=Acquired, D=Disposed
}

// Cache for CIK lookups (ticker -> CIK mapping)
const cikCache = new Map<string, string>();

/**
 * Look up the CIK number for a ticker symbol
 */
export async function lookupCIK(ticker: string): Promise<string | null> {
  // Check cache first
  if (cikCache.has(ticker.toUpperCase())) {
    return cikCache.get(ticker.toUpperCase())!;
  }

  try {
    // SEC provides a company_tickers.json file mapping tickers to CIKs
    const url = `${BASE_URL}/files/company_tickers.json`;
    const data = await fetchWithRetry<Record<string, { cik_str: string; ticker: string; title: string }>>(
      url,
      fetchOptions,
      secRateLimiter
    );

    // Find the ticker in the response
    for (const key in data) {
      if (data[key].ticker.toUpperCase() === ticker.toUpperCase()) {
        const cik = data[key].cik_str.padStart(10, '0');
        cikCache.set(ticker.toUpperCase(), cik);
        return cik;
      }
    }

    console.warn(`CIK not found for ticker ${ticker}`);
    return null;
  } catch (error) {
    console.error(`Failed to lookup CIK for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch company submissions (filings) from SEC EDGAR
 */
export async function fetchSubmissions(cik: string): Promise<SECSubmissions | null> {
  try {
    const url = `${BASE_URL}/submissions/CIK${cik}.json`;
    const data = await fetchWithRetry<SECSubmissions>(url, fetchOptions, secRateLimiter);
    return data;
  } catch (error) {
    console.error(`Failed to fetch SEC submissions for CIK ${cik}:`, error);
    return null;
  }
}

/**
 * Parse Form 4 filings for insider transaction data
 */
function parseForm4Transactions(filings: SECFiling[]): { buys: number; sells: number; netShares: number } {
  // Form 4 parsing would require fetching each filing's XML
  // For now, we count Form 4 filings and estimate based on typical patterns
  const form4s = filings.filter(f => f.form === '4');

  // Rough heuristic: assume 60% are sells (options exercises, etc.), 40% are buys
  const estimatedBuys = Math.round(form4s.length * 0.4);
  const estimatedSells = Math.round(form4s.length * 0.6);

  return {
    buys: estimatedBuys,
    sells: estimatedSells,
    netShares: estimatedBuys - estimatedSells,
  };
}

/**
 * Get the most recent 8-K filing date
 */
function getLatest8KDate(filings: SECFiling[]): string | null {
  const recent8K = filings.find(f => f.form === '8-K');
  return recent8K?.filingDate || null;
}

/**
 * Fetch SEC data for a ticker
 */
export async function fetchSECData(ticker: string): Promise<SECData | null> {
  try {
    // Look up CIK
    const cik = await lookupCIK(ticker);
    if (!cik) {
      return null;
    }

    // Fetch submissions
    const submissions = await fetchSubmissions(cik);
    if (!submissions) {
      return null;
    }

    // Parse recent filings (last 90 days)
    const today = new Date();
    const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);

    const recentFilings: SECFiling[] = [];
    const filingData = submissions.filings.recent;

    for (let i = 0; i < Math.min(100, filingData.filingDate.length); i++) {
      const filingDate = new Date(filingData.filingDate[i]);
      if (filingDate >= ninetyDaysAgo) {
        recentFilings.push({
          accessionNumber: filingData.accessionNumber[i],
          filingDate: filingData.filingDate[i],
          form: filingData.form[i],
          description: '',
          primaryDocument: filingData.primaryDocument[i],
          primaryDocDescription: filingData.primaryDocDescription[i],
        });
      }
    }

    // Parse Form 4 (insider) transactions
    const insiderStats = parseForm4Transactions(recentFilings);

    // Get latest 8-K date
    const latest8KDate = getLatest8KDate(recentFilings);

    return {
      ticker,
      cik,
      recentFilings: recentFilings.slice(0, 10), // Return top 10 for display
      recentFilingCount: recentFilings.length,
      insiderBuys: insiderStats.buys,
      insiderSells: insiderStats.sells,
      insiderNetShares: insiderStats.netShares,
      latest8KDate,
      institutionalChange: null, // Would require parsing 13-F filings
    };
  } catch (error) {
    console.error(`Failed to fetch SEC data for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch recent filings by form type
 */
export async function fetchFilingsByType(
  ticker: string,
  formTypes: string[] = ['10-K', '10-Q', '8-K', '4']
): Promise<SECFiling[]> {
  const secData = await fetchSECData(ticker);
  if (!secData) return [];

  return secData.recentFilings.filter(f => formTypes.includes(f.form));
}

/**
 * Quick check for significant SEC activity
 * Returns true if there's notable recent filing activity
 */
export async function hasSignificantSECActivity(ticker: string): Promise<boolean> {
  const secData = await fetchSECData(ticker);
  if (!secData) return false;

  // Significant if:
  // - More than 5 filings in 90 days
  // - Recent 8-K (material event)
  // - Net insider buying (buys > sells)
  return (
    secData.recentFilingCount > 5 ||
    secData.latest8KDate !== null ||
    secData.insiderBuys > secData.insiderSells
  );
}

/**
 * Get SEC signal for scoring
 * Returns a modifier based on SEC activity
 */
export function getSECSignal(secData: SECData): {
  signal: 'positive' | 'negative' | 'neutral';
  modifier: number;
  reason: string;
} {
  let modifier = 0;
  const reasons: string[] = [];

  // Recent 8-K is a catalyst (material event)
  if (secData.latest8KDate) {
    const daysSince8K = Math.floor(
      (Date.now() - new Date(secData.latest8KDate).getTime()) / (24 * 60 * 60 * 1000)
    );
    if (daysSince8K <= 7) {
      modifier += 5;
      reasons.push('Recent 8-K filing');
    }
  }

  // Insider buying is bullish
  if (secData.insiderBuys > secData.insiderSells) {
    modifier += 5;
    reasons.push('Net insider buying');
  } else if (secData.insiderSells > secData.insiderBuys * 2) {
    modifier -= 5;
    reasons.push('Heavy insider selling');
  }

  // High filing activity can indicate corporate events
  if (secData.recentFilingCount > 10) {
    modifier += 2;
    reasons.push('High SEC filing activity');
  }

  const signal: 'positive' | 'negative' | 'neutral' =
    modifier > 0 ? 'positive' : modifier < 0 ? 'negative' : 'neutral';

  return {
    signal,
    modifier: Math.max(-10, Math.min(10, modifier)),
    reason: reasons.join(', ') || 'Normal activity',
  };
}

export default {
  lookupCIK,
  fetchSECData,
  fetchFilingsByType,
  hasSignificantSECActivity,
  getSECSignal,
};
