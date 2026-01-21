import { x as head, G as attr_class, N as attr_style, J as clsx, F as stringify, y as ensure_array_like, K as bind_props } from "../../../../chunks/index.js";
import { e as escape_html } from "../../../../chunks/context.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let data = $$props["data"];
    const { result } = data;
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
    function getScoreColor(score) {
      if (score >= 70) return "var(--green)";
      if (score >= 40) return "var(--yellow)";
      return "var(--red)";
    }
    function getBadgeClass(classification) {
      return `badge badge-${classification || "watch"}`;
    }
    function formatDate(dateStr) {
      return new Date(dateStr).toLocaleString();
    }
    head("gj8y0c", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>${escape_html(result.ticker)} - Stock Screener</title>`);
      });
    });
    $$renderer2.push(`<a href="/" style="display: inline-block; margin-bottom: 1rem;">← Back to Screener</a> <div class="ticker-header"><div class="ticker-name"><h1>${escape_html(result.ticker)}</h1> <p>${escape_html(result.company_name || "Unknown Company")}</p> <p style="font-size: 0.75rem;">${escape_html(result.exchange || "")} • ${escape_html(result.sector || "Unknown Sector")}</p></div> <div class="price-display"><div class="price-current">$${escape_html(formatNumber(result.price))}</div> <div${attr_class(clsx(result.price_change_1d_pct >= 0 ? "positive" : "negative"))}>${escape_html(formatPercent(result.price_change_1d_pct))} today</div></div></div> <div class="card" style="margin-bottom: 1rem; text-align: center;"><span${attr_class(clsx(getBadgeClass(result.classification)))} style="font-size: 1rem; padding: 0.5rem 1rem;">${escape_html(result.classification?.toUpperCase() || "WATCH")}</span> <p style="color: var(--text-muted); margin-top: 0.5rem; font-size: 0.875rem;">Confidence: ${escape_html(((result.confidence || 0.5) * 100).toFixed(0))}%</p></div> <div class="scores-grid"><div class="card score-card"><div class="score-value"${attr_style(`color: ${stringify(getScoreColor(result.attention_score))}`)}>${escape_html(result.attention_score)}</div> <div class="score-label">Attention</div></div> <div class="card score-card"><div class="score-value"${attr_style(`color: ${stringify(getScoreColor(result.momentum_score))}`)}>${escape_html(result.momentum_score)}</div> <div class="score-label">Momentum</div></div> <div class="card score-card"><div class="score-value"${attr_style(`color: ${stringify(getScoreColor(result.fundamentals_score))}`)}>${escape_html(result.fundamentals_score)}</div> <div class="score-label">Fundamentals</div></div> <div class="card score-card"><div class="score-value"${attr_style(`color: ${stringify(getScoreColor(100 - result.risk_score))}`)}>${escape_html(result.risk_score)}</div> <div class="score-label">Risk</div></div></div> <div class="analysis-grid" style="margin-bottom: 1.5rem;"><div class="card analysis-card"><h3 style="color: var(--green);">Bull Case</h3> <p>${escape_html(result.bull_case || "No analysis available")}</p></div> <div class="card analysis-card"><h3 style="color: var(--red);">Bear Case</h3> <p>${escape_html(result.bear_case || "No analysis available")}</p></div></div> `);
    if (result.catalysts && result.catalysts.length > 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="card" style="margin-bottom: 1.5rem;"><h3 style="margin-bottom: 0.5rem; font-size: 0.875rem; color: var(--text-muted); text-transform: uppercase;">Key Catalysts</h3> <ul style="padding-left: 1.5rem;"><!--[-->`);
      const each_array = ensure_array_like(result.catalysts);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let catalyst = each_array[$$index];
        $$renderer2.push(`<li>${escape_html(catalyst)}</li>`);
      }
      $$renderer2.push(`<!--]--></ul></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <div class="card"><h3 style="margin-bottom: 1rem; font-size: 0.875rem; color: var(--text-muted); text-transform: uppercase;">Key Metrics</h3> <table><tbody><tr><td style="color: var(--text-muted);">Market Cap</td><td style="text-align: right;">$${escape_html(formatNumber(result.market_cap))}</td></tr><tr><td style="color: var(--text-muted);">Volume</td><td style="text-align: right;">${escape_html(formatNumber(result.volume))}</td></tr><tr><td style="color: var(--text-muted);">Relative Volume</td><td style="text-align: right;">${escape_html(formatNumber(result.relative_volume))}x</td></tr><tr><td style="color: var(--text-muted);">Total Mentions</td><td style="text-align: right;">${escape_html(result.total_mentions || "-")}</td></tr></tbody></table></div> <p style="color: var(--text-muted); margin-top: 1rem; font-size: 0.75rem;">Last updated: ${escape_html(formatDate(result.run_timestamp))}</p>`);
    bind_props($$props, { data });
  });
}
export {
  _page as default
};
