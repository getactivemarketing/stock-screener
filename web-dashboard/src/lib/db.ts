import pg from 'pg';
import { DATABASE_URL } from '$env/static/private';

const { Pool } = pg;

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export interface TargetDetails {
  technical: {
    method: string;
    resistance: number;
    support: number;
    high52w: number;
    low52w: number;
    target: number;
    confidence: number;
  };
  fundamental: {
    method: string;
    currentPE: number | null;
    sectorAvgPE: number;
    fairValue: number;
    target: number;
    confidence: number;
  };
  ai: {
    method: string;
    target: number;
    reasoning: string;
    confidence: number;
  };
  risk: {
    method: string;
    entryPrice: number;
    target10pct: number;
    target20pct: number;
    stopLoss: number;
    target: number;
    confidence: number;
  };
}

export interface ScanResult {
  id: number;
  run_id: string;
  run_timestamp: string;
  ticker: string;
  company_name: string;
  price: number;
  price_change_1d_pct: number;
  volume: number;
  relative_volume: number;
  market_cap: number;
  exchange: string;
  sector: string;
  attention_score: number;
  momentum_score: number;
  fundamentals_score: number;
  risk_score: number;
  classification: string;
  confidence: number;
  bull_case: string;
  bear_case: string;
  catalysts: string[];
  alert_triggered: boolean;
  alert_type: string;
  // Target prices
  target_technical: number | null;
  target_fundamental: number | null;
  target_ai: number | null;
  target_risk: number | null;
  target_avg: number | null;
  stop_loss: number | null;
  target_details: TargetDetails | null;
}

export interface ScanRun {
  run_id: string;
  run_timestamp: string;
  tickers_scanned: number;
  alerts_generated: number;
  status: string;
  duration_ms: number;
}
