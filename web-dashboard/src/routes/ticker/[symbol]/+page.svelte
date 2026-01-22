<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  export let data: PageData;

  const { result } = data;

  // Live data state
  let news: any[] = [];
  let insiderTransactions: any[] = [];
  let earnings: any[] = [];
  let recommendations: any = null;
  let shortInterest: any = null;
  let optionsFlow: any = null;
  let loading = true;

  onMount(async () => {
    try {
      const res = await fetch(`/api/ticker/${result.ticker}`);
      if (res.ok) {
        const liveData = await res.json();
        news = liveData.news || [];
        insiderTransactions = liveData.insiderTransactions || [];
        earnings = liveData.earnings || [];
        recommendations = liveData.recommendations;
        shortInterest = liveData.shortInterest;
        optionsFlow = liveData.optionsFlow;
      }
    } catch (e) {
      console.error('Failed to fetch live data:', e);
    }
    loading = false;

    // Load TradingView widget
    loadTradingViewWidget();
  });

  function loadTradingViewWidget() {
    const container = document.getElementById('tradingview-chart');
    if (!container) return;

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: result.ticker,
      interval: 'D',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      enable_publishing: false,
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);
  }

  function formatNumber(num: number | string | null): string {
    if (num === null || num === undefined) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(2);
  }

  function formatPrice(num: number | string | null): string {
    if (num === null || num === undefined) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    return n.toFixed(2);
  }

  function formatPercent(num: number | string | null): string {
    if (num === null || num === undefined) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function getScoreColor(score: number): string {
    if (score >= 70) return 'var(--green)';
    if (score >= 40) return 'var(--yellow)';
    return 'var(--red)';
  }

  function getBadgeClass(classification: string): string {
    return `badge badge-${classification || 'watch'}`;
  }

  function formatDate(dateStr: string | number): string {
    const date = typeof dateStr === 'number' ? new Date(dateStr * 1000) : new Date(dateStr);
    return date.toLocaleDateString();
  }

  function formatDateTime(dateStr: string | number): string {
    const date = typeof dateStr === 'number' ? new Date(dateStr * 1000) : new Date(dateStr);
    return date.toLocaleString();
  }

  function getInsiderAction(code: string): string {
    const actions: Record<string, string> = {
      'P': 'Purchase',
      'S': 'Sale',
      'A': 'Award',
      'M': 'Option Exercise',
    };
    return actions[code] || code;
  }
</script>

<svelte:head>
  <title>{result.ticker} - Stock Screener</title>
</svelte:head>

<a href="/" class="back-link">&larr; Back to Screener</a>

<!-- Header -->
<div class="ticker-header">
  <div class="ticker-name">
    <h1>{result.ticker}</h1>
    <p>{result.company_name || 'Unknown Company'}</p>
    <p class="meta">
      {result.exchange || ''} &bull; {result.sector || 'Unknown Sector'}
    </p>
  </div>
  <div class="price-display">
    <div class="price-current">${formatNumber(result.price)}</div>
    <div class={parseFloat(result.price_change_1d_pct) >= 0 ? 'positive' : 'negative'}>
      {formatPercent(result.price_change_1d_pct)} today
    </div>
  </div>
</div>

<!-- Classification -->
<div class="card classification-card">
  <span class={getBadgeClass(result.classification)}>
    {result.classification?.toUpperCase() || 'WATCH'}
  </span>
  <p class="confidence">Confidence: {((result.confidence || 0.5) * 100).toFixed(0)}%</p>
</div>

<!-- TradingView Chart -->
<div class="card chart-card">
  <h3>Price Chart</h3>
  <div id="tradingview-chart" class="tradingview-widget-container"></div>
</div>

<!-- Scores -->
<div class="scores-grid">
  <div class="card score-card">
    <div class="score-value" style="color: {getScoreColor(result.attention_score)}">
      {result.attention_score}
    </div>
    <div class="score-label">Attention</div>
  </div>
  <div class="card score-card">
    <div class="score-value" style="color: {getScoreColor(result.momentum_score)}">
      {result.momentum_score}
    </div>
    <div class="score-label">Momentum</div>
  </div>
  <div class="card score-card">
    <div class="score-value" style="color: {getScoreColor(result.fundamentals_score)}">
      {result.fundamentals_score}
    </div>
    <div class="score-label">Fundamentals</div>
  </div>
  <div class="card score-card">
    <div class="score-value" style="color: {getScoreColor(100 - result.risk_score)}">
      {result.risk_score}
    </div>
    <div class="score-label">Risk</div>
  </div>
</div>

<!-- Target Prices -->
{#if result.target_avg}
  {@const targetAvg = typeof result.target_avg === 'string' ? parseFloat(result.target_avg) : result.target_avg}
  {@const stopLoss = typeof result.stop_loss === 'string' ? parseFloat(result.stop_loss) : result.stop_loss}
  {@const price = typeof result.price === 'string' ? parseFloat(result.price) : result.price}
  <div class="card targets-card">
    <h3>Price Targets</h3>
    <div class="targets-summary">
      <div class="target-main">
        <div class="target-label">Average Target</div>
        <div class="target-value positive">${formatPrice(targetAvg)}</div>
        <div class="target-upside">
          {#if price && targetAvg}
            {((targetAvg - price) / price * 100).toFixed(1)}% upside
          {/if}
        </div>
      </div>
      <div class="target-stop">
        <div class="target-label">Stop Loss</div>
        <div class="target-value negative">${formatPrice(stopLoss)}</div>
        <div class="target-upside">
          {#if price && stopLoss}
            {((stopLoss - price) / price * 100).toFixed(1)}%
          {/if}
        </div>
      </div>
    </div>

    <div class="targets-breakdown">
      <div class="target-method">
        <div class="method-header">
          <span class="method-name">Technical</span>
          <span class="method-target">${formatPrice(result.target_technical)}</span>
        </div>
        {#if result.target_details?.technical}
          <div class="method-details">
            Support: ${formatPrice(result.target_details.technical.support)} |
            Resistance: ${formatPrice(result.target_details.technical.resistance)}
          </div>
          <div class="method-confidence">
            Confidence: {((result.target_details.technical.confidence || 0) * 100).toFixed(0)}%
          </div>
        {/if}
      </div>

      <div class="target-method">
        <div class="method-header">
          <span class="method-name">Fundamental</span>
          <span class="method-target">${formatPrice(result.target_fundamental)}</span>
        </div>
        {#if result.target_details?.fundamental}
          <div class="method-details">
            Fair Value: ${formatPrice(result.target_details.fundamental.fairValue)} |
            Sector P/E: {result.target_details.fundamental.sectorAvgPE || '-'}
          </div>
          <div class="method-confidence">
            Confidence: {((result.target_details.fundamental.confidence || 0) * 100).toFixed(0)}%
          </div>
        {/if}
      </div>

      <div class="target-method">
        <div class="method-header">
          <span class="method-name">AI Analysis</span>
          <span class="method-target">${formatPrice(result.target_ai)}</span>
        </div>
        {#if result.target_details?.ai}
          <div class="method-details">
            {result.target_details.ai.reasoning || 'No reasoning available'}
          </div>
          <div class="method-confidence">
            Confidence: {((result.target_details.ai.confidence || 0) * 100).toFixed(0)}%
          </div>
        {/if}
      </div>

      <div class="target-method">
        <div class="method-header">
          <span class="method-name">Risk-Based</span>
          <span class="method-target">${formatPrice(result.target_risk)}</span>
        </div>
        {#if result.target_details?.risk}
          <div class="method-details">
            +10%: ${formatPrice(result.target_details.risk.target10pct)} |
            +20%: ${formatPrice(result.target_details.risk.target20pct)}
          </div>
          <div class="method-confidence">
            Confidence: {((result.target_details.risk.confidence || 0) * 100).toFixed(0)}%
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Market Data Row -->
<div class="data-grid">
  <!-- Short Interest -->
  <div class="card">
    <h3>Short Interest</h3>
    {#if loading}
      <p class="loading">Loading...</p>
    {:else if shortInterest}
      <div class="data-row">
        <span>Short Float</span>
        <span class={shortInterest.shortFloat > 20 ? 'warning' : ''}>{shortInterest.shortFloat}%</span>
      </div>
      {#if shortInterest.shortRatio}
        <div class="data-row">
          <span>Days to Cover</span>
          <span>{shortInterest.shortRatio}</span>
        </div>
      {/if}
      {#if shortInterest.shortFloat > 20}
        <p class="squeeze-alert">High short interest - squeeze potential</p>
      {/if}
    {:else}
      <p class="no-data">No data available</p>
    {/if}
  </div>

  <!-- Options Flow -->
  <div class="card">
    <h3>Options Flow</h3>
    {#if loading}
      <p class="loading">Loading...</p>
    {:else if optionsFlow}
      <div class="data-row">
        <span>Call Volume</span>
        <span>{formatNumber(optionsFlow.callVolume)}</span>
      </div>
      <div class="data-row">
        <span>Put Volume</span>
        <span>{formatNumber(optionsFlow.putVolume)}</span>
      </div>
      <div class="data-row">
        <span>Call/Put Ratio</span>
        <span class={optionsFlow.callPutRatio > 2 ? 'bullish' : optionsFlow.callPutRatio < 0.5 ? 'bearish' : ''}>
          {optionsFlow.callPutRatio}
        </span>
      </div>
      {#if optionsFlow.unusualActivity}
        <p class="unusual-alert">Unusual options activity detected</p>
      {/if}
    {:else}
      <p class="no-data">No data available</p>
    {/if}
  </div>

  <!-- Analyst Recommendations -->
  <div class="card">
    <h3>Analyst Ratings</h3>
    {#if loading}
      <p class="loading">Loading...</p>
    {:else if recommendations}
      <div class="ratings-bar">
        <div class="rating strong-buy" style="flex: {recommendations.strongBuy}"></div>
        <div class="rating buy" style="flex: {recommendations.buy}"></div>
        <div class="rating hold" style="flex: {recommendations.hold}"></div>
        <div class="rating sell" style="flex: {recommendations.sell}"></div>
        <div class="rating strong-sell" style="flex: {recommendations.strongSell}"></div>
      </div>
      <div class="ratings-legend">
        <span>Strong Buy: {recommendations.strongBuy}</span>
        <span>Buy: {recommendations.buy}</span>
        <span>Hold: {recommendations.hold}</span>
        <span>Sell: {recommendations.sell}</span>
      </div>
    {:else}
      <p class="no-data">No data available</p>
    {/if}
  </div>
</div>

<!-- Analysis -->
<div class="analysis-grid">
  <div class="card analysis-card">
    <h3 class="bull">Bull Case</h3>
    <p>{result.bull_case || 'No analysis available'}</p>
  </div>
  <div class="card analysis-card">
    <h3 class="bear">Bear Case</h3>
    <p>{result.bear_case || 'No analysis available'}</p>
  </div>
</div>

<!-- Catalysts -->
{#if result.catalysts && result.catalysts.length > 0}
  <div class="card">
    <h3>Key Catalysts</h3>
    <ul class="catalysts-list">
      {#each result.catalysts as catalyst}
        <li>{catalyst}</li>
      {/each}
    </ul>
  </div>
{/if}

<!-- Earnings Calendar -->
{#if !loading && earnings.length > 0}
  <div class="card">
    <h3>Upcoming Earnings</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Quarter</th>
          <th>EPS Est.</th>
          <th>Rev Est.</th>
        </tr>
      </thead>
      <tbody>
        {#each earnings as earning}
          <tr>
            <td>{formatDate(earning.date)}</td>
            <td>Q{earning.quarter} {earning.year}</td>
            <td>${earning.epsEstimate?.toFixed(2) || '-'}</td>
            <td>${formatNumber(earning.revenueEstimate)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<!-- News -->
{#if !loading && news.length > 0}
  <div class="card">
    <h3>Recent News</h3>
    <div class="news-list">
      {#each news as article}
        <a href={article.url} target="_blank" rel="noopener" class="news-item">
          <div class="news-source">{article.source}</div>
          <div class="news-headline">{article.headline}</div>
          <div class="news-date">{formatDateTime(article.datetime)}</div>
        </a>
      {/each}
    </div>
  </div>
{/if}

<!-- Insider Trading -->
{#if !loading && insiderTransactions.length > 0}
  <div class="card">
    <h3>Insider Transactions</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Name</th>
          <th>Action</th>
          <th>Shares</th>
          <th>Price</th>
        </tr>
      </thead>
      <tbody>
        {#each insiderTransactions as tx}
          <tr class={tx.transactionCode === 'P' ? 'insider-buy' : tx.transactionCode === 'S' ? 'insider-sell' : ''}>
            <td>{formatDate(tx.transactionDate)}</td>
            <td>{tx.name}</td>
            <td>{getInsiderAction(tx.transactionCode)}</td>
            <td>{formatNumber(Math.abs(tx.change))}</td>
            <td>${tx.transactionPrice?.toFixed(2) || '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<!-- Key Metrics -->
<div class="card">
  <h3>Key Metrics</h3>
  <table class="metrics-table">
    <tbody>
      <tr>
        <td>Market Cap</td>
        <td>${formatNumber(result.market_cap)}</td>
        <td>P/E Ratio</td>
        <td>{result.pe_ratio || '-'}</td>
      </tr>
      <tr>
        <td>Volume</td>
        <td>{formatNumber(result.volume)}</td>
        <td>P/S Ratio</td>
        <td>{result.ps_ratio || '-'}</td>
      </tr>
      <tr>
        <td>Rel. Volume</td>
        <td>{formatNumber(result.relative_volume)}x</td>
        <td>P/B Ratio</td>
        <td>{result.pb_ratio || '-'}</td>
      </tr>
      <tr>
        <td>52W High</td>
        <td>${formatNumber(result.high_52w)}</td>
        <td>Revenue Growth</td>
        <td>{result.revenue_growth ? result.revenue_growth + '%' : '-'}</td>
      </tr>
      <tr>
        <td>52W Low</td>
        <td>${formatNumber(result.low_52w)}</td>
        <td>Gross Margin</td>
        <td>{result.gross_margin ? result.gross_margin + '%' : '-'}</td>
      </tr>
      <tr>
        <td>Mentions</td>
        <td>{result.total_mentions || '-'}</td>
        <td>Debt/Equity</td>
        <td>{result.debt_equity || '-'}</td>
      </tr>
    </tbody>
  </table>
</div>

<p class="last-updated">Last updated: {formatDateTime(result.run_timestamp)}</p>

<style>
  .back-link {
    display: inline-block;
    margin-bottom: 1rem;
    color: var(--text-muted);
  }

  .back-link:hover {
    color: var(--text);
  }

  .ticker-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }

  .ticker-name h1 {
    font-size: 2rem;
    margin-bottom: 0.25rem;
  }

  .ticker-name p {
    color: var(--text-muted);
  }

  .ticker-name .meta {
    font-size: 0.75rem;
  }

  .price-display {
    text-align: right;
  }

  .price-current {
    font-size: 2rem;
    font-weight: 700;
  }

  .classification-card {
    text-align: center;
    margin-bottom: 1rem;
  }

  .classification-card .badge {
    font-size: 1rem;
    padding: 0.5rem 1rem;
  }

  .confidence {
    color: var(--text-muted);
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .chart-card {
    margin-bottom: 1rem;
  }

  .chart-card h3 {
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .tradingview-widget-container {
    height: 400px;
  }

  .scores-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .score-card {
    text-align: center;
  }

  .score-value {
    font-size: 2rem;
    font-weight: 700;
  }

  .score-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
  }

  .data-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .data-grid h3 {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.75rem;
  }

  .data-row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .data-row:last-child {
    border-bottom: none;
  }

  .warning {
    color: var(--yellow);
    font-weight: 600;
  }

  .bullish {
    color: var(--green);
    font-weight: 600;
  }

  .bearish {
    color: var(--red);
    font-weight: 600;
  }

  .squeeze-alert,
  .unusual-alert {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid var(--yellow);
    border-radius: 4px;
    font-size: 0.75rem;
    color: var(--yellow);
  }

  .ratings-bar {
    display: flex;
    height: 20px;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .rating {
    min-width: 2px;
  }

  .strong-buy { background: #22c55e; }
  .buy { background: #86efac; }
  .hold { background: #eab308; }
  .sell { background: #fca5a5; }
  .strong-sell { background: #ef4444; }

  .ratings-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .analysis-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .analysis-card h3 {
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    text-transform: uppercase;
  }

  .analysis-card h3.bull { color: var(--green); }
  .analysis-card h3.bear { color: var(--red); }

  .catalysts-list {
    padding-left: 1.5rem;
  }

  .catalysts-list li {
    margin-bottom: 0.5rem;
  }

  .news-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .news-item {
    display: block;
    padding: 0.75rem;
    background: var(--bg);
    border-radius: 4px;
    text-decoration: none;
    color: var(--text);
  }

  .news-item:hover {
    background: var(--bg-hover);
  }

  .news-source {
    font-size: 0.75rem;
    color: var(--blue);
    margin-bottom: 0.25rem;
  }

  .news-headline {
    font-weight: 500;
    margin-bottom: 0.25rem;
  }

  .news-date {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .data-table {
    width: 100%;
    font-size: 0.875rem;
  }

  .data-table th {
    text-align: left;
    color: var(--text-muted);
    font-weight: 500;
  }

  .data-table td,
  .data-table th {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .insider-buy {
    background: rgba(34, 197, 94, 0.1);
  }

  .insider-sell {
    background: rgba(239, 68, 68, 0.1);
  }

  .metrics-table {
    width: 100%;
  }

  .metrics-table td {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .metrics-table td:nth-child(odd) {
    color: var(--text-muted);
  }

  .metrics-table td:nth-child(even) {
    text-align: right;
  }

  .loading,
  .no-data {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
  }

  .last-updated {
    color: var(--text-muted);
    margin-top: 1rem;
    font-size: 0.75rem;
  }

  .card h3 {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.75rem;
  }

  /* Target Prices */
  .targets-card {
    margin-bottom: 1.5rem;
  }

  .targets-summary {
    display: flex;
    gap: 2rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .target-main,
  .target-stop {
    text-align: center;
  }

  .target-main {
    flex: 2;
  }

  .target-stop {
    flex: 1;
  }

  .target-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.25rem;
  }

  .target-value {
    font-size: 2rem;
    font-weight: 700;
  }

  .target-value.positive {
    color: var(--green);
  }

  .target-value.negative {
    color: var(--red);
  }

  .target-upside {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .targets-breakdown {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  .target-method {
    padding: 0.75rem;
    background: var(--bg);
    border-radius: 4px;
  }

  .method-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .method-name {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .method-target {
    font-weight: 700;
    color: var(--green);
  }

  .method-details {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
  }

  .method-confidence {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  @media (max-width: 768px) {
    .ticker-header {
      flex-direction: column;
    }

    .price-display {
      text-align: left;
      margin-top: 1rem;
    }

    .scores-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .data-grid {
      grid-template-columns: 1fr;
    }

    .analysis-grid {
      grid-template-columns: 1fr;
    }

    .targets-summary {
      flex-direction: column;
      gap: 1rem;
    }

    .targets-breakdown {
      grid-template-columns: 1fr;
    }
  }
</style>
