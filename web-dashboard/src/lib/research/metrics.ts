/**
 * Compound annual growth rate over a series of period values (oldest→newest).
 * Null entries are skipped but their positions still count as periods — the
 * period count is (original series length - 1), not (non-null count - 1).
 * Returns a fraction (0.18 = 18%), or null when undefined (first<=0, <2 points).
 */
export function cagr(series: (number | null)[]): number | null {
  if (series.length < 2) return null;
  // Find first and last non-null values; period count spans the full original series.
  let begin: number | null = null;
  let end: number | null = null;
  for (const v of series) {
    if (v !== null && !Number.isNaN(v)) {
      if (begin === null) begin = v;
      end = v;
    }
  }
  if (begin === null || end === null) return null;
  if (begin <= 0) return null;
  const periods = series.length - 1;
  return Math.pow(end / begin, 1 / periods) - 1;
}
