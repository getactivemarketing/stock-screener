import { query } from '$lib/db';
import { fetchStatements, fetchOverview } from './statements';
import { cagr, computeMetrics } from './metrics';
import { askPerplexityJSON, JSON_SYSTEM_PROMPT } from './perplexity';
import type {
  Section, FinancialsPayload, FinancialsRow, MetricsPayload,
  CompsPayload, OppsRisksPayload, GradePayload, AnnualStatement, CompanyOverview, SectionPayload,
} from './types';

const FINANCIAL_ROWS: { key: keyof AnnualStatement; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'operatingIncome', label: 'Operating Income' },
  { key: 'netIncome', label: 'Net Income' },
];

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Read a cached section payload for today, or null. */
export async function getCached(ticker: string, section: Section): Promise<SectionPayload | null> {
  const rows = await query<{ payload: SectionPayload }>(
    `SELECT payload FROM company_analysis
     WHERE ticker = $1 AND section = $2 AND analysis_date = $3`,
    [ticker, section, todayUTC()]
  );
  return (rows[0]?.payload as SectionPayload) ?? null;
}

/** Upsert today's section payload. */
export async function putCached(ticker: string, section: Section, payload: unknown): Promise<void> {
  await query(
    `INSERT INTO company_analysis (ticker, section, analysis_date, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticker, section, analysis_date)
     DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
    [ticker, section, todayUTC(), payload]
  );
}

// ---- Section builders ----

/**
 * Snap an LLM-provided figure to the order of magnitude of a known actual.
 * Perplexity often returns revenue in billions/millions (e.g. 281.7) while
 * statement values are raw dollars (281700000000). Multiply by 1000 until the
 * figure is within ~100x of the reference, so units line up regardless.
 */
function normalizeMagnitude(value: number | null, reference: number | null): number | null {
  if (value === null || value === 0 || reference === null || reference <= 0) return value;
  let v = value;
  while (v > 0 && reference / v >= 100) v *= 1000;
  return v;
}

export async function buildFinancials(ticker: string, avKey: string, pplxKey: string): Promise<FinancialsPayload> {
  const statements = await fetchStatements(ticker, avKey);
  const years = statements.map((s) => s.fiscalYear);
  const latestYear = years[years.length - 1];
  const latestRevenue = statements.length ? statements[statements.length - 1].revenue : null;

  // Perplexity: forward estimate + per-row driver commentary + believability note
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker}, the latest actual fiscal year is ${latestYear ?? 'unknown'} (revenue ${latestRevenue ?? 'unknown'} in raw dollars). Return JSON:
{"forwardYear":"<the NEXT fiscal year after ${latestYear ?? 'the latest'}>","forwardRevenue":<consensus/guidance next-FY revenue as a RAW DOLLAR figure, the full number not in millions or billions, or null>,"drivers":{"Revenue":"<one line>","Gross Profit":"...","EBITDA":"...","Operating Income":"...","Net Income":"..."},"managementBelievabilityNote":"<2-3 sentences grading how well aggressive targets are supported by historical trend and market size>"}`
  )) as any;

  const forwardRevenue = normalizeMagnitude(pplx?.forwardRevenue ?? null, latestRevenue);

  const rows: FinancialsRow[] = FINANCIAL_ROWS.map(({ key, label }) => {
    const values = statements.map((s) => s[key] as number | null);
    return {
      label,
      values,
      forwardEstimate: label === 'Revenue' ? forwardRevenue : null,
      cagr: cagr(values),
      driverCommentary: pplx?.drivers?.[label] ?? '',
    };
  });

  return {
    years,
    forwardYear: pplx?.forwardYear ?? null,
    rows,
    managementBelievabilityNote: pplx?.managementBelievabilityNote ?? '',
    estimated: !!pplx,
  };
}

export async function buildMetrics(ticker: string, avKey: string, pplxKey: string): Promise<MetricsPayload> {
  const [statements, overview] = await Promise.all([
    fetchStatements(ticker, avKey),
    fetchOverview(ticker, avKey),
  ]);
  const latest = statements[statements.length - 1];
  const rows = latest ? computeMetrics(latest, overview) : [];

  if (rows.length === 0) {
    return { rows };
  }

  // Perplexity: industry average + leader benchmarks for each metric label
  const labels = rows.map((r) => r.label);
  const bench = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker} (${overview.industry ?? 'its industry'}), give typical industry-average and industry-leader values for these metrics: ${labels.join(', ')}.
Return JSON {"<label>":{"average":<num|null>,"leader":<num|null>}, ...}. Use the same units a financial analyst would (x for ratios, $ for EV/cash).`
  )) as any;

  for (const r of rows) {
    const b = bench?.[r.label];
    if (b) {
      r.industryAverage = typeof b.average === 'number' ? b.average : null;
      r.industryLeader = typeof b.leader === 'number' ? b.leader : null;
    }
  }
  return { rows };
}

export async function buildComps(ticker: string, avKey: string, pplxKey: string): Promise<CompsPayload> {
  const overview = await fetchOverview(ticker, avKey);
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Identify 4-6 public peer companies for ${ticker} in ${overview.industry ?? 'its industry'}.
Return JSON {"industry":"<industry>","subject":{"ticker":"${ticker}","evToRevenue":<num|null>,"grossMargin":<pct|null>,"ebitdaMargin":<pct|null>,"netMargin":<pct|null>},"peers":[{"ticker":"...","evToRevenue":<num|null>,"grossMargin":<pct|null>,"ebitdaMargin":<pct|null>,"netMargin":<pct|null>}]}. Margins as percentages (e.g. 42.5).`
  )) as any;

  return {
    industry: pplx?.industry ?? overview.industry ?? null,
    subject: pplx?.subject ?? { ticker, evToRevenue: null, grossMargin: null, ebitdaMargin: null, netMargin: null },
    peers: Array.isArray(pplx?.peers) ? pplx.peers : [],
  };
}

export async function buildOppsRisks(ticker: string, pplxKey: string): Promise<OppsRisksPayload> {
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Review the last 18 months of ${ticker}'s earnings reports and calls. Summarize, as JSON:
{"opportunities":["...", "..."],"risks":["...", "..."]}. 4-7 concise bullet strings each, focused on management's plans.`
  )) as any;
  return {
    opportunities: Array.isArray(pplx?.opportunities) ? pplx.opportunities : [],
    risks: Array.isArray(pplx?.risks) ? pplx.risks : [],
  };
}

export async function buildGrade(ticker: string, pplxKey: string): Promise<GradePayload> {
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Assign ${ticker} an investment grade 0-100 using EXACTLY this rubric:
0-20 Highly speculative (poor/neutral fundamentals, no price momentum, risk/reward unfavorable);
21-40 Speculative (price OR fundamentals improving, not both; uncertain phase);
41-60 Neutral (sound price+fundamentals+balance sheet, no clear growth story);
61-80 Clear opportunity (growing business, price+industry momentum; younger names need realized metrics/cash flow);
81-100 Buy at any price (profits/growth outpacing price; accumulating even at ATH is risk/reward positive).
Return JSON {"score":<int 0-100>,"band":"<the matching band label>","rationale":"<3-5 sentences>"}.`
  )) as any;
  const score = typeof pplx?.score === 'number' ? Math.max(0, Math.min(100, Math.round(pplx.score))) : 0;
  return {
    score,
    band: pplx?.band ?? 'Unavailable',
    rationale: pplx?.rationale ?? 'Analysis unavailable.',
  };
}
