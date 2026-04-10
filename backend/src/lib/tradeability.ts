// backend/src/lib/tradeability.ts
/**
 * Hard tradeability gates. A ticker must pass ALL gates to be trader-eligible.
 * Failing gates still appear in scan_results with their composite score —
 * they're just marked tradeable=false and skipped by the trader.
 */

import type {
  PriceData,
  FundamentalData,
  ClassifierEnrichment,
  YahooQuoteSummary,
  TradeabilityResult,
} from '../types/index.js';

const MIN_PRICE = 2.00;
const MIN_MARKET_CAP = 300_000_000;           // $300M
const MIN_DOLLAR_VOLUME = 5_000_000;          // $5M/day
const MIN_ANALYST_COUNT = 2;
const EARNINGS_BLACKOUT_HOURS = 24;

export interface TradeabilityInputs {
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  enrichment: ClassifierEnrichment | undefined;
}

export function evaluateTradeability(inputs: TradeabilityInputs): TradeabilityResult {
  const failures: string[] = [];
  const { price, fundamentals, yahoo, enrichment } = inputs;

  // Gate 1: price ≥ $2.00
  if (!price.price || price.price < MIN_PRICE) {
    failures.push('price_lt_2');
  }

  // Gate 2: market cap ≥ $300M
  if (!fundamentals.marketCap || fundamentals.marketCap < MIN_MARKET_CAP) {
    failures.push('market_cap_lt_300m');
  }

  // Gate 3: avg daily dollar volume ≥ $5M
  const dollarVolume = (price.price || 0) * (price.avgVolume30d || 0);
  if (dollarVolume < MIN_DOLLAR_VOLUME) {
    failures.push('dollar_volume_lt_5m');
  }

  // Gate 4: analyst coverage ≥ 2 (skip if Yahoo data unavailable)
  if (yahoo !== null) {
    const analystCount = yahoo.numberOfAnalystOpinions ?? 0;
    if (analystCount < MIN_ANALYST_COUNT) {
      failures.push('no_analyst_coverage');
    }
  }

  // Gate 5: US-listed exchange.
  // Finnhub returns verbose exchange names like "NASDAQ NMS - GLOBAL MARKET" or
  // "NEW YORK STOCK EXCHANGE, INC." for US listings, and "TAIWAN STOCK EXCHANGE" /
  // "NYSE EURONEXT - EURONEXT AMSTERDAM" for foreign home exchanges (even for ADRs).
  // ADRs cannot be reliably distinguished from foreign listings via Finnhub alone.
  const exchange = (fundamentals.exchange || '').toUpperCase();
  const isUsExchange =
    exchange.startsWith('NASDAQ') ||
    exchange.startsWith('NEW YORK STOCK EXCHANGE') ||
    exchange.startsWith('NYSE ARCA') ||
    exchange.startsWith('NYSE AMERICAN') ||
    exchange.startsWith('BATS') ||
    exchange.startsWith('CBOE');
  if (exchange && !isUsExchange) {
    failures.push('not_us_listed');
  }
  // ETF/trust detection: Finnhub profile2 leaves industry blank for ETFs; also check name
  const nameUpper = (fundamentals.name || '').toUpperCase();
  if (nameUpper.includes(' ETF') || nameUpper.includes('SHARES ') || nameUpper.includes('TRUST')) {
    failures.push('is_etf_or_trust');
  }

  // Gate 6: earnings not imminent (within 24 hours either direction)
  const daysToEarnings = enrichment?.earnings?.daysToEarnings;
  if (typeof daysToEarnings === 'number' && Math.abs(daysToEarnings) * 24 < EARNINGS_BLACKOUT_HOURS) {
    failures.push('earnings_imminent');
  }

  return { tradeable: failures.length === 0, failures };
}
