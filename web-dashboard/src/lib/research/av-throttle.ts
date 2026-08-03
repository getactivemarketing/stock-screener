/**
 * Alpha Vantage's free tier answers HTTP 200 with a notice object — rather than
 * an error status — once the daily request ceiling is reached. Caching one of
 * those would serve an empty payload to every later section for the rest of the
 * day, rendering them blank with nothing to explain why.
 *
 * Kept dependency-free so it is unit-testable without dragging in the database
 * and SvelteKit's private-env module, matching how `cagr` and
 * `parseJSONResponse` are separated from their I/O in this codebase.
 */
export function isThrottleEnvelope(payload: any): boolean {
  return Boolean(payload && (payload.Information || payload.Note || payload['Error Message']));
}
