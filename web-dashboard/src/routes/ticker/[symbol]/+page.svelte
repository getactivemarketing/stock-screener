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

  function getTechnicalSignalClass(signal: string | null): string {
    if (signal === 'bullish') return 'bullish';
    if (signal === 'bearish') return 'bearish';
    return 'neutral';
  }

  function getRsiClass(rsi: number | null): string {
    if (rsi === null) return '';
    if (rsi < 30) return 'oversold';
    if (rsi > 70) return 'overbought';
    return 'neutral';
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

<!-- Technical Indicators -->
{#if result.technical_signal || result.rsi_14}
  <div class="card technicals-card">
    <h3>Technical Indicators</h3>

    <!-- Overall Signal -->
    <div class="tech-signal-banner {getTechnicalSignalClass(result.technical_signal)}">
      <div class="signal-label">Technical Signal</div>
      <div class="signal-value">{result.technical_signal?.toUpperCase() || 'N/A'}</div>
      {#if result.technical_strength !== null}
        <div class="signal-strength">Strength: {result.technical_strength}/100</div>
      {/if}
    </div>

    <div class="technicals-grid">
      <!-- RSI -->
      <div class="tech-indicator">
        <div class="indicator-header">
          <span class="indicator-name">RSI (14)</span>
          <span class="indicator-value {getRsiClass(result.rsi_14)}">{result.rsi_14 ?? '-'}</span>
        </div>
        {#if result.rsi_14 !== null}
          <div class="rsi-gauge">
            <div class="rsi-bar">
              <div class="rsi-marker" style="left: {Math.min(100, Math.max(0, result.rsi_14))}%"></div>
            </div>
            <div class="rsi-labels">
              <span>Oversold</span>
              <span>Neutral</span>
              <span>Overbought</span>
            </div>
          </div>
        {/if}
        <div class="indicator-status">
          {#if result.rsi_14 !== null && result.rsi_14 < 30}
            <span class="status oversold">Oversold - potential buy</span>
          {:else if result.rsi_14 !== null && result.rsi_14 > 70}
            <span class="status overbought">Overbought - potential sell</span>
          {:else}
            <span class="status neutral">Neutral</span>
          {/if}
        </div>
      </div>

      <!-- MACD -->
      <div class="tech-indicator">
        <div class="indicator-header">
          <span class="indicator-name">MACD</span>
          <span class="indicator-value {result.macd_histogram !== null && result.macd_histogram > 0 ? 'bullish' : result.macd_histogram !== null && result.macd_histogram < 0 ? 'bearish' : ''}">
            {result.macd_value !== null ? formatNumber(result.macd_value) : '-'}
          </span>
        </div>
        <div class="macd-details">
          <div class="macd-row">
            <span>Signal:</span>
            <span>{result.macd_signal !== null ? formatNumber(result.macd_signal) : '-'}</span>
          </div>
          <div class="macd-row">
            <span>Histogram:</span>
            <span class={result.macd_histogram !== null && result.macd_histogram > 0 ? 'positive' : 'negative'}>
              {result.macd_histogram !== null ? formatNumber(result.macd_histogram) : '-'}
            </span>
          </div>
        </div>
        <div class="indicator-status">
          {#if result.macd_value !== null && result.macd_signal !== null}
            {#if result.macd_value > result.macd_signal}
              <span class="status bullish">Above signal line - bullish</span>
            {:else}
              <span class="status bearish">Below signal line - bearish</span>
            {/if}
          {:else}
            <span class="status neutral">N/A</span>
          {/if}
        </div>
      </div>

      <!-- Bollinger Bands -->
      <div class="tech-indicator">
        <div class="indicator-header">
          <span class="indicator-name">Bollinger Bands</span>
        </div>
        <div class="bb-details">
          <div class="bb-row">
            <span>Upper:</span>
            <span>${formatPrice(result.bb_upper)}</span>
          </div>
          <div class="bb-row">
            <span>Middle:</span>
            <span>${formatPrice(result.bb_middle)}</span>
          </div>
          <div class="bb-row">
            <span>Lower:</span>
            <span>${formatPrice(result.bb_lower)}</span>
          </div>
        </div>
        <div class="indicator-status">
          {#if result.bb_lower !== null && result.bb_upper !== null}
            {@const price = typeof result.price === 'string' ? parseFloat(result.price) : result.price}
            {@const bbLower = typeof result.bb_lower === 'string' ? parseFloat(result.bb_lower) : result.bb_lower}
            {@const bbUpper = typeof result.bb_upper === 'string' ? parseFloat(result.bb_upper) : result.bb_upper}
            {#if price < bbLower}
              <span class="status oversold">Below lower band - oversold</span>
            {:else if price > bbUpper}
              <span class="status overbought">Above upper band - overbought</span>
            {:else}
              <span class="status neutral">Within bands</span>
            {/if}
          {:else}
            <span class="status neutral">N/A</span>
          {/if}
        </div>
      </div>

      <!-- Moving Averages -->
      <div class="tech-indicator">
        <div class="indicator-header">
          <span class="indicator-name">Moving Averages</span>
        </div>
        <div class="ma-details">
          <div class="ma-row">
            <span>SMA 20:</span>
            <span>${formatPrice(result.sma_20)}</span>
            {#if result.sma_20 !== null}
              {@const price = typeof result.price === 'string' ? parseFloat(result.price) : result.price}
              {@const sma20 = typeof result.sma_20 === 'string' ? parseFloat(result.sma_20) : result.sma_20}
              <span class={price > sma20 ? 'positive' : 'negative'}>
                {price > sma20 ? 'Above' : 'Below'}
              </span>
            {/if}
          </div>
          <div class="ma-row">
            <span>SMA 50:</span>
            <span>${formatPrice(result.sma_50)}</span>
            {#if result.sma_50 !== null}
              {@const price = typeof result.price === 'string' ? parseFloat(result.price) : result.price}
              {@const sma50 = typeof result.sma_50 === 'string' ? parseFloat(result.sma_50) : result.sma_50}
              <span class={price > sma50 ? 'positive' : 'negative'}>
                {price > sma50 ? 'Above' : 'Below'}
              </span>
            {/if}
          </div>
          <div class="ma-row">
            <span>EMA 20:</span>
            <span>${formatPrice(result.ema_20)}</span>
            {#if result.ema_20 !== null}
              {@const price = typeof result.price === 'string' ? parseFloat(result.price) : result.price}
              {@const ema20 = typeof result.ema_20 === 'string' ? parseFloat(result.ema_20) : result.ema_20}
              <span class={price > ema20 ? 'positive' : 'negative'}>
                {price > ema20 ? 'Above' : 'Below'}
              </span>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

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

  /* Technical Indicators */
  .technicals-card {
    margin-bottom: 1.5rem;
  }

  .tech-signal-banner {
    text-align: center;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1.5rem;
  }

  .tech-signal-banner.bullish {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid var(--green);
  }

  .tech-signal-banner.bearish {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid var(--red);
  }

  .tech-signal-banner.neutral {
    background: rgba(234, 179, 8, 0.15);
    border: 1px solid var(--yellow);
  }

  .signal-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.25rem;
  }

  .signal-value {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .tech-signal-banner.bullish .signal-value { color: var(--green); }
  .tech-signal-banner.bearish .signal-value { color: var(--red); }
  .tech-signal-banner.neutral .signal-value { color: var(--yellow); }

  .signal-strength {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .technicals-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  .tech-indicator {
    padding: 1rem;
    background: var(--bg);
    border-radius: 8px;
  }

  .indicator-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .indicator-name {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .indicator-value {
    font-weight: 700;
    font-size: 1.25rem;
  }

  .indicator-value.oversold { color: var(--green); }
  .indicator-value.overbought { color: var(--red); }
  .indicator-value.bullish { color: var(--green); }
  .indicator-value.bearish { color: var(--red); }

  .rsi-gauge {
    margin-bottom: 0.5rem;
  }

  .rsi-bar {
    height: 8px;
    background: linear-gradient(to right, var(--green) 0%, var(--green) 30%, var(--yellow) 30%, var(--yellow) 70%, var(--red) 70%, var(--red) 100%);
    border-radius: 4px;
    position: relative;
  }

  .rsi-marker {
    position: absolute;
    top: -4px;
    width: 4px;
    height: 16px;
    background: white;
    border-radius: 2px;
    transform: translateX(-50%);
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
  }

  .rsi-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .indicator-status {
    margin-top: 0.5rem;
  }

  .indicator-status .status {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    display: inline-block;
  }

  .status.oversold {
    background: rgba(34, 197, 94, 0.2);
    color: var(--green);
  }

  .status.overbought {
    background: rgba(239, 68, 68, 0.2);
    color: var(--red);
  }

  .status.bullish {
    background: rgba(34, 197, 94, 0.2);
    color: var(--green);
  }

  .status.bearish {
    background: rgba(239, 68, 68, 0.2);
    color: var(--red);
  }

  .status.neutral {
    background: rgba(234, 179, 8, 0.2);
    color: var(--yellow);
  }

  .macd-details,
  .bb-details,
  .ma-details {
    margin-bottom: 0.5rem;
  }

  .macd-row,
  .bb-row,
  .ma-row {
    display: flex;
    justify-content: space-between;
    padding: 0.25rem 0;
    font-size: 0.875rem;
  }

  .macd-row span:first-child,
  .bb-row span:first-child,
  .ma-row span:first-child {
    color: var(--text-muted);
  }

  .ma-row {
    gap: 0.5rem;
  }

  .ma-row span:last-child {
    font-size: 0.7rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .ma-row span:last-child.positive {
    background: rgba(34, 197, 94, 0.2);
    color: var(--green);
  }

  .ma-row span:last-child.negative {
    background: rgba(239, 68, 68, 0.2);
    color: var(--red);
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

    .technicals-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
