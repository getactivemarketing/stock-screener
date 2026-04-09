// backend/src/pipeline-unified.ts
/**
 * Unified value + catalyst screener pipeline (Phase E).
 *
 * This is an ADDITIVE pipeline that runs end-to-end alongside the legacy
 * `pipeline.ts`. Phase G will flip the cron to point here and delete the old
 * file. DO NOT call the trader from this file — F1 will handle that.
 *
 * Stages:
 *   1. Create run record
 *   2. Fetch sentiment (apewisdom, stocktwits, finviz) + capture finviz sources
 *   3. Merge sentiment by ticker
 *   4. Select top N candidates by weighted (mentions, finviz hits, catalyst bonus)
 *   5. Enrich with Finnhub price+fundamentals and Yahoo quoteSummary
 *   6. Classifier enrichment (analyst, earnings, news, insider)
 *   7. Technical indicators
 *   8. Tradeability gates
 *   9. Unified scoring
 *  10. LLM classify (tradeable + composite >= 35 only)
 *  11. Entry category assignment
 *  12. Save to scan_results (with tradeable + gate_failures)
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import db from './db/index.js';
import apewisdom from './services/apewisdom.js';
import finnhub from './services/finnhub.js';
import { enrichForClassifier } from './services/finnhub.js';
import { fetchStocktwitsTrending, fetchStocktwitsActive } from './services/stocktwits.js';
import { fetchAllFinvizSignals } from './services/finviz.js';
import { fetchQuoteSummary } from './services/yahoo.js';
import { calculateAllUnifiedScores, classifyUnified } from './services/scoring.js';
import { generateUnifiedAnalysis } from './services/classifier.js';
import technicals, { type TechnicalIndicators } from './services/technicals.js';
import { evaluateTradeability } from './lib/tradeability.js';
import { sleep } from './lib/http.js';
import * as traderUnified from './services/trader-unified.js';
import * as alpacaService from './services/alpaca.js';
import type { UnifiedPipelineResult } from './services/trader-unified.js';
import type {
  SentimentData,
  MergedSentiment,
  PriceData,
  FundamentalData,
  ClassifierEnrichment,
  YahooQuoteSummary,
  ComponentScores,
  EntryCategory,
  UnifiedClassification,
  TradeabilityResult,
} from './types/index.js';

const RUN_ID = uuidv4();
const START_TIME = Date.now();
const MAX_CANDIDATES = process.env.MAX_TICKERS ? parseInt(process.env.MAX_TICKERS) : 30;

// ── E1: Category classification helper ───────────────────────────────────

function classifyEntryCategory(
  scores: ComponentScores,
  enrichment: ClassifierEnrichment | undefined,
  _finvizSources: Set<string>
): { category: EntryCategory; catalystDate: string | null } {
  const dte = enrichment?.earnings?.daysToEarnings;
  if (typeof dte === 'number' && dte >= 0 && dte <= 14) {
    return {
      category: 'earnings_event',
      catalystDate: enrichment?.earnings?.nextDate ?? null,
    };
  }
  if (enrichment?.insiderActivity?.largeBuy90d) {
    return { category: 'insider_signal', catalystDate: null };
  }
  if (scores.value >= 60) {
    return { category: 'value_rerating', catalystDate: null };
  }
  return { category: 'attention_momentum', catalystDate: null };
}

// ── Sentiment fetching (parallels pipeline.ts) ───────────────────────────

async function fetchAllSentimentData(): Promise<{
  sentiment: SentimentData[];
  finvizSourcesByTicker: Map<string, Set<string>>;
}> {
  const results: SentimentData[] = [];
  const finvizSourcesByTicker = new Map<string, Set<string>>();

  console.log('  - ApeWisdom...');
  const [allStocks, pennystocks, wsb] = await Promise.all([
    apewisdom.fetchTrendingStocks('all-stocks'),
    apewisdom.fetchTrendingStocks('pennystocks'),
    apewisdom.fetchTrendingStocks('wallstreetbets'),
  ]);
  results.push(...allStocks, ...pennystocks, ...wsb);
  console.log(`    ${allStocks.length + pennystocks.length + wsb.length} entries`);

  console.log('  - Stocktwits...');
  const [stTrending, stActive] = await Promise.all([
    fetchStocktwitsTrending(),
    fetchStocktwitsActive(),
  ]);
  for (const item of [...stTrending, ...stActive]) {
    results.push({
      ticker: item.ticker,
      source: 'stocktwits',
      mentions: item.watchlistCount,
      sentiment: item.sentiment,
      rank: 0,
    });
  }
  console.log(`    ${stTrending.length + stActive.length} entries`);

  console.log('  - Finviz (6 screens)...');
  const finvizData = await fetchAllFinvizSignals();
  for (const item of finvizData) {
    results.push({
      ticker: item.ticker,
      source: 'finviz',
      mentions: 1,
      sentiment: 75,
      rank: 0,
    });
    const key = item.ticker.toUpperCase();
    if (!finvizSourcesByTicker.has(key)) {
      finvizSourcesByTicker.set(key, new Set<string>());
    }
    finvizSourcesByTicker.get(key)!.add(item.source);
  }
  console.log(`    ${finvizData.length} entries across ${finvizSourcesByTicker.size} tickers`);

  return { sentiment: results, finvizSourcesByTicker };
}

// ── Merge sentiment (copied from pipeline.ts) ────────────────────────────

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
    if (!merged[ticker].sources[item.source]) {
      merged[ticker].sources[item.source] = item;
      merged[ticker].sourceCount++;
    } else if (item.mentions > (merged[ticker].sources[item.source]?.mentions || 0)) {
      merged[ticker].sources[item.source] = item;
    }
  }

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
    m.isPennyStock = !!(m.sources['apewisdom-penny'] || m.sources.finviz);
  }

  return merged;
}

// ── Candidate selection (no price cap, weighted) ─────────────────────────

interface Candidate {
  ticker: string;
  sentiment: MergedSentiment;
  finvizSources: Set<string>;
  score: number;
}

function selectTopCandidates(
  merged: Record<string, MergedSentiment>,
  finvizSourcesByTicker: Map<string, Set<string>>,
  n: number
): Candidate[] {
  const CATALYST_SOURCES = new Set<string>(['earnings_catalyst', 'analyst_upgrade', 'insider_buying']);
  const scored: Candidate[] = [];

  for (const [ticker, sentiment] of Object.entries(merged)) {
    const fvSources = finvizSourcesByTicker.get(ticker) ?? new Set<string>();
    const mentionsScore = Math.min(20, sentiment.totalMentions / 10);
    const finvizScore = fvSources.size * 15;
    let catalystBonus = 0;
    for (const s of fvSources) {
      if (CATALYST_SOURCES.has(s)) {
        catalystBonus = 10;
        break;
      }
    }
    scored.push({
      ticker,
      sentiment,
      finvizSources: fvSources,
      score: mentionsScore + finvizScore + catalystBonus,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

// ── Enrichment pass ──────────────────────────────────────────────────────

interface EnrichedTicker {
  ticker: string;
  sentiment: MergedSentiment;
  finvizSources: Set<string>;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
}

async function enrichWithMarketData(candidates: Candidate[]): Promise<EnrichedTicker[]> {
  const results: EnrichedTicker[] = [];
  let processed = 0;

  for (const cand of candidates) {
    try {
      const [price, fundamentals, yahoo] = await Promise.all([
        finnhub.fetchPriceData(cand.ticker),
        finnhub.fetchFundamentalData(cand.ticker),
        fetchQuoteSummary(cand.ticker),
      ]);
      if (price && fundamentals) {
        results.push({
          ticker: cand.ticker,
          sentiment: cand.sentiment,
          finvizSources: cand.finvizSources,
          price,
          fundamentals,
          yahoo,
        });
      } else {
        console.log(`  Dropped ${cand.ticker}: missing price/fundamentals`);
      }
    } catch (err) {
      console.warn(`  Failed to enrich ${cand.ticker}:`, (err as Error).message);
    }
    processed++;
    if (processed % 10 === 0) {
      console.log(`  Progress: ${processed}/${candidates.length}`);
    }
    await sleep(150);
  }

  return results;
}

// ── Main pipeline ────────────────────────────────────────────────────────

async function runUnifiedPipeline(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Unified Screener Pipeline - Run ID: ${RUN_ID}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // 1. Create run record
    await db.query(
      'INSERT INTO scan_runs (run_id, run_timestamp, status) VALUES ($1, $2, $3)',
      [RUN_ID, new Date(), 'running']
    );

    // 2. Sentiment
    console.log('[1/9] Fetching sentiment data...');
    const { sentiment, finvizSourcesByTicker } = await fetchAllSentimentData();
    console.log(`  Found ${sentiment.length} sentiment records`);

    // 3. Merge
    console.log('\n[2/9] Merging sentiment by ticker...');
    const merged = mergeSentimentByTicker(sentiment);
    console.log(`  ${Object.keys(merged).length} unique tickers`);

    // 4. Select candidates
    console.log('\n[3/9] Selecting top candidates...');
    const candidates = selectTopCandidates(merged, finvizSourcesByTicker, MAX_CANDIDATES);
    console.log(`  Selected ${candidates.length} candidates`);

    // 5. Market data enrichment
    console.log('\n[4/9] Enriching with Finnhub + Yahoo...');
    const enriched = await enrichWithMarketData(candidates);
    console.log(`  ${enriched.length} enriched tickers`);

    // 6. Classifier enrichment
    console.log('\n[5/9] Fetching classifier enrichment...');
    const enrichmentMap = new Map<string, ClassifierEnrichment | undefined>();
    for (const t of enriched) {
      try {
        const e = await enrichForClassifier(t.ticker, []);
        enrichmentMap.set(t.ticker, e);
      } catch (err) {
        console.warn(`  Enrichment failed for ${t.ticker}:`, (err as Error).message);
        enrichmentMap.set(t.ticker, undefined);
      }
      await sleep(1000);
    }

    // 7. Technicals
    console.log('\n[6/9] Calculating technicals...');
    const technicalsMap = new Map<string, TechnicalIndicators | null>();
    for (const t of enriched) {
      try {
        const ind = await technicals.calculateTechnicalIndicators(t.ticker);
        technicalsMap.set(t.ticker, ind);
      } catch (err) {
        console.warn(`  Technicals failed for ${t.ticker}:`, (err as Error).message);
        technicalsMap.set(t.ticker, null);
      }
      await sleep(500);
    }

    // 8. Tradeability + 9. scoring + 10. LLM + 11. categorize
    console.log('\n[7/9] Gates + scoring + classification...');
    interface FinalRow {
      enriched: EnrichedTicker;
      enrichment: ClassifierEnrichment | undefined;
      tech: TechnicalIndicators | null;
      tradeability: TradeabilityResult;
      scores: ComponentScores;
      classification: UnifiedClassification;
      category: EntryCategory;
      catalystDate: string | null;
      recommendation: 'BUY' | 'WATCH' | 'AVOID';
    }
    const finalRows: FinalRow[] = [];

    for (const t of enriched) {
      const enrichment = enrichmentMap.get(t.ticker);
      const tech = technicalsMap.get(t.ticker) ?? null;

      const tradeability = evaluateTradeability({
        price: t.price,
        fundamentals: t.fundamentals,
        yahoo: t.yahoo,
        enrichment,
      });

      const scores = calculateAllUnifiedScores({
        sentiment: t.sentiment,
        price: t.price,
        fundamentals: t.fundamentals,
        yahoo: t.yahoo,
        enrichment,
        technicals: tech,
        finvizHits: t.finvizSources.size,
      });

      let classification: UnifiedClassification;
      if (!tradeability.tradeable) {
        classification = {
          thesis: 'skipped: not tradeable',
          valueCase: '',
          catalysts: [],
          keyRisks: [],
          expectedReturn30d: 0,
          convictionScore: 0,
          recommendation: 'AVOID',
        };
      } else if (scores.composite < 35) {
        classification = {
          thesis: 'skipped: low composite',
          valueCase: '',
          catalysts: [],
          keyRisks: [],
          expectedReturn30d: 0,
          convictionScore: 0,
          recommendation: 'AVOID',
        };
      } else {
        try {
          classification = await generateUnifiedAnalysis({
            ticker: t.ticker,
            price: t.price,
            fundamentals: t.fundamentals,
            yahoo: t.yahoo,
            enrichment,
            scores,
          });
        } catch (err) {
          console.warn(`  LLM failed for ${t.ticker}:`, (err as Error).message);
          classification = {
            thesis: 'llm_error',
            valueCase: '',
            catalysts: [],
            keyRisks: [],
            expectedReturn30d: 0,
            convictionScore: 0,
            recommendation: 'AVOID',
          };
        }
        await sleep(300);
      }

      const { category, catalystDate } = classifyEntryCategory(scores, enrichment, t.finvizSources);
      const recommendation = classifyUnified(scores, tradeability.tradeable);

      finalRows.push({
        enriched: t,
        enrichment,
        tech,
        tradeability,
        scores,
        classification,
        category,
        catalystDate,
        recommendation,
      });
    }

    // 12. Save
    console.log('\n[8/9] Saving results...');
    await saveResults(finalRows);
    console.log(`  Saved ${finalRows.length} rows`);

    // 13. Automated trading (unified)
    try {
      const tradingConfig = await traderUnified.loadTradingConfig();
      if (tradingConfig.enabled && alpacaService.isAlpacaConfigured()) {
        console.log('\n[Trader] Running unified trader...');
        await traderUnified.reconcilePendingOrders();
        const account = await alpacaService.getAccount();
        const positions = await alpacaService.getPositions();
        const traderInputs: UnifiedPipelineResult[] = finalRows.map((r) => ({
          ticker: r.enriched.ticker,
          price: r.enriched.price,
          fundamentals: r.enriched.fundamentals,
          scores: r.scores,
          tradeable: r.tradeability.tradeable,
          gateFailures: r.tradeability.failures,
          category: r.category,
          catalystDate: r.catalystDate,
          classification: r.classification,
        }));
        const decisions = await traderUnified.evaluate(traderInputs, positions, account, tradingConfig);
        const executed = await traderUnified.execute(decisions);
        await traderUnified.logDecisions(executed, RUN_ID);
        await traderUnified.updatePortfolioState(RUN_ID, traderInputs);
        const buys = executed.filter((d) => d.action === 'BUY').length;
        const sells = executed.filter((d) => d.action === 'SELL').length;
        console.log(`[Trader] ${buys} buys, ${sells} sells placed`);
      } else if (!tradingConfig.enabled) {
        console.log('\n[Trader] Disabled in config');
      } else {
        console.log('\n[Trader] Alpaca not configured, skipping');
      }
    } catch (traderErr) {
      console.error('[Trader] Failed:', traderErr instanceof Error ? traderErr.message : traderErr);
    }

    // Run record update
    const duration = Date.now() - START_TIME;
    const buyCount = finalRows.filter((r) => r.recommendation === 'BUY').length;
    await db.query(
      `UPDATE scan_runs SET status = $1, tickers_scanned = $2, alerts_generated = $3,
         duration_ms = $4 WHERE run_id = $5`,
      ['completed', finalRows.length, buyCount, duration, RUN_ID]
    );

    console.log('\n[9/9] Done.');
    console.log(`  Total: ${finalRows.length}  BUY: ${buyCount}  ` +
      `WATCH: ${finalRows.filter(r => r.recommendation === 'WATCH').length}  ` +
      `AVOID: ${finalRows.filter(r => r.recommendation === 'AVOID').length}`);
    console.log(`  Tradeable: ${finalRows.filter(r => r.tradeability.tradeable).length}/${finalRows.length}`);
    console.log(`  Duration: ${((Date.now() - START_TIME) / 1000).toFixed(1)}s\n`);
  } catch (err) {
    console.error('Unified pipeline failed:', err);
    const duration = Date.now() - START_TIME;
    await db.query(
      `UPDATE scan_runs SET status = $1, duration_ms = $2, error_message = $3 WHERE run_id = $4`,
      ['failed', duration, String(err), RUN_ID]
    );
    process.exit(1);
  } finally {
    await db.close();
  }
}

// ── Persistence ──────────────────────────────────────────────────────────

interface SaveRow {
  enriched: EnrichedTicker;
  enrichment: ClassifierEnrichment | undefined;
  tech: TechnicalIndicators | null;
  tradeability: TradeabilityResult;
  scores: ComponentScores;
  classification: UnifiedClassification;
  category: EntryCategory;
  catalystDate: string | null;
  recommendation: 'BUY' | 'WATCH' | 'AVOID';
}

async function saveResults(rows: SaveRow[]): Promise<void> {
  for (const row of rows) {
    const { enriched, enrichment, tech, tradeability, scores, classification, category, catalystDate, recommendation } = row;
    const { sentiment, price, fundamentals } = enriched;

    const thesisText = classification.thesis.slice(0, 2000);
    const catalystsArray = classification.catalysts.map((c) => c.description);
    const keyRisksJoined = classification.keyRisks.join(' | ');

    try {
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
          rsi_14, macd_value, macd_signal, macd_histogram,
          bb_upper, bb_middle, bb_lower,
          sma_20, sma_50, sma_200, ema_20,
          technical_signal, technical_strength,
          tier, value_score, catalyst_score, emerging_industry_score,
          thesis, edge_why_now, industry_theme, stop_loss_pct, expected_returns,
          analyst_mean_target, analyst_summary, earnings_date, days_to_earnings,
          earnings_beat_rate, news_headlines,
          tradeable, gate_failures,
          entry_category, catalyst_date, composite_score, upside_score,
          expected_return_30d, conviction_score
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
          $60, $61,
          $62, $63, $64, $65,
          $66, $67, $68, $69, $70,
          $71, $72, $73, $74,
          $75, $76,
          $77, $78,
          $79, $80, $81, $82,
          $83, $84
        )`,
        [
          RUN_ID,
          new Date(),
          enriched.ticker,
          // swaggy (unused in unified)
          null, null, null,
          // apewisdom
          sentiment.sources['apewisdom-penny']?.rank
            ?? sentiment.sources['apewisdom-all']?.rank
            ?? sentiment.sources['apewisdom-wsb']?.rank
            ?? null,
          sentiment.sources['apewisdom-penny']?.mentions
            ?? sentiment.sources['apewisdom-all']?.mentions
            ?? sentiment.sources['apewisdom-wsb']?.mentions
            ?? null,
          null, // altindex_score
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
          // Unified scores mapped to legacy columns:
          //   attention_score = scores.attention
          //   momentum_score = scores.upside (closest semantic match)
          //   fundamentals_score = scores.value
          //   risk_score = scores.risk
          scores.attention,
          scores.upside,
          scores.value,
          scores.risk,
          // classification (lowercase for legacy column)
          recommendation.toLowerCase(),
          classification.convictionScore / 10, // confidence 0-1
          classification.valueCase || null,
          keyRisksJoined || null,
          catalystsArray,
          recommendation === 'BUY',
          recommendation === 'BUY' ? 'unified_buy' : null,
          // technicals
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
          // Dual-tier-era columns — now holding unified component scores
          null, // tier (unused in unified)
          scores.value,
          scores.catalyst,
          scores.upside, // emerging_industry_score repurposed as upside (kept for back-compat)
          thesisText,
          null, // edge_why_now
          null, // industry_theme (migration 010 introduced dedicated entry_category column)
          null, // stop_loss_pct
          null, // expected_returns JSONB (migration 010 introduced dedicated composite_score/expected_return_30d columns)
          // Enrichment
          enrichment?.analystRatings?.meanTarget ?? null,
          enrichment?.analystRatings?.summary ?? null,
          enrichment?.earnings?.nextDate ?? null,
          enrichment?.earnings?.daysToEarnings ?? null,
          enrichment?.earnings?.earningsBeatRate ?? null,
          enrichment?.newsHeadlines ?? null,
          // Migration 009 columns
          tradeability.tradeable,
          tradeability.failures,
          // Migration 010 columns (dedicated unified fields)
          category,
          catalystDate,
          scores.composite,
          scores.upside,
          classification.expectedReturn30d,
          classification.convictionScore,
        ]
      );
    } catch (err) {
      console.error(`  Failed to save ${enriched.ticker}:`, (err as Error).message);
    }
  }
}

// Entry point
runUnifiedPipeline().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { runUnifiedPipeline, classifyEntryCategory, selectTopCandidates, mergeSentimentByTicker };
