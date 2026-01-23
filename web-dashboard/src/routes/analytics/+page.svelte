<script lang="ts">
  import { onMount } from 'svelte';

  let summary: any = null;
  let winRate: any = null;
  let sectors: any[] = [];
  let history: any[] = [];
  let performance: any[] = [];
  let technicalAccuracy: any[] = [];
  let targetAccuracy: any = null;
  let backtestData: any = null;
  let loading = true;
  let activeTab = 'overview';

  // Backtest filters
  let backtestClassification = '';
  let backtestMinAttention = '';
  let backtestLoading = false;

  onMount(async () => {
    await Promise.all([
      fetchSummary(),
      fetchWinRate(),
      fetchSectors(),
      fetchHistory(),
      fetchPerformance(),
      fetchTechnicalAccuracy(),
      fetchTargetAccuracy(),
    ]);
    loading = false;
  });

  async function fetchSummary() {
    try {
      const res = await fetch('/api/analytics?type=summary');
      if (res.ok) summary = await res.json();
    } catch (e) {
      console.error('Failed to fetch summary:', e);
    }
  }

  async function fetchWinRate() {
    try {
      const res = await fetch('/api/analytics?type=winrate');
      if (res.ok) winRate = await res.json();
    } catch (e) {
      console.error('Failed to fetch win rate:', e);
    }
  }

  async function fetchSectors() {
    try {
      const res = await fetch('/api/analytics?type=sectors');
      if (res.ok) sectors = await res.json();
    } catch (e) {
      console.error('Failed to fetch sectors:', e);
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch('/api/analytics?type=history');
      if (res.ok) history = await res.json();
    } catch (e) {
      console.error('Failed to fetch history:', e);
    }
  }

  async function fetchPerformance() {
    try {
      const res = await fetch('/api/analytics?type=performance');
      if (res.ok) performance = await res.json();
    } catch (e) {
      console.error('Failed to fetch performance:', e);
    }
  }

  async function fetchTechnicalAccuracy() {
    try {
      const res = await fetch('/api/analytics?type=technical');
      if (res.ok) technicalAccuracy = await res.json();
    } catch (e) {
      console.error('Failed to fetch technical accuracy:', e);
    }
  }

  async function fetchTargetAccuracy() {
    try {
      const res = await fetch('/api/analytics?type=targets');
      if (res.ok) targetAccuracy = await res.json();
    } catch (e) {
      console.error('Failed to fetch target accuracy:', e);
    }
  }

  async function fetchBacktestResults() {
    backtestLoading = true;
    try {
      const params = new URLSearchParams({ type: 'backtest' });
      if (backtestClassification) params.append('classification', backtestClassification);
      if (backtestMinAttention) params.append('minAttention', backtestMinAttention);

      const res = await fetch(`/api/analytics?${params}`);
      if (res.ok) backtestData = await res.json();
    } catch (e) {
      console.error('Failed to fetch backtest:', e);
    }
    backtestLoading = false;
  }

  function formatPercent(num: number | null): string {
    if (num === null || num === undefined) return '-';
    const sign = num >= 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString();
  }

  function calculateWinRate(wins: number, total: number): string {
    if (!total) return '-';
    return ((wins / total) * 100).toFixed(1) + '%';
  }

  function getSignalColor(signal: string): string {
    if (signal === 'bullish') return 'positive';
    if (signal === 'bearish') return 'negative';
    return '';
  }
</script>

<svelte:head>
  <title>Analytics - Stock Screener</title>
</svelte:head>

<h2>Analytics Dashboard</h2>

<!-- Tabs -->
<div class="tabs">
  <button class:active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
  <button class:active={activeTab === 'winrate'} on:click={() => activeTab = 'winrate'}>Win Rates</button>
  <button class:active={activeTab === 'sectors'} on:click={() => activeTab = 'sectors'}>Sectors</button>
  <button class:active={activeTab === 'technical'} on:click={() => activeTab = 'technical'}>Technical Signals</button>
  <button class:active={activeTab === 'targets'} on:click={() => activeTab = 'targets'}>Target Accuracy</button>
  <button class:active={activeTab === 'backtest'} on:click={() => activeTab = 'backtest'}>Backtest</button>
</div>

{#if loading}
  <div class="loading-container">
    <p>Loading analytics...</p>
  </div>
{:else}
  <!-- Overview Tab -->
  {#if activeTab === 'overview'}
    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-value">{summary?.totalRuns || 0}</div>
        <div class="stat-label">Total Runs</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{summary?.uniqueTickers || 0}</div>
        <div class="stat-label">Unique Tickers</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{summary?.totalScanned || 0}</div>
        <div class="stat-label">Total Scans</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{summary?.totalAlerts || 0}</div>
        <div class="stat-label">Alerts Generated</div>
      </div>
    </div>

    <!-- Classification Breakdown -->
    <div class="card">
      <h3>Classification Breakdown</h3>
      {#if summary?.classificationBreakdown}
        <div class="breakdown-grid">
          {#each summary.classificationBreakdown as item}
            <div class="breakdown-item">
              <span class="badge badge-{item.classification}">{item.classification}</span>
              <span class="count">{item.count}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="no-data">No data available</p>
      {/if}
    </div>

    <!-- Daily History -->
    <div class="card">
      <h3>Daily Classification History</h3>
      {#if history.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Total</th>
              <th>Runners</th>
              <th>Value</th>
              <th>Both</th>
              <th>Avoid</th>
              <th>Watch</th>
            </tr>
          </thead>
          <tbody>
            {#each history.slice(0, 10) as day}
              <tr>
                <td>{formatDate(day.date)}</td>
                <td>{day.total_tickers}</td>
                <td class="runners">{day.runners}</td>
                <td class="value">{day.value_plays}</td>
                <td>{day.both}</td>
                <td class="avoid">{day.avoid}</td>
                <td>{day.watch}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-data">No history data available yet</p>
      {/if}
    </div>
  {/if}

  <!-- Win Rates Tab -->
  {#if activeTab === 'winrate'}
    <div class="card">
      <h3>Win Rate by Classification</h3>
      <p class="note">Win rate = % of picks that had positive returns. Requires return data to be populated.</p>

      {#if winRate?.byClassification?.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Classification</th>
              <th>Total Picks</th>
              <th>Win Rate (1D)</th>
              <th>Win Rate (5D)</th>
              <th>Hit 5%+</th>
              <th>Hit 10%+</th>
              <th>Hit 20%+</th>
              <th>Avg Return (5D)</th>
            </tr>
          </thead>
          <tbody>
            {#each winRate.byClassification as row}
              <tr>
                <td><span class="badge badge-{row.classification}">{row.classification}</span></td>
                <td>{row.total_picks}</td>
                <td>{calculateWinRate(row.wins_1d, row.total_picks)}</td>
                <td>{calculateWinRate(row.wins_5d, row.total_picks)}</td>
                <td>{calculateWinRate(row.hits_5pct, row.total_picks)}</td>
                <td>{calculateWinRate(row.hits_10pct, row.total_picks)}</td>
                <td>{calculateWinRate(row.hits_20pct, row.total_picks)}</td>
                <td class={parseFloat(row.avg_return_5d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(row.avg_return_5d)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div class="empty-state">
          <p>No return data available yet.</p>
          <p class="hint">Return data is populated after picks have had time to play out (1-5 days). Run the return tracker to populate historical returns.</p>
        </div>
      {/if}
    </div>

    <!-- Performance Metrics -->
    <div class="card">
      <h3>Performance Metrics</h3>
      <div class="metrics-grid">
        <div class="metric">
          <span class="metric-label">Total Picks with Returns</span>
          <span class="metric-value">{winRate?.overall?.total_with_returns || 0}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Overall Avg Return (5D)</span>
          <span class="metric-value {parseFloat(winRate?.overall?.overall_avg_return) >= 0 ? 'positive' : 'negative'}">
            {formatPercent(winRate?.overall?.overall_avg_return)}
          </span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Sectors Tab -->
  {#if activeTab === 'sectors'}
    <div class="card">
      <h3>Sector Performance</h3>
      <p class="note">Sectors ranked by average scores and returns</p>

      {#if sectors.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Sector</th>
              <th>Tickers</th>
              <th>Runners</th>
              <th>Value</th>
              <th>Avg Attention</th>
              <th>Avg Momentum</th>
              <th>Avg Fundamentals</th>
              <th>Avg Return (5D)</th>
            </tr>
          </thead>
          <tbody>
            {#each sectors as sector}
              <tr>
                <td><strong>{sector.sector}</strong></td>
                <td>{sector.ticker_count}</td>
                <td class="runners">{sector.runners}</td>
                <td class="value">{sector.value_plays}</td>
                <td>{sector.avg_attention?.toFixed(0) || '-'}</td>
                <td>{sector.avg_momentum?.toFixed(0) || '-'}</td>
                <td>{sector.avg_fundamentals?.toFixed(0) || '-'}</td>
                <td class={parseFloat(sector.avg_return_5d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(sector.avg_return_5d)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-data">No sector data available</p>
      {/if}
    </div>
  {/if}

  <!-- Technical Signals Tab -->
  {#if activeTab === 'technical'}
    <div class="card">
      <h3>Technical Signal Accuracy</h3>
      <p class="note">Performance of picks by technical signal (bullish/bearish/neutral)</p>

      {#if technicalAccuracy && technicalAccuracy.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Signal</th>
              <th>Total Picks</th>
              <th>Win Rate (1D)</th>
              <th>Win Rate (5D)</th>
              <th>Avg Return (1D)</th>
              <th>Avg Return (5D)</th>
              <th>Avg Max Gain</th>
              <th>Avg Max DD</th>
            </tr>
          </thead>
          <tbody>
            {#each technicalAccuracy as row}
              <tr>
                <td>
                  <span class="signal-badge {getSignalColor(row.technical_signal)}">
                    {row.technical_signal || 'unknown'}
                  </span>
                </td>
                <td>{row.total}</td>
                <td>{calculateWinRate(row.wins_1d, row.total)}</td>
                <td>{calculateWinRate(row.wins_5d, row.total)}</td>
                <td class={parseFloat(row.avg_return_1d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(row.avg_return_1d)}
                </td>
                <td class={parseFloat(row.avg_return_5d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(row.avg_return_5d)}
                </td>
                <td class="positive">{formatPercent(row.avg_max_gain)}</td>
                <td class="negative">{formatPercent(row.avg_max_drawdown)}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <div class="insight-box">
          <h4>Insights</h4>
          {#if technicalAccuracy.length >= 2}
            {@const bullish = technicalAccuracy.find(t => t.technical_signal === 'bullish')}
            {@const bearish = technicalAccuracy.find(t => t.technical_signal === 'bearish')}
            {#if bullish && bearish}
              <p>
                Bullish signals have a {calculateWinRate(bullish.wins_5d, bullish.total)} win rate vs
                {calculateWinRate(bearish.wins_5d, bearish.total)} for bearish signals over 5 days.
              </p>
            {/if}
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          <p>No technical signal data available yet.</p>
          <p class="hint">Technical signal accuracy requires return data to be populated after picks have had time to play out.</p>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Target Accuracy Tab -->
  {#if activeTab === 'targets'}
    <div class="card">
      <h3>Target Price Accuracy</h3>
      <p class="note">How often do picks hit their target prices within 5 days?</p>

      {#if targetAccuracy?.overall}
        <div class="target-stats-grid">
          <div class="stat-card">
            <div class="stat-value">{targetAccuracy.overall.total || 0}</div>
            <div class="stat-label">Picks with Targets</div>
          </div>
          <div class="stat-card">
            <div class="stat-value highlight-green">{targetAccuracy.overall.hit_target || 0}</div>
            <div class="stat-label">Hit Target</div>
          </div>
          <div class="stat-card">
            <div class="stat-value highlight-red">{targetAccuracy.overall.hit_stop || 0}</div>
            <div class="stat-label">Hit Stop Loss</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">
              {targetAccuracy.overall.total > 0
                ? ((targetAccuracy.overall.hit_target / targetAccuracy.overall.total) * 100).toFixed(1)
                : 0}%
            </div>
            <div class="stat-label">Target Hit Rate</div>
          </div>
        </div>

        <div class="metrics-row">
          <div class="metric">
            <span class="metric-label">Avg Target %</span>
            <span class="metric-value">{formatPercent(targetAccuracy.overall.avg_target_pct)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Avg Return (w/ Target)</span>
            <span class="metric-value {parseFloat(targetAccuracy.overall.avg_return_with_target) >= 0 ? 'positive' : 'negative'}">
              {formatPercent(targetAccuracy.overall.avg_return_with_target)}
            </span>
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <p>No target accuracy data available yet.</p>
        </div>
      {/if}
    </div>

    <!-- Target Accuracy by Classification -->
    <div class="card">
      <h3>Target Accuracy by Classification</h3>

      {#if targetAccuracy?.byClassification?.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Classification</th>
              <th>Total</th>
              <th>Hit Target</th>
              <th>Hit Rate</th>
              <th>Avg Return</th>
            </tr>
          </thead>
          <tbody>
            {#each targetAccuracy.byClassification as row}
              <tr>
                <td><span class="badge badge-{row.classification}">{row.classification}</span></td>
                <td>{row.total}</td>
                <td>{row.hit_target}</td>
                <td>{calculateWinRate(row.hit_target, row.total)}</td>
                <td class={parseFloat(row.avg_return) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(row.avg_return)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-data">No classification breakdown available</p>
      {/if}
    </div>
  {/if}

  <!-- Backtest Tab -->
  {#if activeTab === 'backtest'}
    <!-- Backtest Filters -->
    <div class="card filter-card">
      <h3>Filter Results</h3>
      <div class="filter-row">
        <div class="filter-group">
          <label for="bt-class">Classification</label>
          <select id="bt-class" bind:value={backtestClassification}>
            <option value="">All</option>
            <option value="runner">Runner</option>
            <option value="value">Value</option>
            <option value="both">Both</option>
            <option value="watch">Watch</option>
            <option value="avoid">Avoid</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="bt-attention">Min Attention</label>
          <select id="bt-attention" bind:value={backtestMinAttention}>
            <option value="">Any</option>
            <option value="50">50+</option>
            <option value="60">60+</option>
            <option value="70">70+</option>
            <option value="80">80+</option>
            <option value="90">90+</option>
          </select>
        </div>
        <button class="btn btn-primary" on:click={fetchBacktestResults} disabled={backtestLoading}>
          {backtestLoading ? 'Loading...' : 'Run Backtest'}
        </button>
      </div>
    </div>

    <!-- Backtest Summary -->
    {#if backtestData?.summary}
      <div class="card">
        <h3>Backtest Summary</h3>
        <div class="backtest-stats-grid">
          <div class="stat-card">
            <div class="stat-value">{backtestData.summary.total}</div>
            <div class="stat-label">Total Picks</div>
          </div>
          <div class="stat-card">
            <div class="stat-value highlight-green">{backtestData.summary.hitTarget}</div>
            <div class="stat-label">Hit Target</div>
          </div>
          <div class="stat-card">
            <div class="stat-value highlight-red">{backtestData.summary.hitStopLoss}</div>
            <div class="stat-label">Hit Stop Loss</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{backtestData.summary.targetHitRate.toFixed(1)}%</div>
            <div class="stat-label">Target Hit Rate</div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Backtest Results Table -->
    <div class="card">
      <h3>Historical Picks Performance</h3>
      <p class="note">Track how past classifications performed. Click "Run Backtest" to filter results.</p>

      {#if backtestData?.results?.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Class</th>
              <th>Entry</th>
              <th>Target</th>
              <th>Stop</th>
              <th>Signal</th>
              <th>Return 1D</th>
              <th>Return 5D</th>
              <th>Max Gain</th>
              <th>Max DD</th>
            </tr>
          </thead>
          <tbody>
            {#each backtestData.results as pick}
              <tr>
                <td>{formatDate(pick.run_timestamp)}</td>
                <td><a href="/ticker/{pick.ticker}"><strong>{pick.ticker}</strong></a></td>
                <td><span class="badge badge-{pick.classification}">{pick.classification}</span></td>
                <td>${parseFloat(pick.price)?.toFixed(2) || '-'}</td>
                <td>{pick.target_avg ? '$' + parseFloat(pick.target_avg).toFixed(2) : '-'}</td>
                <td>{pick.stop_loss ? '$' + parseFloat(pick.stop_loss).toFixed(2) : '-'}</td>
                <td>
                  {#if pick.technical_signal}
                    <span class="signal-badge {getSignalColor(pick.technical_signal)}">{pick.technical_signal}</span>
                  {:else}
                    -
                  {/if}
                </td>
                <td class={parseFloat(pick.return_1d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(pick.return_1d)}
                </td>
                <td class={parseFloat(pick.return_5d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(pick.return_5d)}
                </td>
                <td class="positive">{formatPercent(pick.max_gain_5d)}</td>
                <td class="negative">{formatPercent(pick.max_drawdown_5d)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else if performance.length > 0}
        <!-- Fallback to simple performance data if backtest not run -->
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Class</th>
              <th>Entry Price</th>
              <th>Attention</th>
              <th>Momentum</th>
              <th>Return 1D</th>
              <th>Return 5D</th>
              <th>Max Gain</th>
              <th>Max DD</th>
            </tr>
          </thead>
          <tbody>
            {#each performance as pick}
              <tr>
                <td>{formatDate(pick.run_timestamp)}</td>
                <td><a href="/ticker/{pick.ticker}"><strong>{pick.ticker}</strong></a></td>
                <td><span class="badge badge-{pick.classification}">{pick.classification}</span></td>
                <td>${parseFloat(pick.entry_price)?.toFixed(2) || '-'}</td>
                <td>{pick.attention_score}</td>
                <td>{pick.momentum_score}</td>
                <td class={parseFloat(pick.return_1d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(pick.return_1d)}
                </td>
                <td class={parseFloat(pick.return_5d) >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(pick.return_5d)}
                </td>
                <td class="positive">{formatPercent(pick.max_gain_5d)}</td>
                <td class="negative">{formatPercent(pick.max_drawdown_5d)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div class="empty-state">
          <p>No backtest data available yet.</p>
          <p class="hint">Return data needs to be populated by running the return tracker after picks have had time to play out.</p>
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  h2 {
    margin-bottom: 1rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }

  .tabs button {
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.875rem;
    border-radius: 4px 4px 0 0;
  }

  .tabs button:hover {
    color: var(--text);
  }

  .tabs button.active {
    color: var(--text);
    background: var(--bg-card);
    border-bottom: 2px solid var(--blue);
  }

  .loading-container {
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat-card {
    text-align: center;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 700;
  }

  .stat-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
  }

  .card {
    margin-bottom: 1.5rem;
  }

  .card h3 {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.75rem;
  }

  .note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 1rem;
  }

  .breakdown-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .breakdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .breakdown-item .count {
    font-weight: 600;
    font-size: 1.25rem;
  }

  .data-table {
    width: 100%;
    font-size: 0.875rem;
    border-collapse: collapse;
  }

  .data-table th,
  .data-table td {
    padding: 0.5rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .data-table th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
  }

  .data-table td a {
    color: var(--text);
  }

  .data-table td a:hover {
    color: var(--blue);
  }

  .runners { color: var(--purple); }
  .value { color: var(--blue); }
  .avoid { color: var(--red); }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  .metric {
    text-align: center;
    padding: 1rem;
    background: var(--bg);
    border-radius: 4px;
  }

  .metric-label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }

  .metric-value {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }

  .empty-state .hint {
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }

  .no-data {
    color: var(--text-muted);
    font-style: italic;
  }

  .signal-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: capitalize;
    background: var(--bg);
  }

  .signal-badge.positive {
    background: rgba(34, 197, 94, 0.2);
    color: var(--green);
  }

  .signal-badge.negative {
    background: rgba(239, 68, 68, 0.2);
    color: var(--red);
  }

  .insight-box {
    margin-top: 1.5rem;
    padding: 1rem;
    background: var(--bg);
    border-radius: 4px;
    border-left: 3px solid var(--blue);
  }

  .insight-box h4 {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .insight-box p {
    font-size: 0.875rem;
    margin: 0;
  }

  .target-stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .backtest-stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .highlight-green {
    color: var(--green);
  }

  .highlight-red {
    color: var(--red);
  }

  .metrics-row {
    display: flex;
    gap: 2rem;
    justify-content: center;
    padding: 1rem;
    background: var(--bg);
    border-radius: 4px;
  }

  .filter-card {
    margin-bottom: 1rem;
  }

  .filter-row {
    display: flex;
    align-items: flex-end;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .filter-group label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .filter-group select {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.875rem;
    min-width: 120px;
  }

  .filter-group select:focus {
    outline: none;
    border-color: var(--blue);
  }

  .btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .btn-primary {
    background: var(--blue);
    color: white;
  }

  .btn-primary:hover {
    background: var(--blue-hover, #2563eb);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    .stats-grid,
    .target-stats-grid,
    .backtest-stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .data-table {
      font-size: 0.75rem;
    }

    .data-table th,
    .data-table td {
      padding: 0.25rem;
    }

    .filter-row {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group select {
      width: 100%;
    }

    .metrics-row {
      flex-direction: column;
      gap: 1rem;
    }

    .tabs {
      flex-wrap: wrap;
    }
  }
</style>
