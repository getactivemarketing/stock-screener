export type Section = 'financials' | 'metrics' | 'comps' | 'oppsrisks' | 'grade';

/** One annual period of statement data (numbers in USD, raw). */
export interface AnnualStatement {
  fiscalYear: string;        // e.g. "2024"
  revenue: number | null;
  grossProfit: number | null;
  ebitda: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  // balance sheet
  totalDebt: number | null;
  cash: number | null;
  totalEquity: number | null;
  accountsReceivable: number | null;
  inventory: number | null;
  costOfRevenue: number | null;
  interestExpense: number | null;
}

export interface CompanyOverview {
  marketCap: number | null;
  sharesOutstanding: number | null;
  peRatio: number | null;
  sector: string | null;
  industry: string | null;
  name: string | null;
  price: number | null;
}

// ---- Section payloads (the JSONB stored per section) ----

export interface FinancialsRow {
  label: string;             // "Revenue", "Gross Profit", ...
  values: (number | null)[]; // one per historical year, oldest→newest
  forwardEstimate: number | null;
  cagr: number | null;       // fraction, e.g. 0.18 = 18%
  driverCommentary: string;
}

export interface FinancialsPayload {
  years: string[];           // historical fiscal years, oldest→newest
  forwardYear: string | null;
  rows: FinancialsRow[];
  managementBelievabilityNote: string;
  estimated: boolean;        // true if forward/commentary came from Perplexity
}

export interface MetricRow {
  label: string;             // "Enterprise Value", "Debt/Equity", ...
  value: number | null;
  industryAverage: number | null;
  industryLeader: number | null;
  unit: string;              // "$", "x", "%", ""
  source: 'computed' | 'estimated';
}

export interface MetricsPayload {
  rows: MetricRow[];
}

export interface CompsPeer {
  ticker: string;
  evToRevenue: number | null;
  grossMargin: number | null;     // %
  ebitdaMargin: number | null;    // %
  netMargin: number | null;       // %
}

export interface CompsPayload {
  industry: string | null;
  subject: CompsPeer;             // the analyzed ticker
  peers: CompsPeer[];
}

export interface OppsRisksPayload {
  opportunities: string[];
  risks: string[];
}

export interface GradePayload {
  score: number;             // 0-100
  band: string;              // e.g. "61-80: Clear opportunity"
  rationale: string;
}

export type SectionPayload =
  | FinancialsPayload
  | MetricsPayload
  | CompsPayload
  | OppsRisksPayload
  | GradePayload;
