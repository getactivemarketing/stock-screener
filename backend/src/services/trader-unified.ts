/**
 * Unified Trade Decision Engine (value + catalyst)
 *
 * Consumes UnifiedPipelineResult[] produced by pipeline-unified.ts (via DB
 * scan_results rows, assembled by Phase G caller). Produces BUY/HOLD/SELL/SKIP
 * decisions with category-aware hold periods and entry/exit attribution.
 *
 * NOT yet wired into any pipeline — Phase G flips the cron.
 */

import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import * as alpaca from './alpaca.js';
import { validateBuy } from './risk.js';
import {
  loadTradingConfig as _loadTradingConfig,
  reconcilePendingOrders as _reconcilePendingOrders,
} from './trader.js';
import type {
  TradingConfig,
  TradeDecision,
  AlpacaAccount,
  AlpacaPosition,
  Scores,
  ComponentScores,
  EntryCategory,
  PriceData,
  FundamentalData,
  UnifiedClassification,
} from '../types/index.js';

// ── Input shape (caller assembles from scan_results row) ────────

export interface UnifiedPipelineResult {
  ticker: string;
  price: PriceData;
  fundamentals: FundamentalData;
  scores: ComponentScores;
  tradeable: boolean;
  gateFailures: string[];
  category: EntryCategory;
  catalystDate: string | null;
  classification: UnifiedClassification;
}

// ── Re-exports (delegate to legacy trader) ──────────────────────

export async function loadTradingConfig(): Promise<TradingConfig> {
  return _loadTradingConfig();
}

export async function reconcilePendingOrders(): Promise<void> {
  return _reconcilePendingOrders();
}

// ── Constants ───────────────────────────────────────────────────

const CATEGORY_MAX_HOLD_DAYS: Record<EntryCategory, number> = {
  earnings_event: 12,
  insider_signal: 30,
  value_rerating: 45,
  attention_momentum: 7,
};

const STOP_LOSS_PCT = 12; // position down >= 12% from entry triggers stop
const CATALYST_FADE_DAYS = 2; // days past catalyst date before fade trigger

// Entry gates
const MIN_COMPOSITE = 45;
const MAX_RISK = 45;
const MIN_CONVICTION = 6;

// Sizing
const HIGH_CONVICTION_PCT = 14;
const STANDARD_PCT = 10;
const HIGH_CONVICTION_MIN_SCORE = 8;
const HIGH_CONVICTION_MIN_COMPOSITE = 68;
const MIN_NOTIONAL_USD = 100;

type ExitReason =
  | 'stop_loss'
  | 'catalyst_fade'
  | 'max_hold'
  | 'reclass_avoid'
  | 'scan_miss';

// Extended decision with unified-specific attribution fields (stored via cast
// on the legacy TradeDecision shape so Phase G can consume uniformly).
interface UnifiedDecisionExtras {
  entryCategory?: EntryCategory;
  entryCatalystDate?: string | null;
  entryComponentScores?: ComponentScores;
  exitComponentScores?: ComponentScores | null;
  exitReason?: ExitReason;
  alpacaOrderId?: string;
}

// Convert ComponentScores to legacy Scores for TradeDecision.scores field
function toLegacyScores(cs: ComponentScores): Scores {
  return {
    attention: Math.round(cs.attention),
    momentum: Math.round(cs.catalyst), // catalyst slot stored as momentum
    fundamentals: Math.round(cs.value),
    risk: Math.round(cs.risk),
  };
}

// ── Evaluate Decisions ──────────────────────────────────────────

export async function evaluate(
  results: UnifiedPipelineResult[],
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  config: TradingConfig
): Promise<TradeDecision[]> {
  const decisions: TradeDecision[] = [];
  const heldTickers = new Set(positions.map((p) => p.ticker));
  const resultMap = new Map<string, UnifiedPipelineResult>();
  for (const r of results) resultMap.set(r.ticker, r);

  // SELL / HOLD evaluation for existing positions
  for (const pos of positions) {
    const result = resultMap.get(pos.ticker) ?? null;
    const sellDecision = await evaluateSell(pos, result, config);
    decisions.push(sellDecision);
  }

  // BUY / SKIP for new tickers (not already held)
  for (const result of results) {
    if (heldTickers.has(result.ticker)) continue;
    const decision = evaluateBuy(result, positions, account, config);
    decisions.push(decision);
  }

  return decisions;
}

async function evaluateSell(
  position: AlpacaPosition,
  result: UnifiedPipelineResult | null,
  config: TradingConfig
): Promise<TradeDecision> {
  const ticker = position.ticker;

  // Pull portfolio_state for category, catalyst date, scan misses, days held
  const stateRows = await db.query<{
    days_held: number;
    consecutive_scan_misses: number;
    entry_date: string | null;
    entry_category: EntryCategory | null;
    entry_catalyst_date: string | null;
  }>(
    `SELECT days_held, consecutive_scan_misses, entry_date,
            entry_category, entry_catalyst_date
     FROM portfolio_state
     WHERE ticker = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [ticker]
  );
  const state = stateRows[0] ?? null;

  const daysHeld = state?.days_held ?? 0;
  const scanMisses = state?.consecutive_scan_misses ?? 0;
  const category: EntryCategory | null =
    state?.entry_category ?? result?.category ?? null;
  const catalystDate = state?.entry_catalyst_date ?? result?.catalystDate ?? null;

  const scores: Scores = result
    ? toLegacyScores(result.scores)
    : { attention: 0, momentum: 0, fundamentals: 0, risk: 0 };
  const classification = result?.classification.recommendation ?? 'unknown';
  const tradeRationale = result?.classification.thesis;

  const extras: UnifiedDecisionExtras = {
    exitComponentScores: result ? result.scores : null,
  };

  // 1. Stop-loss: down >= STOP_LOSS_PCT from entry
  if (position.unrealizedPlPct <= -STOP_LOSS_PCT) {
    extras.exitReason = 'stop_loss';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Stop-loss: position down ${position.unrealizedPlPct.toFixed(2)}% (limit -${STOP_LOSS_PCT}%)`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
      },
      extras
    );
  }

  // 2. Category max hold exceeded
  const maxHoldDays = category
    ? CATEGORY_MAX_HOLD_DAYS[category]
    : config.holdDaysMax;
  if (daysHeld >= maxHoldDays) {
    extras.exitReason = 'max_hold';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Max hold exceeded (${daysHeld}d >= ${maxHoldDays}d for ${category ?? 'unknown'})`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
      },
      extras
    );
  }

  // 3. Reclassification to AVOID in current scan
  if (result && result.classification.recommendation === 'AVOID') {
    extras.exitReason = 'reclass_avoid';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Reclassified as AVOID (conviction ${result.classification.convictionScore}/10)`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
      },
      extras
    );
  }

  // 4. Catalyst fade (earnings_event only): catalyst date passed by > N days
  if (category === 'earnings_event' && catalystDate) {
    const catalystMs = new Date(catalystDate).getTime();
    if (!Number.isNaN(catalystMs)) {
      const daysPast = Math.floor(
        (Date.now() - catalystMs) / (1000 * 60 * 60 * 24)
      );
      if (daysPast > CATALYST_FADE_DAYS) {
        extras.exitReason = 'catalyst_fade';
        return Object.assign(
          {
            ticker,
            action: 'SELL' as const,
            reason: `Catalyst fade: earnings date ${catalystDate} passed ${daysPast}d ago (> ${CATALYST_FADE_DAYS}d)`,
            quantity: position.quantity,
            classification,
            scores,
            tradeRationale,
          },
          extras
        );
      }
    }
  }

  // 5. Scan miss: ticker absent from last N scans
  if (scanMisses >= config.scanMissMax) {
    extras.exitReason = 'scan_miss';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Scan miss: absent from ${scanMisses} consecutive scans (limit ${config.scanMissMax})`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
      },
      extras
    );
  }

  // HOLD
  return {
    ticker,
    action: 'HOLD',
    reason: `Holding (${daysHeld}d, P/L ${position.unrealizedPlPct.toFixed(1)}%, misses ${scanMisses}, ${category ?? 'no-cat'})`,
    classification,
    scores,
    tradeRationale,
  };
}

function evaluateBuy(
  result: UnifiedPipelineResult,
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  config: TradingConfig
): TradeDecision {
  const ticker = result.ticker;
  const scores = toLegacyScores(result.scores);
  const classification = result.classification.recommendation;
  const tradeRationale = result.classification.thesis;
  const keyRisk = result.classification.keyRisks[0];

  const baseDecision = {
    ticker,
    classification,
    scores,
    tradeRationale,
    keyRisk,
  };

  // Gate: tradeable
  if (!result.tradeable) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Not tradeable: ${result.gateFailures.join(', ') || 'gate failure'}`,
    };
  }

  // Gate: recommendation must be BUY
  if (classification !== 'BUY') {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Recommendation is ${classification}, not BUY`,
    };
  }

  // Gate: composite
  if (result.scores.composite < MIN_COMPOSITE) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Composite ${result.scores.composite.toFixed(1)} < ${MIN_COMPOSITE}`,
    };
  }

  // Gate: risk
  if (result.scores.risk > MAX_RISK) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Risk ${result.scores.risk.toFixed(1)} > ${MAX_RISK}`,
    };
  }

  // Gate: conviction
  if (result.classification.convictionScore < MIN_CONVICTION) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Conviction ${result.classification.convictionScore} < ${MIN_CONVICTION}`,
    };
  }

  // Position sizing by conviction
  const isHighConviction =
    result.classification.convictionScore >= HIGH_CONVICTION_MIN_SCORE &&
    result.scores.composite >= HIGH_CONVICTION_MIN_COMPOSITE;
  let sizePct = isHighConviction ? HIGH_CONVICTION_PCT : STANDARD_PCT;
  if (sizePct > config.maxPositionPct) sizePct = config.maxPositionPct;

  const rawOrderValue = account.portfolioValue * (sizePct / 100);
  const orderValue = rawOrderValue * (1 - config.slippagePct / 100);
  const price = result.price.price;

  if (orderValue < MIN_NOTIONAL_USD) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Budget $${orderValue.toFixed(2)} below min $${MIN_NOTIONAL_USD}`,
    };
  }

  const quantity = Math.floor(orderValue / price);
  if (quantity <= 0) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Position too small (price $${price.toFixed(2)}, budget $${orderValue.toFixed(2)})`,
    };
  }

  // Shared risk checks (max positions, portfolio heat, daily loss, dupes, buying power)
  const actualOrderValue = quantity * price;
  const riskCheck = validateBuy(ticker, actualOrderValue, account, positions, config);
  if (!riskCheck.approved) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Risk check failed: ${riskCheck.reason}`,
    };
  }

  const extras: UnifiedDecisionExtras = {
    entryCategory: result.category,
    entryCatalystDate: result.catalystDate,
    entryComponentScores: result.scores,
  };

  return Object.assign(
    {
      ...baseDecision,
      action: 'BUY' as const,
      reason:
        `${result.category} ${isHighConviction ? '[high conv]' : '[std]'} — ` +
        `V:${result.scores.value.toFixed(0)} C:${result.scores.catalyst.toFixed(0)} ` +
        `U:${result.scores.upside.toFixed(0)} R:${result.scores.risk.toFixed(0)} ` +
        `Comp:${result.scores.composite.toFixed(1)} Conv:${result.classification.convictionScore}/10`,
      quantity,
      positionSizePct: sizePct,
      configSnapshot: config,
    },
    extras
  );
}

// ── Execute Decisions ───────────────────────────────────────────

export async function execute(
  decisions: TradeDecision[]
): Promise<TradeDecision[]> {
  const executed: TradeDecision[] = [];

  for (const decision of decisions) {
    if (decision.action === 'BUY' || decision.action === 'SELL') {
      try {
        const order = await alpaca.placeOrder({
          ticker: decision.ticker,
          side: decision.action === 'BUY' ? 'buy' : 'sell',
          quantity: decision.quantity!,
          type: 'market',
        });
        (decision as TradeDecision & UnifiedDecisionExtras).alpacaOrderId =
          order.id;
        executed.push(decision);
        console.log(
          `[Trader] Placed ${decision.action} ${decision.ticker}: ${decision.quantity} shares (order ${order.id})`
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Trader] Failed ${decision.action} ${decision.ticker}: ${errMsg}`
        );
        executed.push({
          ...decision,
          action: decision.action === 'BUY' ? 'SKIP' : 'HOLD',
          reason: `Order failed: ${errMsg}`,
        });
      }
    } else {
      executed.push(decision);
    }
  }

  return executed;
}

// ── Log Decisions ───────────────────────────────────────────────

export async function logDecisions(
  decisions: TradeDecision[],
  runId: string
): Promise<void> {
  for (const d of decisions) {
    const extras = d as TradeDecision & UnifiedDecisionExtras;

    if (d.action === 'BUY') {
      const srRows = await db.query<{ id: number }>(
        `SELECT id FROM scan_results WHERE run_id = $1 AND ticker = $2 LIMIT 1`,
        [runId, d.ticker]
      );
      const scanResultId = srRows.length > 0 ? srRows[0].id : null;

      const cs = extras.entryComponentScores ?? null;

      await db.query(
        `INSERT INTO trades (
          id, scan_result_id, run_id, ticker, action, quantity, order_type,
          alpaca_order_id, status, classification, confidence, scores,
          trade_rationale, key_risk, position_size_pct, stop_loss,
          target_price, config_snapshot,
          entry_value_score, entry_catalyst_score, entry_upside_score,
          entry_risk_score, entry_composite,
          entry_category, entry_catalyst_type, entry_catalyst_date,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          $19, $20, $21,
          $22, $23,
          $24, $25, $26,
          NOW(), NOW()
        )`,
        [
          uuidv4(),
          scanResultId,
          runId,
          d.ticker,
          d.action,
          d.quantity ?? 0,
          'MKT',
          extras.alpacaOrderId ?? null,
          'pending',
          d.classification,
          null,
          JSON.stringify(d.scores),
          d.tradeRationale ?? null,
          d.keyRisk ?? null,
          d.positionSizePct ?? null,
          d.stopLoss ?? null,
          d.targetPrice ?? null,
          d.configSnapshot ? JSON.stringify(d.configSnapshot) : null,
          cs?.value ?? null,
          cs?.catalyst ?? null,
          cs?.upside ?? null,
          cs?.risk ?? null,
          cs?.composite ?? null,
          extras.entryCategory ?? null,
          extras.entryCategory ?? null, // catalyst_type == category for now
          extras.entryCatalystDate ?? null,
        ]
      );
    } else if (d.action === 'SELL') {
      // On SELL: also insert a trade row (mirrors legacy trader pattern) and
      // UPDATE the open entry row with exit attribution columns.
      const srRows = await db.query<{ id: number }>(
        `SELECT id FROM scan_results WHERE run_id = $1 AND ticker = $2 LIMIT 1`,
        [runId, d.ticker]
      );
      const scanResultId = srRows.length > 0 ? srRows[0].id : null;

      await db.query(
        `INSERT INTO trades (
          id, scan_result_id, run_id, ticker, action, quantity, order_type,
          alpaca_order_id, status, classification, confidence, scores,
          trade_rationale, key_risk, position_size_pct, stop_loss,
          target_price, config_snapshot, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, NOW(), NOW()
        )`,
        [
          uuidv4(),
          scanResultId,
          runId,
          d.ticker,
          d.action,
          d.quantity ?? 0,
          'MKT',
          extras.alpacaOrderId ?? null,
          'pending',
          d.classification,
          null,
          JSON.stringify(d.scores),
          d.tradeRationale ?? null,
          d.keyRisk ?? null,
          d.positionSizePct ?? null,
          d.stopLoss ?? null,
          d.targetPrice ?? null,
          d.configSnapshot ? JSON.stringify(d.configSnapshot) : null,
        ]
      );

      // Update the most recent filled BUY row for this ticker with exit attribution
      const exitCs = extras.exitComponentScores ?? null;
      await db.query(
        `UPDATE trades
         SET exit_value_score = $1,
             exit_catalyst_score = $2,
             exit_upside_score = $3,
             exit_risk_score = $4,
             exit_composite = $5,
             exit_reason = $6,
             updated_at = NOW()
         WHERE id = (
           SELECT id FROM trades
           WHERE ticker = $7
             AND action = 'BUY'
             AND status = 'filled'
             AND exit_reason IS NULL
           ORDER BY created_at DESC
           LIMIT 1
         )`,
        [
          exitCs?.value ?? null,
          exitCs?.catalyst ?? null,
          exitCs?.upside ?? null,
          exitCs?.risk ?? null,
          exitCs?.composite ?? null,
          extras.exitReason ?? null,
          d.ticker,
        ]
      );
    } else {
      // HOLD / SKIP
      await db.query(
        `INSERT INTO trade_decisions (id, run_id, ticker, action, reason, classification, scores, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          uuidv4(),
          runId,
          d.ticker,
          d.action,
          d.reason,
          d.classification,
          JSON.stringify(d.scores),
        ]
      );
    }
  }

  const buys = decisions.filter((d) => d.action === 'BUY').length;
  const sells = decisions.filter((d) => d.action === 'SELL').length;
  const holds = decisions.filter((d) => d.action === 'HOLD').length;
  const skips = decisions.filter((d) => d.action === 'SKIP').length;
  console.log(
    `[Trader] Logged ${decisions.length} decisions: ${buys} BUY, ${sells} SELL, ${holds} HOLD, ${skips} SKIP`
  );
}

// ── Update Portfolio State ──────────────────────────────────────

export async function updatePortfolioState(
  runId: string,
  results: UnifiedPipelineResult[]
): Promise<void> {
  const positions = await alpaca.getPositions();
  const resultTickers = new Set(results.map((r) => r.ticker));
  const resultMap = new Map<string, UnifiedPipelineResult>();
  for (const r of results) resultMap.set(r.ticker, r);

  for (const pos of positions) {
    const prevRows = await db.query<{
      consecutive_scan_misses: number;
      entry_date: string | null;
      days_held: number;
      classification_at_entry: string | null;
      stop_loss: number | null;
      target_price: number | null;
      entry_category: EntryCategory | null;
      entry_catalyst_date: string | null;
    }>(
      `SELECT consecutive_scan_misses, entry_date, days_held,
              classification_at_entry, stop_loss, target_price,
              entry_category, entry_catalyst_date
       FROM portfolio_state
       WHERE ticker = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [pos.ticker]
    );
    const prev = prevRows[0] ?? null;
    const inCurrentScan = resultTickers.has(pos.ticker);
    const scanMisses = inCurrentScan
      ? 0
      : (prev?.consecutive_scan_misses ?? 0) + 1;

    let entryDate: string;
    let daysHeld: number;
    if (prev?.entry_date) {
      entryDate = prev.entry_date;
      const diffMs = Date.now() - new Date(entryDate).getTime();
      daysHeld = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    } else {
      entryDate = new Date().toISOString().split('T')[0];
      daysHeld = 0;
    }

    const result = resultMap.get(pos.ticker);
    const stopLoss = prev?.stop_loss ?? null;
    const targetPrice = prev?.target_price ?? null;
    const classificationAtEntry =
      prev?.classification_at_entry ??
      result?.classification.recommendation ??
      null;
    const entryCategory = prev?.entry_category ?? result?.category ?? null;
    const entryCatalystDate =
      prev?.entry_catalyst_date ?? result?.catalystDate ?? null;

    await db.query(
      `INSERT INTO portfolio_state (
        id, run_id, ticker, quantity, avg_entry_price, current_price,
        unrealized_pl_pct, entry_date, days_held, classification_at_entry,
        stop_loss, target_price, consecutive_scan_misses,
        entry_category, entry_catalyst_date, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, NOW()
      )
      ON CONFLICT (run_id, ticker) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        avg_entry_price = EXCLUDED.avg_entry_price,
        current_price = EXCLUDED.current_price,
        unrealized_pl_pct = EXCLUDED.unrealized_pl_pct,
        days_held = EXCLUDED.days_held,
        stop_loss = EXCLUDED.stop_loss,
        target_price = EXCLUDED.target_price,
        consecutive_scan_misses = EXCLUDED.consecutive_scan_misses,
        entry_category = EXCLUDED.entry_category,
        entry_catalyst_date = EXCLUDED.entry_catalyst_date`,
      [
        uuidv4(),
        runId,
        pos.ticker,
        pos.quantity,
        pos.avgEntryPrice,
        pos.currentPrice,
        pos.unrealizedPlPct,
        entryDate,
        daysHeld,
        classificationAtEntry,
        stopLoss,
        targetPrice,
        scanMisses,
        entryCategory,
        entryCatalystDate,
      ]
    );
  }

  console.log(
    `[Trader] Updated portfolio state for ${positions.length} positions (run ${runId})`
  );
}

export default {
  loadTradingConfig,
  reconcilePendingOrders,
  evaluate,
  execute,
  logDecisions,
  updatePortfolioState,
};
