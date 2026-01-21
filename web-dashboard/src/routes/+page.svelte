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
            <th class="sortable" on:click={() => handleSort('classification')}>
              Class{getSortIndicator('classification')}
            </th>
          </tr>
        </thead>
        <tbody>
          {#each filteredResults as result}
            <tr>
              <td>
                <a href="/ticker/{result.ticker}">
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
              <td><span class={getBadgeClass(result.classification)}>{result.classification || 'watch'}</span></td>
            </tr>
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
