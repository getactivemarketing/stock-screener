// backend/src/scripts/verify-yahoo.ts
import { fetchQuoteSummary } from '../services/yahoo.js';

(async () => {
  const tickers = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'F'];
  for (const t of tickers) {
    const result = await fetchQuoteSummary(t);
    console.log(t, '→', result ? {
      target: result.targetMeanPrice,
      analysts: result.numberOfAnalystOpinions,
      pe: result.trailingPE,
      pb: result.priceToBook,
    } : 'null');
    console.assert(result !== null, `${t} should return data`);
    console.assert(result && result.numberOfAnalystOpinions > 0, `${t} should have analyst coverage`);
  }
  console.log('verify-yahoo: OK');
})();
