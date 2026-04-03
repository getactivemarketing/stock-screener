<script lang="ts">
  import type { PageData } from './$types';

  export let data: PageData;

  // Sorting state
  let sortColumn = 'attention_score';
  let sortDirection: 'asc' | 'desc' = 'desc';

  // Filter state
  let classFilter = 'all';
  let minPrice = '';
  let maxPrice = '';
  let minAttention = '';
  let minMomentum = '';
  let minFundamentals = '';
  let searchTicker = '';
  let tierFilter = 'all';
  let expandedTicker = '';

  function toggleExpand(ticker: string) {
    expandedTicker = expandedTicker === ticker ? '' : ticker;
  }

  // Get numeric value for sorting
  function getNumeric(val: any): number {
    if (val === null || val === undefined) return 0;
    const n = typeof val === 'string' ? parseFloat(val) : val;
    return isNaN(n) ? 0 : n;
  }

  // Filtered and sorted results
  $: filteredResults = data.results
    .filter(r => {
      // Classification filter
      if (classFilter !== 'all' && r.classification !== classFilter) return false;

      // Tier filter
      if (tierFilter !== 'all' && r.tier !== tierFilter) return false;

      // Ticker search
      if (searchTicker && !r.ticker.toLowerCase().includes(searchTicker.toLowerCase())) return false;

      // Price filters
      const price = getNumeric(r.price);
      if (minPrice && price < parseFloat(minPrice)) return false;
      if (maxPrice && price > parseFloat(maxPrice)) return false;

      // Score filters
      if (minAttention && r.attention_score < parseInt(minAttention)) return false;
      if (minMomentum && r.momentum_score < parseInt(minMomentum)) return false;
      if (minFundamentals && r.fundamentals_score < parseInt(minFundamentals)) return false;

      return true;
    })
    .sort((a, b) => {
      let aVal: any, bVal: any;

      switch (sortColumn) {
        case 'ticker':
          aVal = a.ticker;
          bVal = b.ticker;
          break;
        case 'price':
          aVal = getNumeric(a.price);
          bVal = getNumeric(b.price);
          break;
        case 'change':
          aVal = getNumeric(a.price_change_1d_pct);
          bVal = getNumeric(b.price_change_1d_pct);
          break;
        case 'market_cap':
          aVal = getNumeric(a.market_cap);
          bVal = getNumeric(b.market_cap);
          break;
        case 'attention_score':
          aVal = a.attention_score;
          bVal = b.attention_score;
          break;
        case 'momentum_score':
          aVal = a.momentum_score;
          bVal = b.momentum_score;
          break;
        case 'fundamentals_score':
          aVal = a.fundamentals_score;
          bVal = b.fundamentals_score;
          break;
        case 'risk_score':
          aVal = a.risk_score;
          bVal = b.risk_score;
          break;
        case 'classification':
          aVal = a.classification || 'watch';
          bVal = b.classification || 'watch';
          break;
        case 'tier':
          aVal = a.tier || '';
          bVal = b.tier || '';
          break;
        case 'value_score':
          aVal = getNumeric(a.value_score);
          bVal = getNumeric(b.value_score);
          break;
        case 'catalyst_score':
          aVal = getNumeric(a.catalyst_score);
          bVal = getNumeric(b.catalyst_score);
          break;
        case 'emerging_industry_score':
          aVal = getNumeric(a.emerging_industry_score);
          bVal = getNumeric(b.emerging_industry_score);
          break;
        default:
          aVal = a.attention_score;
          bVal = b.attention_score;
      }

      if (typeof aVal === 'string') {
        const cmp = aVal.localeCompare(bVal);
        return sortDirection === 'asc' ? cmp : -cmp;
      }

      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

  function handleSort(column: string) {
    if (sortColumn === column) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDirection = 'desc';
    }
  }

  function clearFilters() {
    classFilter = 'all';
    tierFilter = 'all';
    minPrice = '';
    maxPrice = '';
    minAttention = '';
    minMomentum = '';
    minFundamentals = '';
    searchTicker = '';
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

  function formatPercent(num: number | string | null): string {
    if (num === null || num === undefined) return '-';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return '-';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function getScoreClass(score: number): string {
    if (score >= 70) return 'score-high';
    if (score >= 40) return 'score-medium';
    return 'score-low';
  }

  function getBadgeClass(classification: string): string {
    return `badge badge-${classification || 'watch'}`;
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }

  function getSortIndicator(column: string): string {
    if (sortColumn !== column) return '';
    return sortDirection === 'asc' ? ' ▲' : ' ▼';
  }
</script>

<svelte:head>
  <title>Stock Screener Dashboard</title>
</svelte:head>

<!-- Stats -->
<div class="stats-grid">
  <div class="card stat-card">
    <div class="stat-value">{data.stats.totalTickers}</div>
    <div class="stat-label">Tickers Analyzed</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--purple)">{data.stats.runners}</div>
    <div class="stat-label">Runners</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--blue)">{data.stats.valuePlays}</div>
    <div class="stat-label">Value Plays</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--yellow)">{data.stats.alerts}</div>
    <div class="stat-label">Alerts</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--yellow)">{data.stats.momentumCount}</div>
    <div class="stat-label">Momentum</div>
  </div>
  <div class="card stat-card">
    <div class="stat-value" style="color: var(--blue)">{data.stats.qualityCount}</div>
    <div class="stat-label">Quality</div>
  </div>
</div>

{#if data.latestRun}
  <p style="color: var(--text-muted); margin-bottom: 1rem; font-size: 0.875rem;">
    Last updated: {formatDate(data.latestRun.run_timestamp)}
  </p>
{/if}

<!-- Filters -->
<div class="card filters-card">
  <div class="filters-row">
    <div class="filter-group">
      <label for="search">Search</label>
      <input
        type="text"
        id="search"
        bind:value={searchTicker}
        placeholder="Ticker..."
      />
    </div>

    <div class="filter-group">
      <label for="class">Classification</label>
      <select id="class" bind:value={classFilter}>
        <option value="all">All</option>
        <option value="runner">Runners</option>
        <option value="value">Value</option>
        <option value="both">Both</option>
        <option value="watch">Watch</option>
        <option value="avoid">Avoid</option>
      </select>
    </div>

    <div class="filter-group">
      <label for="tier">Tier</label>
      <select id="tier" bind:value={tierFilter}>
        <option value="all">All</option>
        <option value="MOMENTUM">Momentum</option>
        <option value="QUALITY">Quality</option>
      </select>
    </div>

    <div class="filter-group">
      <label>Price Range</label>
      <div class="range-inputs">
        <input type="number" bind:value={minPrice} placeholder="Min" />
        <span>-</span>
        <input type="number" bind:value={maxPrice} placeholder="Max" />
      </div>
    </div>

    <div class="filter-group">
      <label for="attention">Min Attention</label>
      <input type="number" id="attention" bind:value={minAttention} placeholder="0-100" min="0" max="100" />
    </div>

    <div class="filter-group">
      <label for="momentum">Min Momentum</label>
      <input type="number" id="momentum" bind:value={minMomentum} placeholder="0-100" min="0" max="100" />
    </div>

    <div class="filter-group">
      <label for="fundamentals">Min Fundamentals</label>
      <input type="number" id="fundamentals" bind:value={minFundamentals} placeholder="0-100" min="0" max="100" />
    </div>

    <button class="clear-btn" on:click={clearFilters}>Clear</button>
  </div>

  <div class="filter-summary">
    Showing {filteredResults.length} of {data.results.length} tickers
  </div>
</div>

<!-- Results Table -->
<div class="card">
  {#if data.results.length === 0}
    <div class="empty">
      <p>No results yet. Run the pipeline to get started.</p>
    </div>
  {:else if filteredResults.length === 0}
    <div class="empty">
      <p>No results match your filters.</p>
    </div>
  {:else}
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th class="sortable" on:click={() => handleSort('ticker')}>
              Ticker{getSortIndicator('ticker')}
            </th>
            <th class="sortable" on:click={() => handleSort('price')}>
              Price{getSortIndicator('price')}
            </th>
            <th class="sortable" on:click={() => handleSort('change')}>
              Change{getSortIndicator('change')}
            </th>
            <th class="sortable" on:click={() => handleSort('market_cap')}>
              Market Cap{getSortIndicator('market_cap')}
            </th>
            <th class="sortable" on:click={() => handleSort('attention_score')}>
              Attention{getSortIndicator('attention_score')}
            </th>
            <th class="sortable" on:click={() => handleSort('momentum_score')}>
              Momentum{getSortIndicator('momentum_score')}
            </th>
            <th class="sortable" on:click={() => handleSort('fundamentals_score')}>
              Fundamentals{getSortIndicator('fundamentals_score')}
            </th>
            <th class="sortable" on:click={() => handleSort('risk_score')}>
              Risk{getSortIndicator('risk_score')}
            </th>
            <th>Lens</th>
            <th class="sortable" on:click={() => handleSort('classification')}>
              Class{getSortIndicator('classification')}
            </th>
          </tr>
        </thead>
        <tbody>
          {#each filteredResults as result}
            <tr on:click={() => toggleExpand(result.ticker)} style="cursor: pointer;">
              <td>
                <a href="/ticker/{result.ticker}" on:click|stopPropagation>
                  {#if result.tier}
                    <span class="tier-badge tier-{result.tier?.toLowerCase()}">{result.tier === 'MOMENTUM' ? 'M' : 'Q'}</span>
                  {/if}
                  <strong>{result.ticker}</strong>
                </a>
                {#if result.company_name}
                  <br><span style="color: var(--text-muted); font-size: 0.75rem;">{result.company_name}</span>
                {/if}
              </td>
              <td>${formatNumber(result.price)}</td>
              <td class={getNumeric(result.price_change_1d_pct) >= 0 ? 'positive' : 'negative'}>
                {formatPercent(result.price_change_1d_pct)}
              </td>
              <td>${formatNumber(result.market_cap)}</td>
              <td><span class="score {getScoreClass(result.attention_score)}">{result.attention_score}</span></td>
              <td><span class="score {getScoreClass(result.momentum_score)}">{result.momentum_score}</span></td>
              <td><span class="score {getScoreClass(result.fundamentals_score)}">{result.fundamentals_score}</span></td>
              <td><span class="score {getScoreClass(100 - result.risk_score)}">{result.risk_score}</span></td>
              <td>
                {#if result.value_score !== null && result.value_score !== undefined}
                  <span class="lens lens-v">V:{result.value_score}</span>
                  <span class="lens lens-c">C:{result.catalyst_score}</span>
                  <span class="lens lens-e">E:{result.emerging_industry_score}</span>
                {:else}
                  <span style="color: var(--text-muted)">-</span>
                {/if}
              </td>
              <td><span class={getBadgeClass(result.classification)}>{result.classification || 'watch'}</span></td>
            </tr>
            {#if expandedTicker === result.ticker}
              <tr class="expanded-row">
                <td colspan="11">
                  <div class="expand-panel">
                    {#if result.thesis}
                      <div class="expand-section">
                        <span class="expand-label">THESIS</span>
                        <p>{result.thesis}</p>
                      </div>
                    {/if}
                    {#if result.edge_why_now}
                      <div class="expand-section">
                        <span class="expand-label">WHY NOW</span>
                        <p class="why-now">{result.edge_why_now}</p>
                      </div>
                    {/if}
                    <div class="expand-metrics">
                      {#if result.target_avg}
                        <div class="expand-metric">
                          <span class="expand-label">Target</span>
                          <span class="positive">${formatNumber(result.target_avg)} ({formatPercent(((getNumeric(result.target_avg) - getNumeric(result.price)) / getNumeric(result.price)) * 100)})</span>
                        </div>
                      {/if}
                      {#if result.stop_loss_pct}
                        <div class="expand-metric">
                          <span class="expand-label">Stop</span>
                          <span class="negative">{result.stop_loss_pct}%</span>
                        </div>
                      {/if}
                      {#if result.expected_returns}
                        <div class="expand-metric">
                          <span class="expand-label">Returns</span>
                          <span>1M: {result.expected_returns?.oneMonth || result.expected_returns?.['1m'] || 'N/A'} | 3M: {result.expected_returns?.threeMonth || result.expected_returns?.['3m'] || 'N/A'} | 12M: {result.expected_returns?.twelveMonth || result.expected_returns?.['12m'] || 'N/A'}</span>
                        </div>
                      {/if}
                      {#if result.industry_theme}
                        <span class="theme-badge">{result.industry_theme}</span>
                      {/if}
                    </div>
                    {#if result.catalysts && result.catalysts.length > 0}
                      <div class="expand-section" style="margin-top: 0.5rem;">
                        <span class="expand-label">CATALYSTS</span>
                        <p>{result.catalysts.join(' | ')}</p>
                      </div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .filters-card {
    margin-bottom: 1rem;
  }

  .filters-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-end;
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

  .filter-group input,
  .filter-group select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem;
    color: var(--text);
    font-size: 0.875rem;
    min-width: 80px;
  }

  .filter-group input:focus,
  .filter-group select:focus {
    outline: none;
    border-color: var(--blue);
  }

  .range-inputs {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .range-inputs input {
    width: 70px;
  }

  .range-inputs span {
    color: var(--text-muted);
  }

  .clear-btn {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 1rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.875rem;
  }

  .clear-btn:hover {
    border-color: var(--text-muted);
    color: var(--text);
  }

  .filter-summary {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .sortable {
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }

  .sortable:hover {
    color: var(--text);
  }

  .tier-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
    margin-right: 4px;
    vertical-align: middle;
  }
  .tier-momentum { background: var(--yellow); color: #000; }
  .tier-quality { background: var(--blue); color: #fff; }

  .lens { padding: 2px 6px; border-radius: 3px; font-size: 0.7rem; margin-right: 2px; }
  .lens-v { background: rgba(34, 197, 94, 0.2); color: var(--green); }
  .lens-c { background: rgba(59, 130, 246, 0.2); color: var(--blue); }
  .lens-e { background: rgba(168, 85, 247, 0.2); color: var(--purple); }

  .expanded-row td { padding: 0 !important; background: var(--bg); }
  .expand-panel { padding: 1rem; border-top: 1px solid var(--border); }
  .expand-section { margin-bottom: 0.75rem; }
  .expand-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 0.25rem; }
  .expand-section p { color: var(--text); font-size: 0.85rem; line-height: 1.5; }
  .why-now { color: var(--yellow) !important; font-style: italic; }
  .expand-metrics { display: flex; gap: 12px; flex-wrap: wrap; }
  .expand-metric { background: var(--bg-card); padding: 6px 10px; border-radius: 4px; font-size: 0.75rem; }
  .theme-badge { background: rgba(168, 85, 247, 0.15); color: var(--purple); padding: 3px 8px; border-radius: 3px; font-size: 0.7rem; }

  @media (max-width: 768px) {
    .filters-row {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group input,
    .filter-group select {
      width: 100%;
    }

    .range-inputs input {
      width: 100%;
    }
  }
</style>
