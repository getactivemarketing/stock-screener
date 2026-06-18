import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
  getCached, putCached,
  buildFinancials, buildMetrics, buildComps, buildOppsRisks, buildGrade,
} from '$lib/research/company-sections';
import type { Section } from '$lib/research/types';

const SECTIONS: Section[] = ['financials', 'metrics', 'comps', 'oppsrisks', 'grade'];

export const GET: RequestHandler = async ({ params, url }) => {
  const ticker = (params.symbol ?? '').toUpperCase();
  const section = url.searchParams.get('section') as Section | null;
  const refresh = url.searchParams.get('refresh') === '1';

  if (!ticker) return json({ error: 'Missing ticker' }, { status: 400 });
  if (!section || !SECTIONS.includes(section)) {
    return json({ error: `section must be one of ${SECTIONS.join(', ')}` }, { status: 400 });
  }

  const avKey = env.ALPHA_VANTAGE_API_KEY;
  const pplxKey = env.PERPLEXITY_API_KEY;
  if (!avKey || !pplxKey) {
    return json({ error: 'Data API keys not configured' }, { status: 503 });
  }

  try {
    if (!refresh) {
      const cached = await getCached(ticker, section);
      if (cached) return json({ ticker, section, cached: true, payload: cached });
    }

    let payload: unknown;
    switch (section) {
      case 'financials': payload = await buildFinancials(ticker, avKey, pplxKey); break;
      case 'metrics':    payload = await buildMetrics(ticker, avKey, pplxKey); break;
      case 'comps':      payload = await buildComps(ticker, avKey, pplxKey); break;
      case 'oppsrisks':  payload = await buildOppsRisks(ticker, pplxKey); break;
      case 'grade':      payload = await buildGrade(ticker, pplxKey); break;
    }

    await putCached(ticker, section, payload);
    return json({ ticker, section, cached: false, payload });
  } catch (err) {
    console.error(`[research/company] ${ticker}/${section} failed:`, err);
    return json({ error: `Failed to build ${section}` }, { status: 500 });
  }
};
