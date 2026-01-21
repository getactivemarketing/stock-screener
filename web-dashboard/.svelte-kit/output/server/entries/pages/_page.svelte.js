import { x as head, y as ensure_array_like, z as attr, F as stringify, G as attr_class, J as clsx, K as bind_props } from "../../chunks/index.js";
import { e as escape_html } from "../../chunks/context.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let data = $$props["data"];
    function formatNumber(num) {
      if (num === null || num === void 0) return "-";
      const n = typeof num === "string" ? parseFloat(num) : num;
      if (isNaN(n)) return "-";
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return n.toFixed(2);
    }
    function formatPercent(num) {
      if (num === null || num === void 0) return "-";
      const n = typeof num === "string" ? parseFloat(num) : num;
      if (isNaN(n)) return "-";
      const sign = n >= 0 ? "+" : "";
      return sign + n.toFixed(2) + "%";
    }
    function getScoreClass(score) {
      if (score >= 70) return "score-high";
      if (score >= 40) return "score-medium";
      return "score-low";
    }
    function getBadgeClass(classification) {
      return `badge badge-${classification || "watch"}`;
    }
    function formatDate(dateStr) {
      return new Date(dateStr).toLocaleString();
    }
    head("1uha8ag", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Stock Screener Dashboard</title>`);
      });
    });
    $$renderer2.push(`<div class="stats-grid"><div class="card stat-card"><div class="stat-value">${escape_html(data.stats.totalTickers)}</div> <div class="stat-label">Tickers Analyzed</div></div> <div class="card stat-card"><div class="stat-value" style="color: var(--purple)">${escape_html(data.stats.runners)}</div> <div class="stat-label">Runners</div></div> <div class="card stat-card"><div class="stat-value" style="color: var(--blue)">${escape_html(data.stats.valuePlays)}</div> <div class="stat-label">Value Plays</div></div> <div class="card stat-card"><div class="stat-value" style="color: var(--yellow)">${escape_html(data.stats.alerts)}</div> <div class="stat-label">Alerts</div></div></div> `);
    if (data.latestRun) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<p style="color: var(--text-muted); margin-bottom: 1rem; font-size: 0.875rem;">Last updated: ${escape_html(formatDate(data.latestRun.run_timestamp))}</p>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <div class="card">`);
    if (data.results.length === 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="empty"><p>No results yet. Run the pipeline to get started.</p></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div class="table-container"><table><thead><tr><th>Ticker</th><th>Price</th><th>Change</th><th>Market Cap</th><th>Attention</th><th>Momentum</th><th>Fundamentals</th><th>Risk</th><th>Class</th></tr></thead><tbody><!--[-->`);
      const each_array = ensure_array_like(data.results);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let result = each_array[$$index];
        $$renderer2.push(`<tr><td><a${attr("href", `/ticker/${stringify(result.ticker)}`)}><strong>${escape_html(result.ticker)}</strong></a> `);
        if (result.company_name) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<br/><span style="color: var(--text-muted); font-size: 0.75rem;">${escape_html(result.company_name)}</span>`);
        } else {
          $$renderer2.push("<!--[!-->");
        }
        $$renderer2.push(`<!--]--></td><td>$${escape_html(formatNumber(result.price))}</td><td${attr_class(clsx(result.price_change_1d_pct >= 0 ? "positive" : "negative"))}>${escape_html(formatPercent(result.price_change_1d_pct))}</td><td>$${escape_html(formatNumber(result.market_cap))}</td><td><span${attr_class(`score ${stringify(getScoreClass(result.attention_score))}`)}>${escape_html(result.attention_score)}</span></td><td><span${attr_class(`score ${stringify(getScoreClass(result.momentum_score))}`)}>${escape_html(result.momentum_score)}</span></td><td><span${attr_class(`score ${stringify(getScoreClass(result.fundamentals_score))}`)}>${escape_html(result.fundamentals_score)}</span></td><td><span${attr_class(`score ${stringify(getScoreClass(100 - result.risk_score))}`)}>${escape_html(result.risk_score)}</span></td><td><span${attr_class(clsx(getBadgeClass(result.classification)))}>${escape_html(result.classification || "watch")}</span></td></tr>`);
      }
      $$renderer2.push(`<!--]--></tbody></table></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { data });
  });
}
export {
  _page as default
};
