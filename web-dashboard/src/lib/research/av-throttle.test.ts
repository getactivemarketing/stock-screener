import { describe, it, expect } from 'vitest';
import { isThrottleEnvelope } from './av-throttle';

/**
 * Alpha Vantage's free tier answers HTTP 200 with a notice object once the
 * daily request ceiling is hit, instead of failing. Caching one of those for
 * the day would serve an empty payload to every later section — the sections
 * would render blank with no error to explain why. The day cache must therefore
 * store real data only.
 */
describe('isThrottleEnvelope', () => {
  it('detects the daily rate-limit notice', () => {
    expect(isThrottleEnvelope({
      Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.',
    })).toBe(true);
  });

  it('detects the legacy Note throttle shape', () => {
    expect(isThrottleEnvelope({ Note: 'Please consider optimizing your API call frequency.' })).toBe(true);
  });

  it('detects an error envelope for an unknown symbol', () => {
    expect(isThrottleEnvelope({ 'Error Message': 'Invalid API call.' })).toBe(true);
  });

  it('passes a real statement response through', () => {
    expect(isThrottleEnvelope({ symbol: 'MSFT', annualReports: [{ fiscalDateEnding: '2025-06-30' }] })).toBe(false);
  });

  it('passes a real overview response through', () => {
    expect(isThrottleEnvelope({ Symbol: 'MSFT', MarketCapitalization: '3100000000000' })).toBe(false);
  });

  it('treats null/undefined as not cacheable data', () => {
    expect(isThrottleEnvelope(null)).toBe(false);
    expect(isThrottleEnvelope(undefined)).toBe(false);
  });
});
