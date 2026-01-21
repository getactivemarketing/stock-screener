<script lang="ts">
  import { onMount } from 'svelte';

  interface SectorData {
    sector: string;
    ticker_count: number;
    avg_attention: number;
    avg_momentum: number;
    avg_fundamentals: number;
    avg_change_1d: number;
    runners: number;
    value_plays: number;
    avoids: number;
    heatScore: number;
    tickers: Array<{
      ticker: string;
      price: number;
      change: number;
      attention: number;
      classification: string;
    }>;
  }

  let sectors: SectorData[] = [];
  let loading = true;
  let selectedSector: SectorData | null = null;

  onMount(async () => {
    try {
      const res = await fetch('/api/sectors');
      if (res.ok) {
        sectors = await res.json();
      }
    } catch (e) {
      console.error('Failed to fetch sectors:', e);
    }
    loading = false;
  });

  function getHeatColor(score: number): string {
    // Score ranges from -100 (cold/red) to +100 (hot/green)
    if (score >= 50) return '#22c55e';
    if (score >= 20) return '#86efac';
    if (score >= 0) return '#fef08a';
    if (score >= -20) return '#fca5a5';
    return '#ef4444';
  }

  function formatNumber(num: number | null): string {
    if (num === null || num === undefined) return '-';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    return num.toFixed(2);
  }

  function formatPercent(num: number | null): string {
    if (num === null || num === undefined) return '-';
    const sign = num >= 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
  }

  function getBadgeClass(classification: string): string {
    return `badge badge-${classification || 'watch'}`;
  }
</script>

<svelte:head>
  <title>Sector Heatmap - Stock Screener</title>
</svelte:head>

<h2>Sector Heatmap</h2>
<p class="subtitle">Heat based on momentum, price change, and classification mix</p>

{#if loading}
  <div class="loading-container">
    <p>Loading sectors...</p>
  </div>
{:else if sectors.length === 0}
  <div class="empty">
    <p>No sector data available. Run the pipeline to get started.</p>
  </div>
{:else}
  <div class="heatmap-grid">
    {#each sectors as sector}
      <button
        class="sector-tile"
        style="background-color: {getHeatColor(sector.heatScore)};"
        on:click={() => selectedSector = selectedSector?.sector === sector.sector ? null : sector}
      >
        <div class="sector-name">{sector.sector}</div>
        <div class="sector-stats">
          <span>{sector.ticker_count} tickers</span>
          <span class="change">{formatPercent(sector.avg_change_1d)}</span>
        </div>
        <div class="sector-breakdown">
          {#if sector.runners > 0}
            <span class="runners">{sector.runners} R</span>
          {/if}
          {#if sector.value_plays > 0}
            <span class="value">{sector.value_plays} V</span>
          {/if}
          {#if sector.avoids > 0}
            <span class="avoid">{sector.avoids} A</span>
          {/if}
        </div>
      </button>
    {/each}
  </div>

  <!-- Selected Sector Details -->
  {#if selectedSector}
    <div class="sector-details card">
      <div class="details-header">
        <h3>{selectedSector.sector}</h3>
        <button class="close-btn" on:click={() => selectedSector = null}>&times;</button>
      </div>

      <div class="details-stats">
        <div class="stat">
          <span class="label">Avg Attention</span>
          <span class="value">{selectedSector.avg_attention?.toFixed(0) || '-'}</span>
        </div>
        <div class="stat">
          <span class="label">Avg Momentum</span>
          <span class="value">{selectedSector.avg_momentum?.toFixed(0) || '-'}</span>
        </div>
        <div class="stat">
          <span class="label">Avg Fundamentals</span>
          <span class="value">{selectedSector.avg_fundamentals?.toFixed(0) || '-'}</span>
        </div>
        <div class="stat">
          <span class="label">Heat Score</span>
          <span class="value" style="color: {getHeatColor(selectedSector.heatScore)}">{selectedSector.heatScore}</span>
        </div>
      </div>

      <h4>Tickers in this sector</h4>
      <div class="tickers-list">
        {#each selectedSector.tickers.slice(0, 10) as ticker}
          <a href="/ticker/{ticker.ticker}" class="ticker-item">
            <span class="ticker-symbol">{ticker.ticker}</span>
            <span class={getBadgeClass(ticker.classification)}>{ticker.classification || 'watch'}</span>
            <span class="ticker-attention">Att: {ticker.attention}</span>
            <span class={parseFloat(ticker.change) >= 0 ? 'positive' : 'negative'}>
              {formatPercent(parseFloat(ticker.change))}
            </span>
          </a>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Legend -->
  <div class="legend card">
    <h4>Legend</h4>
    <div class="legend-items">
      <div class="legend-item">
        <span class="color-box" style="background: #22c55e;"></span>
        <span>Hot (Strong momentum, runners)</span>
      </div>
      <div class="legend-item">
        <span class="color-box" style="background: #86efac;"></span>
        <span>Warm</span>
      </div>
      <div class="legend-item">
        <span class="color-box" style="background: #fef08a;"></span>
        <span>Neutral</span>
      </div>
      <div class="legend-item">
        <span class="color-box" style="background: #fca5a5;"></span>
        <span>Cool</span>
      </div>
      <div class="legend-item">
        <span class="color-box" style="background: #ef4444;"></span>
        <span>Cold (Weak momentum, avoids)</span>
      </div>
    </div>
    <p class="legend-note">R = Runners, V = Value Plays, A = Avoids</p>
  </div>
{/if}

<style>
  h2 {
    margin-bottom: 0.25rem;
  }

  .subtitle {
    color: var(--text-muted);
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
  }

  .loading-container {
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
  }

  .heatmap-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .sector-tile {
    padding: 1rem;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    text-align: left;
    color: #000;
    transition: transform 0.1s, box-shadow 0.1s;
  }

  .sector-tile:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .sector-name {
    font-weight: 600;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sector-stats {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    margin-bottom: 0.25rem;
  }

  .sector-stats .change {
    font-weight: 600;
  }

  .sector-breakdown {
    display: flex;
    gap: 0.5rem;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .sector-breakdown .runners { color: #7c3aed; }
  .sector-breakdown .value { color: #1d4ed8; }
  .sector-breakdown .avoid { color: #991b1b; }

  .sector-details {
    margin-bottom: 1.5rem;
  }

  .details-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .details-header h3 {
    margin: 0;
    color: var(--text);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text);
  }

  .details-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat {
    text-align: center;
  }

  .stat .label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.25rem;
  }

  .stat .value {
    font-size: 1.5rem;
    font-weight: 700;
  }

  h4 {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.75rem;
  }

  .tickers-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .ticker-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem;
    background: var(--bg);
    border-radius: 4px;
    text-decoration: none;
    color: var(--text);
  }

  .ticker-item:hover {
    background: var(--bg-hover);
  }

  .ticker-symbol {
    font-weight: 600;
    min-width: 60px;
  }

  .ticker-attention {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .legend {
    margin-top: 1.5rem;
  }

  .legend h4 {
    margin-bottom: 0.75rem;
  }

  .legend-items {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .color-box {
    width: 16px;
    height: 16px;
    border-radius: 2px;
  }

  .legend-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  @media (max-width: 640px) {
    .details-stats {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
