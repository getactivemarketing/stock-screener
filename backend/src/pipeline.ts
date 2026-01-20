import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import db from './db/index.js';
import apewisdom from './services/apewisdom.js';
import finnhub from './services/finnhub.js';
import scoring from './services/scoring.js';
import classifier from './services/classifier.js';
import { universeConfig } from './lib/config.js';
import { sleep } from './lib/http.js';
import type {
  SentimentData,
  MergedSentiment,
  PriceData,
  FundamentalData,
  TickerAnalysis,
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
    console.log('\n[1/6] Fetching sentiment data from aggregators...');
    const sentimentData = await fetchAllSentimentData();
    console.log(`Found ${sentimentData.length} tickers with sentiment data`);

    // Step 3: Merge sentiment by ticker
    console.log('\n[2/6] Merging sentiment data by ticker...');
    const mergedSentiment = mergeSentimentByTicker(sentimentData);
    // Limit to top 20 tickers for faster runs (remove this limit in production)
    const MAX_TICKERS = process.env.MAX_TICKERS ? parseInt(process.env.MAX_TICKERS) : 20;
    const tickers = Object.keys(mergedSentiment).slice(0, MAX_TICKERS);
    console.log(`Unique tickers to analyze: ${tickers.length} (limited from ${Object.keys(mergedSentiment).length})`);

    // Step 4: Fetch price and fundamental data (with rate limiting)
    console.log('\n[3/6] Fetching price and fundamental data...');
    const enrichedTickers = await enrichTickersWithMarketData(tickers, mergedSentiment);
    console.log(`Successfully enriched ${enrichedTickers.length} tickers`);

    // Step 5: Apply universe filters
    console.log('\n[4/6] Applying universe filters...');
    const filteredTickers = applyUniverseFilters(enrichedTickers);
    console.log(`Tickers after filtering: ${filteredTickers.length}`);

    // Step 6: Score and classify
    console.log('\n[5/6] Scoring and classifying tickers...');
    const analyzedTickers = await scoreAndClassify(filteredTickers);

    // Step 7: Save results to database
    console.log('\n[6/6] Saving results to database...');
    await saveResults(analyzedTickers);

    // Step 8: Update run record
    const alertCount = analyzedTickers.filter((t) => t.alertTriggered).length;
    await updateRunRecord('completed', analyzedTickers.length, alertCount);

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

  // ApeWisdom - fetch from multiple subreddits
  console.log('  - Fetching from ApeWisdom...');
  const [allStocks, pennystocks, wsb] = await Promise.all([
    apewisdom.fetchTrendingStocks('all-stocks'),
    apewisdom.fetchTrendingStocks('pennystocks'),
    apewisdom.fetchTrendingStocks('wallstreetbets'),
  ]);
  results.push(...allStocks, ...pennystocks, ...wsb);
  console.log(`    Found ${allStocks.length + pennystocks.length + wsb.length} entries from ApeWisdom`);

  // TODO: Add Swaggy and AltIndex when API keys are available
  // console.log('  - Fetching from Swaggy...');
  // console.log('  - Fetching from AltIndex...');

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
        m.maxMomentum = Math.max(m.maxMomentum, source.momentum);
      }
    }

    m.avgSentiment = sentimentCount > 0 ? totalSentiment / sentimentCount : 0;
  }

  return merged;
}

/**
 * Enrich tickers with price and fundamental data
 */
async function enrichTickersWithMarketData(
  tickers: string[],
  sentimentMap: Record<string, MergedSentiment>
): Promise<Array<{ sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>> {
  const results: Array<{ sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }> = [];

  // Process one ticker at a time to respect Finnhub free tier rate limits
  // Each ticker needs ~4 API calls, so we space them out
  let processed = 0;

  for (const ticker of tickers) {
    try {
      // Fetch price and fundamentals sequentially to avoid rate limits
      const price = await finnhub.fetchPriceData(ticker);
      const fundamentals = await finnhub.fetchFundamentalData(ticker);

      if (price && fundamentals) {
        results.push({
          sentiment: sentimentMap[ticker],
          price,
          fundamentals,
        });
      }
    } catch (error) {
      console.warn(`Failed to enrich ${ticker}:`, error);
    }

    processed++;
    if (processed % 10 === 0) {
      console.log(`  Progress: ${processed}/${tickers.length} tickers`);
    }

    // Delay between tickers to stay under rate limit
    await sleep(2000);
  }

  return results;
}

/**
 * Apply universe filters (US/OTC, price <= $10, etc.)
 */
function applyUniverseFilters(
  tickers: Array<{ sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>
): Array<{ sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }> {
  // For testing, skip filters if TEST_MODE is set
  if (process.env.TEST_MODE === 'true') {
    console.log('  TEST_MODE: Skipping universe filters');
    return tickers;
  }

  return tickers.filter(({ price, fundamentals }) => {
    const ticker = price.ticker;

    // Price filter
    if (price.price > universeConfig.maxPrice) {
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
 * Score and classify all tickers
 */
async function scoreAndClassify(
  tickers: Array<{ sentiment: MergedSentiment; price: PriceData; fundamentals: FundamentalData }>
): Promise<TickerAnalysis[]> {
  const results: TickerAnalysis[] = [];

  for (const { sentiment, price, fundamentals } of tickers) {
    // Calculate scores
    const scores = scoring.calculateAllScores(sentiment, price, fundamentals);

    // Get preliminary classification
    const { classification: prelimClassification, alertType, reason } = scoring.classifyTicker(scores);

    // Use Claude for detailed analysis (only for interesting tickers to save API calls)
    let classificationResult;
    if (alertType !== null || scores.attention > 50 || scores.momentum > 50) {
      classificationResult = await classifier.generateAnalysis({
        ticker: sentiment.ticker,
        scores,
        sentiment,
        price,
        fundamentals,
        preliminaryClassification: prelimClassification,
      });
    } else {
      classificationResult = {
        classification: prelimClassification,
        confidence: 0.5,
        bullCase: reason,
        bearCase: 'Does not meet criteria for detailed analysis',
        catalysts: [],
      };
    }

    results.push({
      ticker: sentiment.ticker,
      runId: RUN_ID,
      runTimestamp: new Date(),
      sentiment,
      price,
      fundamentals,
      scores,
      classification: classificationResult,
      alertTriggered: alertType !== null,
      alertType,
    });
  }

  return results;
}

/**
 * Save results to database
 */
async function saveResults(analyses: TickerAnalysis[]): Promise<void> {
  for (const analysis of analyses) {
    const { ticker, sentiment, price, fundamentals, scores, classification } = analysis;

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
        alert_triggered, alert_type
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
        $47, $48
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
        price.volume,
        price.avgVolume30d,
        price.relativeVolume,
        price.high52w,
        price.low52w,
        fundamentals.name,
        fundamentals.marketCap,
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
  errorMessage?: string
): Promise<void> {
  const duration = Date.now() - START_TIME;
  await db.query(
    `UPDATE scan_runs
     SET status = $1, tickers_scanned = $2, alerts_generated = $3,
         duration_ms = $4, error_message = $5
     WHERE run_id = $6`,
    [status, tickersScanned, alertsGenerated, duration, errorMessage || null, RUN_ID]
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
  console.log(`Total tickers analyzed: ${analyses.length}`);
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
