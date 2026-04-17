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
  MergedSentiment,
  TradeabilityResult,
} from '../types/index.js';

const MIN_PRICE = 2.00;
const MIN_MARKET_CAP = 300_000_000;           // $300M
const MIN_DOLLAR_VOLUME = 5_000_000;          // $5M/day
const MIN_ANALYST_COUNT = 2;
const EARNINGS_BLACKOUT_HOURS = 24;

// Speculative tier gates — catches small-cap squeezes the core tier rejects.
// Paired with much smaller position sizes (speculative_position_pct).
const SPEC_MIN_PRICE = 0.50;
const SPEC_MIN_MARKET_CAP = 25_000_000;       // $25M
const SPEC_MIN_DOLLAR_VOLUME = 500_000;       // $500K/day
const SPEC_MIN_APEWISDOM_RANK = 10;           // rank must be <= 10 on any AW filter
const SPEC_MIN_MENTIONS = 100;                // minimum social mentions total

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

export interface SpeculativeTradeabilityInputs extends TradeabilityInputs {
  sentiment: MergedSentiment;
}

/**
 * Speculative tier eligibility. Looser gates than core, but requires a strong
 * social signal. Intended for squeeze candidates that the core tier rejects
 * on market cap / liquidity / analyst coverage.
 *
 * Non-negotiable gates (same as core): not_us_listed, is_etf_or_trust,
 * earnings_imminent. Everything else is relaxed.
 */
export function evaluateSpeculativeTradeability(
  inputs: SpeculativeTradeabilityInputs,
): TradeabilityResult {
  const failures: string[] = [];
  const { price, fundamentals, enrichment, sentiment } = inputs;

  if (!price.price || price.price < SPEC_MIN_PRICE) {
    failures.push('spec_price_lt_0_50');
  }

  if (!fundamentals.marketCap || fundamentals.marketCap < SPEC_MIN_MARKET_CAP) {
    failures.push('spec_market_cap_lt_25m');
  }

  const dollarVolume = (price.price || 0) * (price.avgVolume30d || 0);
  if (dollarVolume < SPEC_MIN_DOLLAR_VOLUME) {
    failures.push('spec_dollar_volume_lt_500k');
  }

  // Non-negotiable: must be US-listed
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

  // Non-negotiable: not an ETF/trust
  const nameUpper = (fundamentals.name || '').toUpperCase();
  if (nameUpper.includes(' ETF') || nameUpper.includes('SHARES ') || nameUpper.includes('TRUST')) {
    failures.push('is_etf_or_trust');
  }

  // Non-negotiable: no imminent earnings
  const daysToEarnings = enrichment?.earnings?.daysToEarnings;
  if (typeof daysToEarnings === 'number' && Math.abs(daysToEarnings) * 24 < EARNINGS_BLACKOUT_HOURS) {
    failures.push('earnings_imminent');
  }

  // Social signal: must have ApeWisdom rank <= 10 on at least one filter
  const rankPenny = sentiment.sources['apewisdom-penny']?.rank;
  const rankAll = sentiment.sources['apewisdom-all']?.rank;
  const rankWsb = sentiment.sources['apewisdom-wsb']?.rank;
  const ranks = [rankPenny, rankAll, rankWsb].filter(
    (r): r is number => typeof r === 'number' && r > 0,
  );
  const bestRank = ranks.length > 0 ? Math.min(...ranks) : null;
  if (bestRank === null || bestRank > SPEC_MIN_APEWISDOM_RANK) {
    failures.push('spec_apewisdom_rank_gt_10');
  }

  if (sentiment.totalMentions < SPEC_MIN_MENTIONS) {
    failures.push('spec_mentions_lt_100');
  }

  return { tradeable: failures.length === 0, failures };
}
