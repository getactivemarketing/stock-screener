<script lang="ts">
  import { onMount } from 'svelte';

  interface Day {
    date: string; // YYYY-MM-DD
    equity: number;
    profitLoss: number;
    profitLossPct: number;
  }

  let days: Day[] = [];
  let loading = true;
  let error: string | null = null;

  // Calendar state
  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth(); // 0-11

  async function loadHistory() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/alpaca?type=portfolio-history&period=3M&timeframe=1D');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      days = data.days || [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(loadHistory);

  // Build a lookup by YYYY-MM-DD
  $: dayMap = new Map(days.map((d) => [d.date, d]));

  // Summary stats
  $: totalPL = days.reduce((s, d) => s + d.profitLoss, 0);
  $: winDays = days.filter((d) => d.profitLoss > 0).length;
  $: lossDays = days.filter((d) => d.profitLoss < 0).length;
  $: tradingDays = days.filter((d) => d.profitLoss !== 0).length;
  $: winRate = tradingDays > 0 ? (winDays / tradingDays) * 100 : 0;
  $: bestDay = days.reduce<Day | null>((best, d) => (!best || d.profitLoss > best.profitLoss ? d : best), null);
  $: worstDay = days.reduce<Day | null>((worst, d) => (!worst || d.profitLoss < worst.profitLoss ? d : worst), null);

  // Build calendar grid for viewYear/viewMonth: 6 weeks × 7 days
  $: calendar = buildCalendar(viewYear, viewMonth);

  function buildCalendar(year: number, month: number) {
    const first = new Date(year, month, 1);
    const startDow = first.getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ date: string | null; day: number | null }> = [];

    // Leading blanks
    for (let i = 0; i < startDow; i++) cells.push({ date: null, day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ date, day: d });
    }
    // Pad to full weeks
    while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
    return cells;
  }

  function prevMonth() {
    if (viewMonth === 0) {
      viewMonth = 11;
      viewYear--;
    } else {
      viewMonth--;
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      viewMonth = 0;
      viewYear++;
    } else {
      viewMonth++;
    }
  }

  function fmtMoney(n: number): string {
    const sign = n >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  function fmtPct(n: number): string {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
</script>

<div class="page">
  <h2>Daily Performance</h2>
  <p class="subtitle">Alpaca paper account — trailing 3 months</p>

  {#if loading}
    <div class="state">Loading…</div>
  {:else if error}
    <div class="state error">Error: {error}</div>
  {:else}
    <div class="summary">
      <div class="stat">
        <div class="label">Period P&L</div>
        <div class="value" class:pos={totalPL > 0} class:neg={totalPL < 0}>
          {fmtMoney(totalPL)}
        </div>
      </div>
      <div class="stat">
        <div class="label">Win rate</div>
        <div class="value">{winRate.toFixed(0)}% ({winDays}W / {lossDays}L)</div>
      </div>
      <div class="stat">
        <div class="label">Best day</div>
        <div class="value pos">
          {bestDay && bestDay.profitLoss > 0 ? fmtMoney(bestDay.profitLoss) : '—'}
        </div>
      </div>
      <div class="stat">
        <div class="label">Worst day</div>
        <div class="value neg">
          {worstDay && worstDay.profitLoss < 0 ? fmtMoney(worstDay.profitLoss) : '—'}
        </div>
      </div>
    </div>

    <div class="cal-header">
      <button on:click={prevMonth} aria-label="Previous month">‹</button>
      <h3>{monthNames[viewMonth]} {viewYear}</h3>
      <button on:click={nextMonth} aria-label="Next month">›</button>
    </div>

    <div class="cal-grid">
      {#each dayLabels as dl}
        <div class="dow">{dl}</div>
      {/each}
      {#each calendar as cell}
        {#if cell.date === null}
          <div class="cell blank"></div>
        {:else}
          {@const d = dayMap.get(cell.date)}
          <div
            class="cell"
            class:pos={d && d.profitLoss > 0}
            class:neg={d && d.profitLoss < 0}
            class:flat={d && d.profitLoss === 0}
            class:empty={!d}
            title={d ? `${cell.date}: ${fmtMoney(d.profitLoss)} (${fmtPct(d.profitLossPct)})` : cell.date}
          >
            <div class="day-num">{cell.day}</div>
            {#if d}
              <div class="day-pl">{fmtMoney(d.profitLoss)}</div>
              <div class="day-pct">{fmtPct(d.profitLossPct)}</div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    padding: 1rem 0;
  }
  h2 {
    margin: 0 0 0.25rem;
  }
  .subtitle {
    color: var(--text-muted);
    margin: 0 0 1.5rem;
    font-size: 0.875rem;
  }
  .state {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }
  .state.error {
    color: #ef4444;
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .stat {
    background: var(--surface, #111);
    border: 1px solid var(--border, #222);
    border-radius: 8px;
    padding: 1rem;
  }
  .stat .label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }
  .stat .value {
    font-size: 1.25rem;
    font-weight: 600;
  }
  .pos { color: #10b981; }
  .neg { color: #ef4444; }

  .cal-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .cal-header h3 {
    margin: 0;
    min-width: 10rem;
    text-align: center;
  }
  .cal-header button {
    background: var(--surface, #111);
    border: 1px solid var(--border, #222);
    color: var(--text, #eee);
    width: 2rem;
    height: 2rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1.25rem;
    line-height: 1;
  }
  .cal-header button:hover {
    background: var(--surface-hover, #1a1a1a);
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }
  .dow {
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.25rem 0;
    font-weight: 600;
  }
  .cell {
    background: var(--surface, #111);
    border: 1px solid var(--border, #222);
    border-radius: 6px;
    min-height: 4.5rem;
    padding: 0.4rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .cell.blank {
    background: transparent;
    border: none;
  }
  .cell.empty {
    opacity: 0.4;
  }
  .cell.pos {
    background: rgba(16, 185, 129, 0.15);
    border-color: rgba(16, 185, 129, 0.4);
  }
  .cell.neg {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.4);
  }
  .cell.flat {
    opacity: 0.7;
  }
  .day-num {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
  }
  .day-pl {
    font-size: 0.8rem;
    font-weight: 600;
    margin-top: auto;
  }
  .cell.pos .day-pl { color: #10b981; }
  .cell.neg .day-pl { color: #ef4444; }
  .day-pct {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .summary {
      grid-template-columns: repeat(2, 1fr);
    }
    .cell {
      min-height: 3.5rem;
      padding: 0.25rem;
    }
    .day-pl { font-size: 0.7rem; }
    .day-pct { display: none; }
  }
</style>
