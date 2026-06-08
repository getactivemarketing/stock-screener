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
import { runVeto } from './veto.js';
import type { VetoContext } from './veto-prompts.js';
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
  ScanTier,
  UnifiedClassification,
  VetoResult,
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
  tier: ScanTier;
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

const STOP_LOSS_PCT = 12; // core position down >= 12% from entry triggers stop
const CATALYST_FADE_DAYS = 2; // days past catalyst date before fade trigger

// Entry gates (core tier)
// Hotfix 2026-05-13: MIN_COMPOSITE 45 → 40; then 40 → 35 on 2026-06-08 (mega-cap
// universe rarely clears 40; 35-39.9 band still net-positive). Keep in lockstep
// with scoring.ts:classifyUnified BUY threshold.
const MIN_COMPOSITE = 35;
const MAX_RISK = 45;
// Lowered 6 → 5 on 2026-05-22 alongside the sector-pass catalyst bonus.
// Sector-rotation candidates rarely earn conviction ≥ 6 from Perplexity even
// with the rationale in context — the AI honestly reports "defensive
// rotation" as a 4-5/10 setup. Dropping to 5 lets borderline sector picks
// through when composite + risk + (BUY recommendation) all clear; the
// catalyst-15 bonus does the heavy lifting on composite.
const MIN_CONVICTION = 5;

// Sizing
const HIGH_CONVICTION_PCT = 14;
const STANDARD_PCT = 10;
const HIGH_CONVICTION_MIN_SCORE = 8;
const HIGH_CONVICTION_MIN_COMPOSITE = 68;
const MIN_NOTIONAL_USD = 100;

// Speculative composite = attention × 0.7 + catalyst × 0.3
function speculativeComposite(scores: ComponentScores): number {
  return scores.attention * 0.7 + scores.catalyst * 0.3;
}

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
  // Veto layer (migration 012)
  vetoRan?: boolean;
  vetoResult?: VetoResult;
  vetoModel?: string;
  vetoLatencyMs?: number;
  vetoFailed?: boolean;
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

  // Fetch tier of each currently-held position so we can enforce tier-specific
  // position limits (e.g., speculative cap counted separately from core).
  const posTiers = await fetchPositionTiers(positions.map((p) => p.ticker));

  // SELL / HOLD evaluation for existing positions
  for (const pos of positions) {
    const result = resultMap.get(pos.ticker) ?? null;
    const posTier = posTiers.get(pos.ticker) ?? 'core';
    const sellDecision = await evaluateSell(pos, result, config, posTier);
    decisions.push(sellDecision);
  }

  // BUY / SKIP for new tickers (not already held)
  for (const result of results) {
    if (heldTickers.has(result.ticker)) continue;
    let decision = result.tier === 'speculative'
      ? evaluateSpeculativeBuy(result, positions, posTiers, account, config)
      : evaluateBuy(result, positions, posTiers, account, config);

    // Veto gate: only runs on BUY-grade candidates, gated by config flag
    if (decision.action === 'BUY' && config.vetoLayerEnabled) {
      decision = await applyVetoGate(decision, result, config);
    }

    decisions.push(decision);
  }

  return decisions;
}

// ── Veto Gate ───────────────────────────────────────────────────
// Called from evaluate() on any BUY candidate when vetoLayerEnabled=true.
// Builds a VetoContext from the candidate data, calls runVeto(), and either
// returns the original BUY decision (confirmed / fail-open) or a SKIP
// decision (blocked by veto when vetoLayerEnforce=true).
// Veto data is always attached to the decision via UnifiedDecisionExtras so
// logDecisions() can persist the 7 veto_* columns regardless of enforce mode.
async function applyVetoGate(
  decision: TradeDecision,
  result: UnifiedPipelineResult,
  config: TradingConfig,
): Promise<TradeDecision> {
  const ticker = result.ticker;

  // Build source breakdown string from sentiment sources (if available via
  // scan_results enrichment — not directly on UnifiedPipelineResult, so null).
  const vetoCtx: VetoContext = {
    ticker,
    tier: result.tier === 'speculative' ? 'speculative' : 'quality',
    price: result.price.price,
    marketCap: result.fundamentals.marketCap ?? null,
    sector: result.fundamentals.sector ?? null,
    // Classifier scores
    composite: result.scores.composite,
    valueScore: result.scores.value,
    catalystScore: result.scores.catalyst,
    upsideScore: result.scores.upside,
    riskScore: result.scores.risk,
    conviction: result.classification.convictionScore,
    category: result.category,
    thesis: result.classification.thesis,
    edgeWhyNow: result.classification.valueCase ?? '',
    expectedReturnPct: result.classification.expectedReturn30d ?? null,
    stopLossPct: null,                        // not on UnifiedPipelineResult
    // Sentiment + price action
    mentionCount: 0,                          // not on UnifiedPipelineResult
    sourceBreakdown: '',                      // not on UnifiedPipelineResult
    change1dPct: result.price.change1dPercent,
    change5dPct: result.price.change5dPercent,
    // Enrichment (not on UnifiedPipelineResult — no TickerAnalysis.enrichment here)
    analystTargetMean: null,                  // not on UnifiedPipelineResult
    daysToEarnings: null,                     // not on UnifiedPipelineResult
    recentNews: [],                           // not on UnifiedPipelineResult
  };

  const t0 = Date.now();
  const vetoCall = await runVeto(vetoCtx);
  const latencyMs = Date.now() - t0;

  const { result: vr, failed, model } = vetoCall;

  console.log(
    `[trader] veto ${ticker}: verdict=${vr.verdict} confidence=${vr.confidence} failed=${failed} latency=${latencyMs}ms`
  );

  // Attach veto metadata to decision extras regardless of enforce mode
  // so logDecisions() can always persist the 7 veto_* columns.
  const extrasWithVeto: UnifiedDecisionExtras = {
    ...(decision as TradeDecision & UnifiedDecisionExtras),
    vetoRan: true,
    vetoResult: vr,
    vetoModel: model,
    vetoLatencyMs: latencyMs,
    vetoFailed: failed,
  };

  // vetoBlocks = enforce enabled AND veto actually ran (not failed) AND verdict != confirm
  const vetoBlocks =
    config.vetoLayerEnforce &&
    !failed &&
    vr.verdict !== 'confirm';

  if (vetoBlocks) {
    console.log(`[trader] BUY BLOCKED by veto: ${ticker} (verdict=${vr.verdict})`);
    return Object.assign(
      {
        ticker,
        action: 'SKIP' as const,
        reason: `BUY blocked by veto: ${vr.verdict} (confidence ${vr.confidence}) — ${vr.reasoning.slice(0, 120)}`,
        classification: decision.classification,
        scores: decision.scores,
        tradeRationale: decision.tradeRationale,
        keyRisk: vr.keyRisk,
        tier: decision.tier,
      },
      extrasWithVeto,
    );
  }

  // Not blocked — return original BUY with veto data attached
  return Object.assign({}, decision, extrasWithVeto);
}

async function fetchPositionTiers(tickers: string[]): Promise<Map<string, ScanTier>> {
  const map = new Map<string, ScanTier>();
  if (tickers.length === 0) return map;
  const rows = await db.query<{ ticker: string; tier: string | null }>(
    `SELECT DISTINCT ON (ticker) ticker, tier
     FROM portfolio_state
     WHERE ticker = ANY($1::text[])
     ORDER BY ticker, created_at DESC`,
    [tickers],
  );
  for (const r of rows) {
    map.set(r.ticker, (r.tier === 'speculative' ? 'speculative' : 'core'));
  }
  return map;
}

async function evaluateSell(
  position: AlpacaPosition,
  result: UnifiedPipelineResult | null,
  config: TradingConfig,
  posTier: ScanTier,
): Promise<TradeDecision> {
  const ticker = position.ticker;
  // Speculative positions: tighter stop, shorter max hold, no catalyst-fade logic
  const stopLossPct = posTier === 'speculative' ? config.speculativeStopLossPct : STOP_LOSS_PCT;

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

  // 1. Stop-loss: down >= stopLossPct from entry (tier-specific)
  if (position.unrealizedPlPct <= -stopLossPct) {
    extras.exitReason = 'stop_loss';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Stop-loss: position down ${position.unrealizedPlPct.toFixed(2)}% (limit -${stopLossPct}%)`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
        tier: posTier,
      },
      extras
    );
  }

  // 2. Max hold exceeded: speculative uses tier-specific cap, core uses category
  const maxHoldDays = posTier === 'speculative'
    ? config.speculativeMaxHoldDays
    : (category ? CATEGORY_MAX_HOLD_DAYS[category] : config.holdDaysMax);
  if (daysHeld >= maxHoldDays) {
    extras.exitReason = 'max_hold';
    return Object.assign(
      {
        ticker,
        action: 'SELL' as const,
        reason: `Max hold exceeded (${daysHeld}d >= ${maxHoldDays}d for ${posTier === 'speculative' ? 'speculative' : category ?? 'unknown'})`,
        quantity: position.quantity,
        classification,
        scores,
        tradeRationale,
        tier: posTier,
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
        tier: posTier,
      },
      extras
    );
  }

  // 4. Catalyst fade — core tier only (speculative doesn't track catalysts)
  if (posTier === 'core' && category === 'earnings_event' && catalystDate) {
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
            tier: posTier,
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
        tier: posTier,
      },
      extras
    );
  }

  // HOLD
  return {
    ticker,
    action: 'HOLD',
    reason: `Holding [${posTier}] (${daysHeld}d, P/L ${position.unrealizedPlPct.toFixed(1)}%, misses ${scanMisses})`,
    classification,
    scores,
    tradeRationale,
    tier: posTier,
  };
}

function evaluateBuy(
  result: UnifiedPipelineResult,
  positions: AlpacaPosition[],
  posTiers: Map<string, ScanTier>,
  account: AlpacaAccount,
  config: TradingConfig
): TradeDecision {
  const ticker = result.ticker;
  const scores = toLegacyScores(result.scores);
  const classification = result.classification.recommendation;
  const tradeRationale = result.classification.thesis;
  const keyRisk = result.classification.keyRisks[0];

  // Core tier only counts core positions against max_positions (speculative
  // positions are tracked separately and don't compete for core slots).
  const corePositions = positions.filter(
    (p) => (posTiers.get(p.ticker) ?? 'core') === 'core',
  );

  const baseDecision = {
    ticker,
    classification,
    scores,
    tradeRationale,
    keyRisk,
    tier: 'core' as ScanTier,
  };

  // Gate: tradeable
  if (!result.tradeable) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Not tradeable: ${result.gateFailures.join(', ') || 'gate failure'}`,
    };
  }

  // LLM recommendation is ADVISORY ONLY (2026-06-03).
  // Previously this hard-gated on `classification === 'BUY'`, which blocked 91%
  // of all candidates: since the universe drifted to mega-caps the LLM rated
  // essentially everything AVOID (NVDA/MSFT/GOOG/AVGO...), and no trade fired
  // after Apr 28. Realized 5d returns showed the score model was the accurate
  // signal — score='buy' returned +8.92%/79% win (and +11.44%/83% at
  // conviction>=5) over the same window. So we now trade on the quantitative
  // classification (tradeable + composite>=MIN_COMPOSITE + risk<=MAX_RISK below,
  // == classifyUnified 'buy') with the LLM's conviction score as the floor. The
  // LLM label is kept on the decision for visibility but no longer blocks.

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
  // Pass only core positions so speculative tier doesn't consume core slots.
  const actualOrderValue = quantity * price;
  const riskCheck = validateBuy(ticker, actualOrderValue, account, corePositions, config);
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

// ── Speculative Buy ──────────────────────────────────────────────
// Loosened entry gates paired with small position sizing and a tight stop.
// Intended for meme/squeeze candidates — see migration 011 for rationale.
function evaluateSpeculativeBuy(
  result: UnifiedPipelineResult,
  positions: AlpacaPosition[],
  posTiers: Map<string, ScanTier>,
  account: AlpacaAccount,
  config: TradingConfig,
): TradeDecision {
  const ticker = result.ticker;
  const scores = toLegacyScores(result.scores);
  const tradeRationale = result.classification.thesis;
  const keyRisk = result.classification.keyRisks[0];

  const specPositions = positions.filter(
    (p) => posTiers.get(p.ticker) === 'speculative',
  );

  const baseDecision = {
    ticker,
    classification: result.classification.recommendation,
    scores,
    tradeRationale,
    keyRisk,
    tier: 'speculative' as ScanTier,
  };

  // Kill switch
  if (!config.speculativeEnabled) {
    return { ...baseDecision, action: 'SKIP', reason: 'Speculative tier disabled' };
  }

  // Must pass speculative tradeability gates
  if (!result.tradeable) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Not tradeable (spec): ${result.gateFailures.join(', ') || 'gate failure'}`,
    };
  }

  // Speculative composite threshold
  const specComp = speculativeComposite(result.scores);
  if (specComp < config.speculativeMinComposite) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Speculative composite ${specComp.toFixed(1)} < ${config.speculativeMinComposite}`,
    };
  }

  // Daily loss limit still applies (shared risk check)
  if (account.dayPlPct <= -config.dailyLossLimitPct) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Daily loss limit hit (${account.dayPlPct.toFixed(2)}% <= -${config.dailyLossLimitPct}%)`,
    };
  }

  // Dedup
  if (positions.some((p) => p.ticker === ticker)) {
    return { ...baseDecision, action: 'SKIP', reason: `Already holding ${ticker}` };
  }

  // Speculative slot cap
  if (specPositions.length >= config.speculativeMaxPositions) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Speculative max positions reached (${specPositions.length}/${config.speculativeMaxPositions})`,
    };
  }

  // Speculative portfolio heat cap (counted separately from core)
  const specExposure = specPositions.reduce((sum, p) => sum + p.marketValue, 0);
  const specHeatPct = (specExposure / account.portfolioValue) * 100;
  const prospectivePct = specHeatPct + config.speculativePositionPct;
  if (prospectivePct > config.speculativePortfolioHeatPct) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Speculative heat would hit ${prospectivePct.toFixed(1)}% > ${config.speculativePortfolioHeatPct}%`,
    };
  }

  // Sizing
  const sizePct = config.speculativePositionPct;
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

  const actualOrderValue = quantity * price;
  if (actualOrderValue > account.buyingPower) {
    return {
      ...baseDecision,
      action: 'SKIP',
      reason: `Insufficient buying power ($${actualOrderValue.toFixed(2)} > $${account.buyingPower.toFixed(2)})`,
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
        `speculative — A:${result.scores.attention.toFixed(0)} C:${result.scores.catalyst.toFixed(0)} ` +
        `SpecComp:${specComp.toFixed(1)} (min ${config.speculativeMinComposite})`,
      quantity,
      positionSizePct: sizePct,
      stopLoss: price * (1 - config.speculativeStopLossPct / 100),
      configSnapshot: config,
    },
    extras,
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
          tier, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          $19, $20, $21,
          $22, $23,
          $24, $25, $26,
          $27, NOW(), NOW()
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
          d.tier ?? 'core',
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
          target_price, config_snapshot, tier, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, $19, NOW(), NOW()
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
          d.tier ?? 'core',
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
      // HOLD / SKIP (includes veto-blocked BUYs which are downgraded to SKIP)
      const vetoExtras = extras as TradeDecision & UnifiedDecisionExtras;
      const hasVeto = vetoExtras.vetoRan === true && vetoExtras.vetoResult != null;
      if (hasVeto) {
        const vr = vetoExtras.vetoResult!;
        await db.query(
          `INSERT INTO trade_decisions (
            id, run_id, ticker, action, reason, classification, scores,
            veto_verdict, veto_confidence, veto_reasoning, veto_key_risk,
            veto_contradictions, veto_model, veto_latency_ms,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
          [
            uuidv4(),
            runId,
            d.ticker,
            d.action,
            d.reason,
            d.classification,
            JSON.stringify(d.scores),
            vr.verdict,
            vr.confidence,
            vr.reasoning,
            vr.keyRisk,
            JSON.stringify(vr.thesisContradictions),
            vetoExtras.vetoModel ?? null,
            vetoExtras.vetoLatencyMs ?? null,
          ]
        );
      } else {
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

    // For BUY decisions that had veto run (non-blocked), also persist veto
    // data to trade_decisions so both confirmed and blocked verdicts land in
    // the same table for cohort analysis (the plan's measurement query).
    if (d.action === 'BUY') {
      const vetoExtras = extras as TradeDecision & UnifiedDecisionExtras;
      if (vetoExtras.vetoRan === true && vetoExtras.vetoResult != null) {
        const vr = vetoExtras.vetoResult;
        await db.query(
          `INSERT INTO trade_decisions (
            id, run_id, ticker, action, reason, classification, scores,
            veto_verdict, veto_confidence, veto_reasoning, veto_key_risk,
            veto_contradictions, veto_model, veto_latency_ms,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
          [
            uuidv4(),
            runId,
            d.ticker,
            'SKIP',  // closest allowed action value; veto_verdict='confirm' distinguishes it
            `veto shadow log: verdict=${vr.verdict} (order placed)`,
            d.classification,
            JSON.stringify(d.scores),
            vr.verdict,
            vr.confidence,
            vr.reasoning,
            vr.keyRisk,
            JSON.stringify(vr.thesisContradictions),
            vetoExtras.vetoModel ?? null,
            vetoExtras.vetoLatencyMs ?? null,
          ]
        );
      }
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
      tier: string | null;
    }>(
      `SELECT consecutive_scan_misses, entry_date, days_held,
              classification_at_entry, stop_loss, target_price,
              entry_category, entry_catalyst_date, tier
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
    // Tier persists from the prior state if known; otherwise use the current
    // scan's tier (in case this is the first row after a fill). Default core.
    const tier: ScanTier =
      prev?.tier === 'speculative' ? 'speculative'
      : prev?.tier === 'core' ? 'core'
      : (result?.tier ?? 'core');

    await db.query(
      `INSERT INTO portfolio_state (
        id, run_id, ticker, quantity, avg_entry_price, current_price,
        unrealized_pl_pct, entry_date, days_held, classification_at_entry,
        stop_loss, target_price, consecutive_scan_misses,
        entry_category, entry_catalyst_date, tier, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, NOW()
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
        entry_catalyst_date = EXCLUDED.entry_catalyst_date,
        tier = EXCLUDED.tier`,
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
        tier,
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
