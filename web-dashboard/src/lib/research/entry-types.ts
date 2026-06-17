export type PlanStatus = 'draft' | 'staged' | 'cancelled';

/** Inputs to the pure tranche algorithm. */
export interface EntryInput {
  desiredUsd: number;
  currentPrice: number;
  ma8: number | null;
  ma20: number | null;
  ma50: number | null;
  low52w: number | null;
  recentSwingLow: number | null;
  dailyVol: number; // fraction, e.g. 0.03
}

export interface Tranche {
  trancheN: number;       // 1-based
  shares: number;
  limitPrice: number;
  rationale: string;
}

/** Computed indicators shown to the user (and fed into the plan). */
export interface Indicators {
  currentPrice: number;
  ma8: number | null;
  ma20: number | null;
  ma50: number | null;
  ma52w: number | null;     // 52-week (~252d) average
  high52w: number | null;
  low52w: number | null;
  recentSwingLow: number | null;
  dailyVol: number;
  avgVolume30d: number | null;
  latestVolume: number | null;
  relativeVolume: number | null;
  volatilityBand: 'low' | 'medium' | 'high';
}

/** Perplexity-sourced qualitative analysis. */
export interface EntryNarrative {
  volumeTrend: string;
  shortInterest: string;
  holdersAndDrivers: string;
}

/** The full persisted plan payload (entry_plans.plan JSONB). */
export interface EntryPlanPayload {
  ticker: string;
  desiredUsd: number;
  indicators: Indicators;
  narrative: EntryNarrative;
  tranches: Tranche[];
  totalShares: number;
  totalCost: number;
}

export interface EntryOrderRow {
  trancheN: number;
  clientOrderId: string;
  alpacaOrderId: string | null;
  shares: number;
  limitPrice: number;
  status: string;
}
