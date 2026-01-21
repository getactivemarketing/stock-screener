import { q as query } from "../../../../chunks/db.js";
import { error } from "@sveltejs/kit";
async function load({ params }) {
  const { symbol } = params;
  const results = await query(`
    SELECT * FROM scan_results
    WHERE ticker = $1
    ORDER BY run_timestamp DESC
    LIMIT 1
  `, [symbol.toUpperCase()]);
  if (results.length === 0) {
    throw error(404, `Ticker ${symbol} not found`);
  }
  const history = await query(`
    SELECT run_timestamp, price, attention_score, momentum_score,
           fundamentals_score, risk_score, classification
    FROM scan_results
    WHERE ticker = $1
    ORDER BY run_timestamp DESC
    LIMIT 20
  `, [symbol.toUpperCase()]);
  return {
    result: results[0],
    history
  };
}
export {
  load
};
