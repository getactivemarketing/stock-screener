/**
 * Trade Decision Engine
 * Evaluates pipeline results and produces BUY/HOLD/SELL/SKIP decisions.
 * Handles order execution, decision logging, and portfolio state tracking.
 */

import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import * as alpaca from './alpaca.js';
import { validateBuy } from './risk.js';
import type {
  TradingConfig,
  TradeDecision,
  AlpacaAccount,
  AlpacaPosition,
  AlpacaOrder,
  Scores,
  TickerAnalysis,
  TechnicalIndicators,
} from '../types/index.js';
import type { TargetPrices } from './targets.js';

// Pipeline result type — TickerAnalysis enriched with targets and technicals
export type PipelineResult = TickerAnalysis & {
  targets: TargetPrices;
  technicals: TechnicalIndicators | null;
};

// ── Load Trading Config ─────────────────────────────────

export async function loadTradingConfig(): Promise<TradingConfig> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM trading_config WHERE id = 1'
  );

  if (rows.length === 0) {
    throw new Error('Trading config not found (id=1)');
  }

  const row = rows[0];
  return {
    enabled: row.enabled as boolean,
    maxPositions: row.max_positions as number,
    maxPositionPct: row.max_position_pct as number,
    maxPortfolioHeatPct: row.max_portfolio_heat_pct as number,
    minFundamentals: row.min_fundamentals as number,
    maxRisk: row.max_risk as number,
    minMomentum: row.min_momentum as number,
    holdDaysMax: row.hold_days_max as number,
    highConvictionSizePct: row.high_conviction_size_pct as number,
    highConvictionMinScores: row.high_conviction_min_scores as number,
    highConvictionMaxRisk: row.high_conviction_max_risk as number,
    dailyLossLimitPct: row.daily_loss_limit_pct as number,
    scanMissMax: row.scan_miss_max as number,
    slippagePct: row.slippage_pct as number,
    qualityHoldDaysMax: Number(row.quality_hold_days_max) || 15,
    // Speculative tier (migration 011). Numeric columns come back as strings
    // from pg unless explicitly cast — coerce via Number() to keep math safe.
    speculativeEnabled: (row.speculative_enabled as boolean) ?? false,
    speculativePositionPct: Number(row.speculative_position_pct) || 1.5,
    speculativeMaxPositions: Number(row.speculative_max_positions) || 5,
    speculativePortfolioHeatPct: Number(row.speculative_portfolio_heat_pct) || 8.0,
    speculativeStopLossPct: Number(row.speculative_stop_loss_pct) || 15.0,
    speculativeMaxHoldDays: Number(row.speculative_max_hold_days) || 5,
    speculativeMinComposite: Number(row.speculative_min_composite) || 50.0,
  };
}

// ── Reconcile Pending Orders ────────────────────────────

export async function reconcilePendingOrders(): Promise<void> {
  const pending = await db.query<{ id: string; alpaca_order_id: string }>(
    `SELECT id, alpaca_order_id FROM trades
     WHERE status = 'pending' AND alpaca_order_id IS NOT NULL`
  );

  if (pending.length === 0) return;

  const orders = await alpaca.getOrders('all');
  const orderMap = new Map<string, AlpacaOrder>();
  for (const o of orders) {
    orderMap.set(o.id, o);
  }

  for (const trade of pending) {
    const order = orderMap.get(trade.alpaca_order_id);
    if (!order) continue;

    let status: string;
    switch (order.status) {
      case 'filled':
        status = 'filled';
        break;
      case 'partially_filled':
        status = 'partial';
        break;
      case 'canceled':
      case 'expired':
      case 'suspended':
        status = 'cancelled';
        break;
      case 'rejected':
        status = 'rejected';
        break;
      default:
        // Still pending (new, accepted, pending_new, etc.)
        continue;
    }

    await db.query(
      `UPDATE trades
       SET status = $1, filled_price = $2, filled_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [status, order.filledAvgPrice, order.filledAt, trade.id]
    );

    console.log(`Reconciled trade ${trade.id}: ${status}` +
      (order.filledAvgPrice ? ` @ $${order.filledAvgPrice}` : ''));
  }
}

// ── Evaluate Decisions ──────────────────────────────────

export async function evaluate(
  results: PipelineResult[],
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  tradingConfig: TradingConfig
): Promise<TradeDecision[]> {
  const decisions: TradeDecision[] = [];
  const resultTickers = new Set(results.map((r) => r.ticker));
  const heldTickers = new Set(positions.map((p) => p.ticker));

  // Build a lookup for results by ticker
  const resultMap = new Map<string, PipelineResult>();
  for (const r of results) {
    resultMap.set(r.ticker, r);
  }

  // ── Evaluate existing positions for SELL / HOLD ──
  for (const pos of positions) {
    const analysis = resultMap.get(pos.ticker);
    const sellDecision = await evaluateSell(pos, analysis ?? null, tradingConfig);
    decisions.push(sellDecision);
  }

  // ── Evaluate new tickers for BUY / SKIP ──
  for (const result of results) {
    if (heldTickers.has(result.ticker)) continue; // Already handled above

    const decision = await evaluateBuy(
      result,
      positions,
      account,
      tradingConfig
    );
    decisions.push(decision);
  }

  return decisions;
}

async function evaluateSell(
  position: AlpacaPosition,
  analysis: PipelineResult | null,
  config: TradingConfig
): Promise<TradeDecision> {
  const ticker = position.ticker;
  const classification = analysis?.classification.classification ?? 'unknown';
  const scores = analysis?.scores ?? { attention: 0, momentum: 0, fundamentals: 0, risk: 0 };
  const tradeRationale = analysis ? (analysis.classification as any).tradeRationale : undefined;
  const keyRisk = analysis ? (analysis.classification as any).keyRisk : undefined;

  // Query portfolio_state for days_held and scan misses
  const stateRows = await db.query<{
    days_held: number;
    consecutive_scan_misses: number;
    stop_loss: number | null;
    target_price: number | null;
    entry_date: string | null;
  }>(
    `SELECT days_held, consecutive_scan_misses, stop_loss, target_price, entry_date
     FROM portfolio_state
     WHERE ticker = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [ticker]
  );

  const state = stateRows[0] ?? null;
  const daysHeld = state?.days_held ?? 0;
  const scanMisses = state?.consecutive_scan_misses ?? 0;
  const stopLoss = analysis?.targets.stopLoss ?? state?.stop_loss ?? null;
  const targetPrice = analysis?.targets.average ?? state?.target_price ?? null;

  // ── SELL Criteria ──

  // 1. Stop-loss breach
  if (stopLoss && position.currentPrice <= stopLoss) {
    return {
      ticker,
      action: 'SELL',
      reason: `Stop-loss triggered: $${position.currentPrice.toFixed(2)} <= $${stopLoss.toFixed(2)}`,
      quantity: position.quantity,
      classification,
      scores,
      tradeRationale,
      keyRisk,
      stopLoss,
      targetPrice: targetPrice ?? undefined,
    };
  }

  // 2. Reclassified to 'avoid'
  if (analysis && classification === 'avoid') {
    return {
      ticker,
      action: 'SELL',
      reason: `Reclassified as "avoid" (confidence: ${(analysis.classification.confidence * 100).toFixed(0)}%)`,
      quantity: position.quantity,
      classification,
      scores,
      tradeRationale,
      keyRisk,
      stopLoss: stopLoss ?? undefined,
      targetPrice: targetPrice ?? undefined,
    };
  }

  // 3. Max hold days exceeded
  // Use tier-appropriate hold period
  const maxHoldDays = (analysis?.tier === 'QUALITY')
    ? config.qualityHoldDaysMax
    : config.holdDaysMax;

  if (daysHeld >= maxHoldDays) {
    return {
      ticker,
      action: 'SELL',
      reason: `Max hold period exceeded (${daysHeld} >= ${maxHoldDays} days)`,
      quantity: position.quantity,
      classification,
      scores,
      tradeRationale,
      keyRisk,
      stopLoss: stopLoss ?? undefined,
      targetPrice: targetPrice ?? undefined,
    };
  }

  // 4. Too many consecutive scan misses (ticker dropped off radar)
  if (scanMisses >= config.scanMissMax) {
    return {
      ticker,
      action: 'SELL',
      reason: `Ticker dropped off radar (${scanMisses} consecutive scan misses >= ${config.scanMissMax})`,
      quantity: position.quantity,
      classification,
      scores,
      tradeRationale,
      keyRisk,
      stopLoss: stopLoss ?? undefined,
      targetPrice: targetPrice ?? undefined,
    };
  }

  // No sell criteria met — HOLD
  return {
    ticker,
    action: 'HOLD',
    reason: `Holding (${daysHeld}d held, P/L ${position.unrealizedPlPct.toFixed(1)}%, misses ${scanMisses})`,
    classification,
    scores,
    tradeRationale,
    keyRisk,
    stopLoss: stopLoss ?? undefined,
    targetPrice: targetPrice ?? undefined,
  };
}

async function evaluateBuy(
  result: PipelineResult,
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  config: TradingConfig
): Promise<TradeDecision> {
  const ticker = result.ticker;
  const classification = result.classification.classification;
  const scores = result.scores;
  const tradeRationale = (result.classification as any).tradeRationale as string | undefined;
  const keyRisk = (result.classification as any).keyRisk as string | undefined;
  const stopLoss = result.targets.stopLoss;
  const targetPrice = result.targets.average;

  // ── Skip non-actionable classifications ──
  if (classification !== 'runner' && classification !== 'value' && classification !== 'both') {
    return {
      ticker,
      action: 'SKIP',
      reason: `Classification "${classification}" is not actionable`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  // ── Score-based filters ──
  if (scores.fundamentals < config.minFundamentals) {
    return {
      ticker,
      action: 'SKIP',
      reason: `Fundamentals ${scores.fundamentals} < min ${config.minFundamentals}`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  if (scores.risk > config.maxRisk) {
    return {
      ticker,
      action: 'SKIP',
      reason: `Risk ${scores.risk} > max ${config.maxRisk}`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  if (scores.momentum < config.minMomentum) {
    return {
      ticker,
      action: 'SKIP',
      reason: `Momentum ${scores.momentum} < min ${config.minMomentum}`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  // Position sizing by tier
  const tier = result.tier;

  // High conviction: look for lens scores on the classification result
  const classAny = result.classification as any;
  const valueScore = classAny?.valueScore ?? 0;
  const catalystScore = classAny?.catalystScore ?? 0;
  const emergingScore = classAny?.emergingIndustryScore ?? 0;

  const isHighConviction = valueScore >= 7 && catalystScore >= 7 && emergingScore >= 7 && scores.risk < 30;

  let sizePct: number;
  if (isHighConviction) {
    sizePct = 15;
  } else if (tier === 'QUALITY') {
    sizePct = 12.5;
  } else {
    sizePct = 7.5;
  }
  const rawOrderValue = account.portfolioValue * (sizePct / 100);
  // Apply slippage buffer
  const orderValue = rawOrderValue * (1 - config.slippagePct / 100);
  const price = result.price.price;
  const quantity = Math.floor(orderValue / price);

  if (quantity <= 0) {
    return {
      ticker,
      action: 'SKIP',
      reason: `Position size too small (price $${price.toFixed(2)}, budget $${orderValue.toFixed(2)})`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  // ── Risk validation ──
  const actualOrderValue = quantity * price;
  const riskCheck = validateBuy(ticker, actualOrderValue, account, positions, config);

  if (!riskCheck.approved) {
    return {
      ticker,
      action: 'SKIP',
      reason: `Risk check failed: ${riskCheck.reason}`,
      classification,
      scores,
      tradeRationale,
      keyRisk,
    };
  }

  const finalQuantity = riskCheck.adjustedQuantity ?? quantity;

  return {
    ticker,
    action: 'BUY',
    reason: `${classification} (${isHighConviction ? 'high conviction' : 'standard'}) — ` +
      `A:${scores.attention} M:${scores.momentum} F:${scores.fundamentals} R:${scores.risk}`,
    quantity: finalQuantity,
    positionSizePct: sizePct,
    classification,
    scores,
    tradeRationale,
    keyRisk,
    stopLoss,
    targetPrice,
    configSnapshot: config,
  };
}

// ── Execute Decisions ───────────────────────────────────

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

        // Attach the Alpaca order ID for reconciliation
        (decision as any).alpacaOrderId = order.id;
        executed.push(decision);

        console.log(
          `Placed ${decision.action} order for ${decision.ticker}: ` +
          `${decision.quantity} shares (order ${order.id})`
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to place ${decision.action} for ${decision.ticker}: ${errMsg}`);

        // Convert failed BUY -> SKIP, failed SELL -> HOLD
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

// ── Log Decisions ───────────────────────────────────────

export async function logDecisions(
  decisions: TradeDecision[],
  runId: string
): Promise<void> {
  for (const d of decisions) {
    if (d.action === 'BUY' || d.action === 'SELL') {
      // Look up scan_result_id for this run + ticker
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
          (d as any).alpacaOrderId ?? null,
          'pending',
          d.classification,
          null, // confidence — filled during reconciliation
          JSON.stringify(d.scores),
          d.tradeRationale ?? null,
          d.keyRisk ?? null,
          d.positionSizePct ?? null,
          d.stopLoss ?? null,
          d.targetPrice ?? null,
          d.configSnapshot ? JSON.stringify(d.configSnapshot) : null,
        ]
      );
    } else {
      // HOLD / SKIP -> trade_decisions table
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
  console.log(`Logged ${decisions.length} decisions: ${buys} BUY, ${sells} SELL, ${holds} HOLD, ${skips} SKIP`);
}

// ── Update Portfolio State ──────────────────────────────

export async function updatePortfolioState(
  runId: string,
  results: PipelineResult[]
): Promise<void> {
  const positions = await alpaca.getPositions();
  const resultTickers = new Set(results.map((r) => r.ticker));
  const resultMap = new Map<string, PipelineResult>();
  for (const r of results) {
    resultMap.set(r.ticker, r);
  }

  for (const pos of positions) {
    // Look up previous state
    const prevRows = await db.query<{
      consecutive_scan_misses: number;
      entry_date: string | null;
      days_held: number;
      classification_at_entry: string | null;
      stop_loss: number | null;
      target_price: number | null;
    }>(
      `SELECT consecutive_scan_misses, entry_date, days_held, classification_at_entry, stop_loss, target_price
       FROM portfolio_state
       WHERE ticker = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [pos.ticker]
    );

    const prev = prevRows[0] ?? null;
    const inCurrentScan = resultTickers.has(pos.ticker);
    const scanMisses = inCurrentScan ? 0 : (prev?.consecutive_scan_misses ?? 0) + 1;

    // Calculate days held
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

    // Use current analysis targets if available, else carry forward
    const analysis = resultMap.get(pos.ticker);
    const stopLoss = analysis?.targets.stopLoss ?? prev?.stop_loss ?? null;
    const targetPrice = analysis?.targets.average ?? prev?.target_price ?? null;
    const classificationAtEntry = prev?.classification_at_entry ??
      analysis?.classification.classification ?? null;

    await db.query(
      `INSERT INTO portfolio_state (
        id, run_id, ticker, quantity, avg_entry_price, current_price,
        unrealized_pl_pct, entry_date, days_held, classification_at_entry,
        stop_loss, target_price, consecutive_scan_misses, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, NOW()
      )
      ON CONFLICT (run_id, ticker) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        avg_entry_price = EXCLUDED.avg_entry_price,
        current_price = EXCLUDED.current_price,
        unrealized_pl_pct = EXCLUDED.unrealized_pl_pct,
        days_held = EXCLUDED.days_held,
        stop_loss = EXCLUDED.stop_loss,
        target_price = EXCLUDED.target_price,
        consecutive_scan_misses = EXCLUDED.consecutive_scan_misses`,
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
      ]
    );
  }

  console.log(`Updated portfolio state for ${positions.length} positions (run ${runId})`);
}

export default {
  loadTradingConfig,
  reconcilePendingOrders,
  evaluate,
  execute,
  logDecisions,
  updatePortfolioState,
};
