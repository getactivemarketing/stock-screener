// backend/src/services/sectorMedians.ts
/**
 * Static sector median P/E and P/B ratios used for relative valuation scoring.
 * These are reasonable defaults as of 2026. Not real-time — updated manually.
 */

interface SectorMedians {
  pe: number;
  pb: number;
}

const SECTOR_MEDIANS: Record<string, SectorMedians> = {
  'Technology':              { pe: 25, pb: 4.0 },
  'Consumer Discretionary':  { pe: 22, pb: 3.0 },
  'Healthcare':              { pe: 20, pb: 3.5 },
  'Communication Services':  { pe: 20, pb: 3.0 },
  'Industrials':             { pe: 18, pb: 2.5 },
  'Real Estate':             { pe: 20, pb: 2.0 },
  'Consumer Staples':        { pe: 20, pb: 3.5 },
  'Materials':               { pe: 15, pb: 2.0 },
  'Utilities':               { pe: 18, pb: 1.8 },
  'Energy':                  { pe: 10, pb: 1.5 },
  'Financials':              { pe: 12, pb: 1.2 },
  'Financial Services':      { pe: 12, pb: 1.2 },
};

const DEFAULT_MEDIANS: SectorMedians = { pe: 18, pb: 2.5 };

function normalize(sector: string): string {
  return (sector || '').trim();
}

export function getSectorMedianPE(sector: string): number {
  return (SECTOR_MEDIANS[normalize(sector)] ?? DEFAULT_MEDIANS).pe;
}

export function getSectorMedianPB(sector: string): number {
  return (SECTOR_MEDIANS[normalize(sector)] ?? DEFAULT_MEDIANS).pb;
}
