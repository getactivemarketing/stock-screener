import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import db from './db/index.js';
import apewisdom from './services/apewisdom.js';
import finnhub from './services/finnhub.js';
import { enrichForClassifier } from './services/finnhub.js';
import scoring from './services/scoring.js';
import classifier from './services/classifier.js';
import { calculateTargetPrices, type TargetPrices } from './services/targets.js';
import technicals, { type TechnicalIndicators } from './services/technicals.js';
import { fetchSwaggyTrending } from './services/swaggy.js';
import { fetchStocktwitsTrending, fetchStocktwitsActive } from './services/stocktwits.js';
import { fetchAllFinvizSignals } from './services/finviz.js';
import { fetchRedditPennyStocks } from './services/reddit.js';
import { universeConfig } from './lib/config.js';
import { sleep } from './lib/http.js';
import * as trader from './services/trader.js';
import * as alpacaService from './services/alpaca.js';
import type {
  SentimentData,
  MergedSentiment,
  PriceData,
  FundamentalData,
  TickerAnalysis,
  Tier,
  ClassifierEnrichment,
  DualTierClassificationResult,
} from './types/index.js';

const RUN_ID = uuidv4();
const START_TIME = Date.now();

/**
 * Main pipeline entry point
 */
async function runPipeline() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Stock Screener Pipeline - Run ID: ${RUN_ID}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // Step 1: Create run record
    await createRunRecord();

    // Step 2: Fetch sentiment data from aggregators
    console.log('\n[1/9] Fetching sentiment data from aggregators...');
    const sentimentData = await fetchAllSentimentData();
    console.log(`Found ${sentimentData.length} tickers with sentiment data`);

    // Step 3: Merge sentiment by ticker
    console.log('\n[2/9] Merging sentiment data by ticker...');
    const mergedSentiment = mergeSentimentByTicker(sentimentData);

    // Dual-tier dynamic selection
    const MAX_TICKERS = process.env.MAX_TICKERS ? parseInt(process.env.MAX_TICKERS) : 30;
    const tieredTickers = selectTickersWithDualTier(mergedSentiment, MAX_TICKERS);
    console.log(`Unique tickers to analyze: ${tieredTickers.length} (selected from ${Object.keys(mergedSentiment).length})`);

    // Step 4: Fetch price and fundamental data (with rate limiting)
    console.log('\n[3/9] Fetching price and fundamental data...');
    const enrichedTickers = await enrichTickersWithMarketDataTiered(tieredTickers);
    console.log(`Successfully enriched ${enrichedTickers.length} tickers`);

    // Step 4.5: Validate QUALITY tier assignments
    console.log('\n[3.5/9] Validating QUALITY tier assignments...');
    const validatedTickers = validateQualityTickers(enrichedTickers);
    console.log(`Tickers after QUALITY validation: ${validatedTickers.length}`);

    // Step 5: Apply universe filters
    console.log('\n[4/9] Applying universe filters...');
    const filteredTickers = applyUniverseFiltersTiered(validatedTickers);
    console.log(`Tickers after filtering: ${filteredTickers.length}`);

    // Step 5.5: Calculate technical indicators
    console.log('\n[5/9] Calculating technical indicators...');
    const tickersWithTechnicals = await calculateTechnicalsForTickersTiered(filteredTickers);
    console.log(`Technical indicators calculated for ${tickersWithTechnicals.filter(t => t.technicals !== null).length} tickers`);

    // Step 6.5: Classifier enrichment (analyst ratings, earnings, news)
    console.log('\n[5.5/9] Fetching classifier enrichment data...');
    const tickersWithEnrichment = await fetchClassifierEnrichment(tickersWithTechnicals);
    console.log(`Classifier enrichment fetched for ${tickersWithEnrichment.filter(t => t.enrichment !== undefined).length} tickers`);

    // Step 6: Score and classify
    console.log('\n[6/9] Scoring and classifying tickers...');
    const analyzedTickers = await scoreAndClassify(tickersWithEnrichment);

    // Step 7: Save results to database
    console.log('\n[7/9] Saving results to database...');
    await saveResults(analyzedTickers);

    // Step 8: Automated Trading (if enabled)
    try {
      const tradingConfig = await trader.loadTradingConfig();
      if (tradingConfig.enabled && alpacaService.isAlpacaConfigured()) {
        console.log('\n[8/9] Running automated trading...');

        // 8a. Reconcile pending orders from previous runs
        await trader.reconcilePendingOrders();

        // 8b. Evaluate and execute
        const account = await alpacaService.getAccount();
        const positions = await alpacaService.getPositions();
        const decisions = await trader.evaluate(analyzedTickers, positions, account, tradingConfig);
        const executed = await trader.execute(decisions);
        await trader.logDecisions(executed, RUN_ID);
        await trader.updatePortfolioState(RUN_ID, analyzedTickers);

        // Summary
        const buys = executed.filter((d) => d.action === 'BUY').length;
        const sells = executed.filter((d) => d.action === 'SELL').length;
        console.log(`[Trading] ${buys} buys, ${sells} sells placed`);
      } else if (!tradingConfig.enabled) {
        console.log('\n[Trading] Disabled in config');
      } else {
        console.log('\n[Trading] Alpaca not configured');
      }
    } catch (tradingError) {
      // Trading errors should NOT crash the pipeline
      console.error('[Trading] Error (pipeline continues):', tradingError);
      console.error('[Trading] Recent Alpaca request IDs:', alpacaService.getRecentRequestIds());
    }

    // Step 9: Update run record
    const alertCount = analyzedTickers.filter((t) => t.alertTriggered).length;
    const momentumCount = analyzedTickers.filter(t => t.tier === 'MOMENTUM').length;
    const qualityCount = analyzedTickers.filter(t => t.tier === 'QUALITY').length;
    await updateRunRecord('completed', analyzedTickers.length, alertCount, undefined, momentumCount, qualityCount);

    // Summary
    printSummary(analyzedTickers);
  } catch (error) {
    console.error('\nPipeline failed:', error);
    await updateRunRecord('failed', 0, 0, String(error));
    process.exit(1);
  } finally {
    await db.close();
  }
}

/**
 * Fetch sentiment data from all aggregators
 */
async function fetchAllSentimentData(): Promise<SentimentData[]> {
  const results: SentimentData[] = [];

  // ApeWisdom - fetch from multiple subreddits (Reddit aggregator)
  console.log('  - Fetching from ApeWisdom (Reddit)...');
  const [allStocks, pennystocks, wsb] = await Promise.all([
    apewisdom.fetchTrendingStocks('all-stocks'),
    apewisdom.fetchTrendingStocks('pennystocks'),
    apewisdom.fetchTrendingStocks('wallstreetbets'),
  ]);
  results.push(...allStocks, ...pennystocks, ...wsb);
  console.log(`    Found ${allStocks.length + pennystocks.length + wsb.length} entries from ApeWisdom`);

  // Swaggy Stocks - options flow and WSB sentiment
  console.log('  - Fetching from Swaggy Stocks...');
  const swaggyData = await fetchSwaggyTrending();
  for (const item of swaggyData) {
    results.push({
      ticker: item.ticker,
      source: 'swaggy',
      mentions: item.mentions,
      sentiment: item.sentiment,
      rank: 0,
    });
  }
  console.log(`    Found ${swaggyData.length} entries from Swaggy Stocks`);

  // Stocktwits - social sentiment platform
  console.log('  - Fetching from Stocktwits...');
  const [stTrending, stActive] = await Promise.all([
    fetchStocktwitsTrending(),
    fetchStocktwitsActive(),
  ]);
  const stocktwitsData = [...stTrending, ...stActive];
  for (const item of stocktwitsData) {
    results.push({
      ticker: item.ticker,
      source: 'stocktwits',
      mentions: item.watchlistCount,
      sentiment: item.sentiment,
      rank: 0,
    });
  }
  console.log(`    Found ${stocktwitsData.length} entries from Stocktwits`);

  // Finviz - technical/fundamental screener signals
  console.log('  - Fetching from Finviz Screener...');
  const finvizData = await fetchAllFinvizSignals();
  for (const item of finvizData) {
    results.push({
      ticker: item.ticker,
      source: 'finviz',
      mentions: 1, // Signal count as proxy
      sentiment: 75, // Neutral-positive since it passed screener
      rank: 0,
    });
  }
  console.log(`    Found ${finvizData.length} entries from Finviz`);

  // Reddit Penny Stock Subreddits - direct scraping
  console.log('  - Fetching from Reddit penny stock subreddits...');
  const redditPennyData = await fetchRedditPennyStocks();
  results.push(...redditPennyData);
  console.log(`    Found ${redditPennyData.length} entries from Reddit penny subs`);

  return results;
}

/**
 * Merge sentiment data by ticker across all sources
 */
function mergeSentimentByTicker(data: SentimentData[]): Record<string, MergedSentiment> {
  const merged: Record<string, MergedSentiment> = {};

  for (const item of data) {
    const ticker = item.ticker.toUpperCase();

    if (!merged[ticker]) {
      merged[ticker] = {
        ticker,
        totalMentions: 0,
        avgSentiment: 0,
        maxMomentum: 1,
        sourceCount: 0,
        sources: {},
      };
    }

    // Add to appropriate source
    if (!merged[ticker].sources[item.source]) {
      merged[ticker].sources[item.source] = item;
      merged[ticker].sourceCount++;
    } else {
      // If duplicate source, take the one with more mentions
      if (item.mentions > (merged[ticker].sources[item.source]?.mentions || 0)) {
        merged[ticker].sources[item.source] = item;
      }
    }
  }

  // Calculate aggregates
  for (const ticker in merged) {
    const m = merged[ticker];
    let totalSentiment = 0;
    let sentimentCount = 0;

    for (const source of Object.values(m.sources)) {
      if (source) {
        m.totalMentions += source.mentions;
        totalSentiment += source.sentiment;
        sentimentCount++;
        if (source.momentum) {
          m.maxMomentum = Math.max(m.maxMomentum, source.momentum);
        }
      }
    }

    m.avgSentiment = sentimentCount > 0 ? totalSentiment / sentimentCount : 0;

    // Mark as penny stock if found in penny-focused sources
    m.isPennyStock = !!(m.sources['reddit-penny'] || m.sources.apewisdom?.rank);
  }

  return merged;
}

/**
 * Ticker with its assigned tier and sentiment data
 */
interface TieredTicker {
  ticker: string;
  tier: Tier;
  sentiment: MergedSentiment;
}

/**
 * Select tickers using dual-tier dynamic selection.
 * MOMENTUM: penny stocks with high social attention (isPennyStock + attention >= 40)
 * QUALITY: non-penny stocks with strong fundamentals composite
 * Caps: 25 per tier, 40 combined. Soft floors: 10 MOMENTUM, 5 QUALITY.
 */
function selectTickersWithDualTier(
  merged: Record<string, MergedSentiment>,
  maxTickers: number
): TieredTicker[] {
  const TIER_CAP = 25;
  const COMBINED_CAP = Math.min(maxTickers, 40);
  const MOMENTUM_FLOOR = 10;
  const QUALITY_FLOOR = 5;

  const allTickers = Object.entries(merged);

  // Classify into MOMENTUM candidates: penny stocks with attention >= 40
  const momentumCandidates = allTickers
    .filter(([_, data]) => data.isPennyStock && data.avgSentiment >= 40)
    .sort((a, b) => {
      const aReddit = a[1].sources['reddit-penny']?.mentions || 0;
      const bReddit = b[1].sources['reddit-penny']?.mentions || 0;
      if (bReddit !== aReddit) return bReddit - aReddit;
      return b[1].totalMentions - a[1].totalMentions;
    });

  // QUALITY candidates: non-penny stocks, sorted by fundamentals proxy
  // Use sourceCount + totalMentions as composite proxy (more sources = more institutional visibility)
  const qualityCandidates = allTickers
    .filter(([_, data]) => !data.isPennyStock)
    .sort((a, b) => {
      // Higher source count first, then total mentions
      if (b[1].sourceCount !== a[1].sourceCount) return b[1].sourceCount - a[1].sourceCount;
      return b[1].totalMentions - a[1].totalMentions;
    });

  // Also include penny stocks that didn't qualify for MOMENTUM (attention < 40)
  // as additional MOMENTUM candidates at lower priority
  const fallbackMomentum = allTickers
    .filter(([_, data]) => data.isPennyStock && data.avgSentiment < 40)
    .sort((a, b) => b[1].totalMentions - a[1].totalMentions);

  // Select with soft floors and caps
  let selectedMomentum = momentumCandidates.slice(0, TIER_CAP).map(([ticker, data]): TieredTicker => ({
    ticker,
    tier: 'MOMENTUM',
    sentiment: data,
  }));

  let selectedQuality = qualityCandidates.slice(0, TIER_CAP).map(([ticker, data]): TieredTicker => ({
    ticker,
    tier: 'QUALITY',
    sentiment: data,
  }));

  // If MOMENTUM can't hit floor, backfill from QUALITY
  if (selectedMomentum.length < MOMENTUM_FLOOR) {
    const backfillCount = MOMENTUM_FLOOR - selectedMomentum.length;
    // Add fallback momentum candidates first
    const fallbackSelected = fallbackMomentum.slice(0, backfillCount).map(([ticker, data]): TieredTicker => ({
      ticker,
      tier: 'MOMENTUM',
      sentiment: data,
    }));
    selectedMomentum.push(...fallbackSelected);

    // If still short, take extras from quality pool
    if (selectedMomentum.length < MOMENTUM_FLOOR) {
      const extraNeeded = MOMENTUM_FLOOR - selectedMomentum.length;
      const extraQuality = qualityCandidates
        .slice(TIER_CAP, TIER_CAP + extraNeeded)
        .map(([ticker, data]): TieredTicker => ({
          ticker,
          tier: 'QUALITY',
          sentiment: data,
        }));
      selectedQuality.push(...extraQuality);
    }
  }

  // If QUALITY can't hit floor, backfill from MOMENTUM
  if (selectedQuality.length < QUALITY_FLOOR) {
    const backfillCount = QUALITY_FLOOR - selectedQuality.length;
    const extraMomentum = momentumCandidates
      .slice(selectedMomentum.length, selectedMomentum.length + backfillCount)
      .map(([ticker, data]): TieredTicker => ({
        ticker,
        tier: 'MOMENTUM',
        sentiment: data,
      }));
    selectedMomentum.push(...extraMomentum);
  }

  // Combine and cap
  const combined = [...selectedMomentum, ...selectedQuality].slice(0, COMBINED_CAP);

  const mCount = combined.filter(t => t.tier === 'MOMENTUM').length;
  const qCount = combined.filter(t => t.tier === 'QUALITY').length;
  console.log(`  Selected ${mCount} MOMENTUM tickers, ${qCount} QUALITY tickers (${combined.length} total)`);

  return combined;
}

/**
 * Validate QUALITY tier candidates after market data enrichment.
 * QUALITY tickers must have price $20-$100, market cap > $500M, avg volume > 750K.
 * Those that don't meet criteria are reclassified to MOMENTUM or dropped.
 */
function validateQualityTickers(
  tickers: Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>
): Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }> {
  return tickers.map((t) => {
    if (t.tier !== 'QUALITY') return t;

    const meetsPrice = t.price.price >= 20 && t.price.price <= 100;
    const meetsMarketCap = t.fundamentals.marketCap > 500_000_000;
    const meetsVolume = t.price.avgVolume30d > 750_000;

    if (meetsPrice && meetsMarketCap && meetsVolume) return t;

    // Reclassify to MOMENTUM if it's a lower-priced stock
    if (t.price.price < 20) {
      console.log(`  Reclassified ${t.price.ticker} from QUALITY to MOMENTUM (price $${t.price.price.toFixed(2)})`);
      return { ...t, tier: 'MOMENTUM' as Tier };
    }

    // Drop if it doesn't fit either tier
    console.log(`  Dropped ${t.price.ticker} from QUALITY (cap=$${(t.fundamentals.marketCap / 1e6).toFixed(0)}M, vol=${Math.round(t.price.avgVolume30d).toLocaleString()})`);
    return null;
  }).filter((t): t is NonNullable<typeof t> => t !== null);
}

/**
 * Enrich tickers with price and fundamental data (tiered version)
 */
async function enrichTickersWithMarketDataTiered(
  tieredTickers: TieredTicker[]
): Promise<Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>> {
  const results: Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }> = [];

  let processed = 0;

  for (const { ticker, tier, sentiment } of tieredTickers) {
    try {
      const price = await finnhub.fetchPriceData(ticker);
      const fundamentals = await finnhub.fetchFundamentalData(ticker);

      if (price && fundamentals) {
        results.push({
          tier,
          sentiment,
          price,
          fundamentals,
        });
      }
    } catch (error) {
      console.warn(`Failed to enrich ${ticker}:`, error);
    }

    processed++;
    if (processed % 10 === 0) {
      console.log(`  Progress: ${processed}/${tieredTickers.length} tickers`);
    }

    await sleep(2000);
  }

  return results;
}

// Type for tickers with technical indicators (tiered)
type TickerWithTechnicals = {
  tier: Tier;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  technicals: TechnicalIndicators | null;
};

// Type for tickers with technical indicators + enrichment
type TickerWithEnrichment = TickerWithTechnicals & {
  enrichment?: ClassifierEnrichment;
};

/**
 * Calculate technical indicators for all filtered tickers (tiered)
 */
async function calculateTechnicalsForTickersTiered(
  tickers: Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>
): Promise<TickerWithTechnicals[]> {
  const results: TickerWithTechnicals[] = [];

  for (const ticker of tickers) {
    try {
      const indicators = await technicals.calculateTechnicalIndicators(ticker.price.ticker);
      results.push({
        ...ticker,
        technicals: indicators,
      });
    } catch (error) {
      console.warn(`Failed to calculate technicals for ${ticker.price.ticker}:`, error);
      results.push({
        ...ticker,
        technicals: null,
      });
    }

    await sleep(500);
  }

  return results;
}

/**
 * Fetch classifier enrichment data (analyst ratings, earnings, news) for each ticker
 */
async function fetchClassifierEnrichment(
  tickers: TickerWithTechnicals[]
): Promise<TickerWithEnrichment[]> {
  const results: TickerWithEnrichment[] = [];

  for (const ticker of tickers) {
    try {
      // Pass any existing finviz headlines if available
      const existingHeadlines: string[] = [];
      const enrichment = await enrichForClassifier(ticker.price.ticker, existingHeadlines);
      results.push({
        ...ticker,
        enrichment,
      });
    } catch (error) {
      console.warn(`Failed to fetch enrichment for ${ticker.price.ticker}:`, error);
      results.push({ ...ticker });
    }

    await sleep(1000);
  }

  return results;
}

/**
 * Apply universe filters (tiered version).
 * MOMENTUM tickers: price <= maxPrice (penny stock filters)
 * QUALITY tickers: skip price ceiling (already validated), still check country/exchange
 */
function applyUniverseFiltersTiered(
  tickers: Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>
): Array<{ tier: Tier; sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }> {
  if (process.env.TEST_MODE === 'true') {
    console.log('  TEST_MODE: Skipping universe filters');
    return tickers;
  }

  return tickers.filter(({ tier, price, fundamentals }) => {
    const ticker = price.ticker;

    // Price filter — only for MOMENTUM tier
    if (tier === 'MOMENTUM' && price.price > universeConfig.maxPrice) {
      console.log(`  Filtered ${ticker}: price $${price.price} > $${universeConfig.maxPrice}`);
      return false;
    }

    // Market cap filter (exclude mega caps)
    if (fundamentals.marketCap > universeConfig.maxMarketCap) {
      console.log(`  Filtered ${ticker}: market cap too large`);
      return false;
    }

    // Country filter
    const country = fundamentals.country?.toUpperCase() || '';
    const isUSListed = universeConfig.allowedCountries.some(
      (c) => country.includes(c.toUpperCase())
    );
    if (!isUSListed && country !== '') {
      console.log(`  Filtered ${ticker}: country ${country} not US`);
      return false;
    }

    // Exchange filter
    const exchange = fundamentals.exchange?.toUpperCase() || '';
    const isAllowedExchange = universeConfig.allowedExchanges.some(
      (e) => exchange.includes(e.toUpperCase())
    );
    if (!isAllowedExchange && exchange !== '') {
      console.log(`  Filtered ${ticker}: exchange ${exchange} not allowed`);
      return false;
    }

    return true;
  });
}

/**
 * Score and classify all tickers (dual-tier aware)
 */
async function scoreAndClassify(
  tickers: TickerWithEnrichment[]
): Promise<(TickerAnalysis & { targets: TargetPrices; technicals: TechnicalIndicators | null; classificationDetail: DualTierClassificationResult | null })[]> {
  const results: (TickerAnalysis & { targets: TargetPrices; technicals: TechnicalIndicators | null; classificationDetail: DualTierClassificationResult | null })[] = [];

  for (const { tier, sentiment, price, fundamentals, technicals: tickerTechnicals, enrichment } of tickers) {
    // Calculate scores with tier + enrichment
    let scores = scoring.calculateAllScores(sentiment, price, fundamentals, tier, enrichment);

    // Apply technical score modifier if available
    if (tickerTechnicals) {
      const techModifier = technicals.getTechnicalScoreModifier(tickerTechnicals);
      scores = {
        ...scores,
        momentum: Math.max(0, Math.min(100, scores.momentum + techModifier)),
      };
    }

    // Get preliminary classification
    const { classification: prelimClassification, alertType, reason } = scoring.classifyTicker(scores);

    // Use Perplexity for detailed analysis (only for interesting tickers to save API calls)
    let classificationResult: DualTierClassificationResult | null = null;
    let aiTarget: { target: number; reasoning: string; confidence: number } | undefined;

    if (alertType !== null || scores.attention > 50 || scores.momentum > 50) {
      classificationResult = await classifier.generateAnalysis({
        ticker: sentiment.ticker,
        tier,
        scores,
        sentiment,
        price,
        fundamentals,
        enrichment,
        preliminaryClassification: prelimClassification,
      });
      aiTarget = classificationResult.targetPrice;
    }

    // Build ClassificationResult for backward compatibility
    const classification = classificationResult
      ? {
          classification: classificationResult.classification,
          confidence: classificationResult.confidence,
          bullCase: classificationResult.bullCase,
          bearCase: classificationResult.bearCase,
          catalysts: classificationResult.catalysts,
        }
      : {
          classification: prelimClassification,
          confidence: 0.5,
          bullCase: reason,
          bearCase: 'Does not meet criteria for detailed analysis',
          catalysts: [] as string[],
        };

    // Calculate target prices using all 4 methods
    const targets = calculateTargetPrices(price, fundamentals, scores, aiTarget);

    results.push({
      ticker: sentiment.ticker,
      runId: RUN_ID,
      runTimestamp: new Date(),
      tier,
      sentiment,
      price,
      fundamentals,
      scores,
      classification,
      enrichment,
      alertTriggered: alertType !== null,
      alertType,
      targets,
      technicals: tickerTechnicals,
      classificationDetail: classificationResult,
    });
  }

  return results;
}

/**
 * Save results to database
 */
async function saveResults(
  analyses: (TickerAnalysis & { targets: TargetPrices; technicals: TechnicalIndicators | null; classificationDetail: DualTierClassificationResult | null })[]
): Promise<void> {
  for (const analysis of analyses) {
    const { ticker, sentiment, price, fundamentals, scores, classification, targets, technicals: tech, classificationDetail: cd, enrichment } = analysis;

    await db.query(
      `INSERT INTO scan_results (
        run_id, run_timestamp, ticker,
        swaggy_mentions, swaggy_sentiment, swaggy_momentum,
        apewisdom_rank, apewisdom_mentions, altindex_score,
        total_mentions, avg_sentiment, source_count,
        price, price_change_1d, price_change_1d_pct,
        price_change_5d, price_change_5d_pct,
        price_change_30d, price_change_30d_pct,
        volume, avg_volume_30d, relative_volume,
        high_52w, low_52w,
        company_name, market_cap, pe_ratio, ps_ratio, pb_ratio,
        revenue_growth, gross_margin, operating_margin, debt_equity,
        exchange, sector, industry, country,
        attention_score, momentum_score, fundamentals_score, risk_score,
        classification, confidence, bull_case, bear_case, catalysts,
        alert_triggered, alert_type,
        target_technical, target_fundamental, target_ai, target_risk,
        target_avg, stop_loss, target_details,
        rsi_14, macd_value, macd_signal, macd_histogram,
        bb_upper, bb_middle, bb_lower,
        sma_20, sma_50, sma_200, ema_20,
        technical_signal, technical_strength,
        tier, value_score, catalyst_score, emerging_industry_score,
        thesis, edge_why_now, industry_theme, stop_loss_pct, expected_returns,
        analyst_mean_target, analyst_summary, earnings_date, days_to_earnings,
        earnings_beat_rate, news_headlines
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17,
        $18, $19,
        $20, $21, $22,
        $23, $24,
        $25, $26, $27, $28, $29,
        $30, $31, $32, $33,
        $34, $35, $36, $37,
        $38, $39, $40, $41,
        $42, $43, $44, $45, $46,
        $47, $48,
        $49, $50, $51, $52,
        $53, $54, $55,
        $56, $57, $58, $59,
        $60, $61, $62,
        $63, $64, $65, $66,
        $67, $68,
        $69, $70, $71, $72,
        $73, $74, $75, $76, $77,
        $78, $79, $80, $81,
        $82, $83
      )`,
      [
        analysis.runId,
        analysis.runTimestamp,
        ticker,
        sentiment.sources.swaggy?.mentions || null,
        sentiment.sources.swaggy?.sentiment || null,
        sentiment.sources.swaggy?.momentum || null,
        sentiment.sources.apewisdom?.rank || null,
        sentiment.sources.apewisdom?.mentions || null,
        sentiment.sources.altindex?.sentiment || null,
        sentiment.totalMentions,
        sentiment.avgSentiment,
        sentiment.sourceCount,
        price.price,
        price.change1d,
        price.change1dPercent,
        price.change5d,
        price.change5dPercent,
        price.change30d,
        price.change30dPercent,
        price.volume ? Math.round(price.volume) : null,
        price.avgVolume30d ? Math.round(price.avgVolume30d) : null,
        price.relativeVolume,
        price.high52w,
        price.low52w,
        fundamentals.name,
        fundamentals.marketCap ? Math.round(fundamentals.marketCap) : null,
        fundamentals.peRatio,
        fundamentals.psRatio,
        fundamentals.pbRatio,
        fundamentals.revenueGrowth,
        fundamentals.grossMargin,
        fundamentals.operatingMargin,
        fundamentals.debtEquity,
        fundamentals.exchange,
        fundamentals.sector,
        fundamentals.industry,
        fundamentals.country,
        scores.attention,
        scores.momentum,
        scores.fundamentals,
        scores.risk,
        classification.classification,
        classification.confidence,
        classification.bullCase,
        classification.bearCase,
        classification.catalysts,
        analysis.alertTriggered,
        analysis.alertType,
        targets.technical,
        targets.fundamental,
        targets.ai,
        targets.risk,
        targets.average,
        targets.stopLoss,
        JSON.stringify(targets.details),
        // Technical indicators
        tech?.rsi14 ?? null,
        tech?.macdValue ?? null,
        tech?.macdSignal ?? null,
        tech?.macdHistogram ?? null,
        tech?.bbUpper ?? null,
        tech?.bbMiddle ?? null,
        tech?.bbLower ?? null,
        tech?.sma20 ?? null,
        tech?.sma50 ?? null,
        tech?.sma200 ?? null,
        tech?.ema20 ?? null,
        tech?.technicalSignal ?? null,
        tech?.signalStrength ?? null,
        // Dual-tier columns
        analysis.tier,
        cd?.valueScore ?? null,
        cd?.catalystScore ?? null,
        cd?.emergingIndustryScore ?? null,
        cd?.thesis ?? null,
        cd?.edgeWhyNow ?? null,
        cd?.industryTheme ?? null,
        cd?.stopLossPct ?? null,
        cd ? JSON.stringify(cd.expectedReturns) : null,
        // Enrichment columns
        enrichment?.analystRatings?.meanTarget ?? null,
        enrichment?.analystRatings?.summary ?? null,
        enrichment?.earnings?.nextDate ?? null,
        enrichment?.earnings?.daysToEarnings ?? null,
        enrichment?.earnings?.earningsBeatRate ?? null,
        enrichment?.newsHeadlines ?? null,
      ]
    );
  }

  console.log(`  Saved ${analyses.length} results to database`);
}

/**
 * Create initial run record
 */
async function createRunRecord(): Promise<void> {
  await db.query(
    'INSERT INTO scan_runs (run_id, run_timestamp, status) VALUES ($1, $2, $3)',
    [RUN_ID, new Date(), 'running']
  );
}

/**
 * Update run record with final status
 */
async function updateRunRecord(
  status: string,
  tickersScanned: number,
  alertsGenerated: number,
  errorMessage?: string,
  momentumCount?: number,
  qualityCount?: number
): Promise<void> {
  const duration = Date.now() - START_TIME;
  await db.query(
    `UPDATE scan_runs
     SET status = $1, tickers_scanned = $2, alerts_generated = $3,
         duration_ms = $4, error_message = $5,
         momentum_count = $7, quality_count = $8
     WHERE run_id = $6`,
    [status, tickersScanned, alertsGenerated, duration, errorMessage || null, RUN_ID, momentumCount ?? null, qualityCount ?? null]
  );
}

/**
 * Print summary of pipeline results
 */
function printSummary(analyses: TickerAnalysis[]): void {
  const duration = ((Date.now() - START_TIME) / 1000).toFixed(1);

  const runners = analyses.filter((a) => a.classification.classification === 'runner');
  const values = analyses.filter((a) => a.classification.classification === 'value');
  const both = analyses.filter((a) => a.classification.classification === 'both');
  const avoid = analyses.filter((a) => a.classification.classification === 'avoid');

  console.log(`\n${'='.repeat(60)}`);
  console.log('PIPELINE SUMMARY');
  console.log(`${'='.repeat(60)}`);
  const mCount = analyses.filter(a => a.tier === 'MOMENTUM').length;
  const qCount = analyses.filter(a => a.tier === 'QUALITY').length;
  console.log(`Total tickers analyzed: ${analyses.length} (${mCount} MOMENTUM, ${qCount} QUALITY)`);
  console.log(`Duration: ${duration}s`);
  console.log(`\nClassification breakdown:`);
  console.log(`  - Runners: ${runners.length}`);
  console.log(`  - Value plays: ${values.length}`);
  console.log(`  - Both: ${both.length}`);
  console.log(`  - Avoid (pump risk): ${avoid.length}`);
  console.log(`  - Watch: ${analyses.length - runners.length - values.length - both.length - avoid.length}`);

  if (runners.length > 0) {
    console.log(`\nTop Runners:`);
    runners
      .sort((a, b) => b.scores.attention + b.scores.momentum - (a.scores.attention + a.scores.momentum))
      .slice(0, 5)
      .forEach((r) => {
        console.log(`  ${r.ticker}: Attention=${r.scores.attention}, Momentum=${r.scores.momentum}, Risk=${r.scores.risk}`);
      });
  }

  if (values.length > 0) {
    console.log(`\nTop Value Plays:`);
    values
      .sort((a, b) => b.scores.fundamentals - a.scores.fundamentals)
      .slice(0, 5)
      .forEach((v) => {
        console.log(`  ${v.ticker}: Fundamentals=${v.scores.fundamentals}, Momentum=${v.scores.momentum}`);
      });
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

// Run the pipeline
runPipeline().catch(console.error);
