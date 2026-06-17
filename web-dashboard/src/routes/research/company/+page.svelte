<script lang="ts">
  type Tab = { id: string; label: string };
  const TABS: Tab[] = [
    { id: 'financials', label: 'Financials' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'comps', label: 'Public Comps' },
    { id: 'oppsrisks', label: 'Opportunities & Risks' },
    { id: 'grade', label: 'Investment Grade' },
  ];

  let ticker = $state('');
  let active = $state('financials');
  let submitted = $state('');
  // per-section state: { loading, error, payload, cached }
  let sections = $state<Record<string, any>>({});

  async function load(section: string, refresh = false) {
    if (!submitted) return;
    sections[section] = { ...(sections[section] ?? {}), loading: true, error: null };
    try {
      const res = await fetch(
        `/api/research/company/${submitted}?section=${section}${refresh ? '&refresh=1' : ''}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      sections[section] = { loading: false, error: null, payload: data.payload, cached: data.cached };
    } catch (e: any) {
      sections[section] = { loading: false, error: e.message, payload: null };
    }
  }

  function analyze() {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    submitted = t;
    sections = {};
    active = 'financials';
    load('financials');
  }

  function selectTab(id: string) {
    active = id;
    if (submitted && !sections[id]) load(id);
  }

  function fmt(n: number | null, unit = '') {
    if (n === null || n === undefined) return '—';
    if (unit === '$') return Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`;
    if (unit === '%') return `${n.toFixed(1)}%`;
    if (unit === 'x') return `${n.toFixed(2)}x`;
    return n.toLocaleString();
  }
  function pct(n: number | null) { return n === null ? '—' : `${(n * 100).toFixed(1)}%`; }
</script>

<div class="page">
  <h1>Company Analysis</h1>
  <p class="note">Discretionary research grade — independent of the auto-trader's scores.</p>

  <div class="search">
    <input placeholder="Ticker (e.g. AAPL)" bind:value={ticker}
           onkeydown={(e) => e.key === 'Enter' && analyze()} />
    <button onclick={analyze}>Analyze</button>
  </div>

  {#if submitted}
    <div class="tabs">
      {#each TABS as t}
        <button class:active={active === t.id} onclick={() => selectTab(t.id)}>{t.label}</button>
      {/each}
    </div>

    {#key active}
      {@const s = sections[active]}
      <div class="panel">
        <div class="panel-head">
          <span>{submitted} — {TABS.find((t) => t.id === active)?.label}</span>
          {#if s?.cached}<span class="badge">cached today</span>{/if}
          <button class="refresh" onclick={() => load(active, true)} disabled={s?.loading}>Refresh</button>
        </div>

        {#if !s || s.loading}
          <p class="muted">Loading…</p>
        {:else if s.error}
          <p class="error">⚠ {s.error}</p>
        {:else if active === 'financials'}
          {#if s.payload.managementBelievabilityNote}
            <p class="believability">{s.payload.managementBelievabilityNote}</p>
          {/if}
          <table>
            <thead><tr><th>Line</th>{#each s.payload.years as y}<th>{y}</th>{/each}
              <th>{s.payload.forwardYear ?? 'Fwd'}</th><th>CAGR</th><th>Drivers</th></tr></thead>
            <tbody>
              {#each s.payload.rows as r}
                <tr><td>{r.label}</td>
                  {#each r.values as v}<td>{fmt(v, '$')}</td>{/each}
                  <td>{fmt(r.forwardEstimate, '$')}</td><td>{pct(r.cagr)}</td>
                  <td class="drivers">{r.driverCommentary}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'metrics'}
          <table>
            <thead><tr><th>Metric</th><th>Company</th><th>Industry Avg</th><th>Industry Leader</th></tr></thead>
            <tbody>
              {#each s.payload.rows as r}
                <tr><td>{r.label}</td><td>{fmt(r.value, r.unit)}</td>
                  <td>{fmt(r.industryAverage, r.unit)}</td><td>{fmt(r.industryLeader, r.unit)}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'comps'}
          <table>
            <thead><tr><th>Ticker</th><th>EV/Rev</th><th>Gross %</th><th>EBITDA %</th><th>Net %</th></tr></thead>
            <tbody>
              <tr class="subject"><td>{s.payload.subject.ticker}</td><td>{fmt(s.payload.subject.evToRevenue, 'x')}</td>
                <td>{fmt(s.payload.subject.grossMargin, '%')}</td><td>{fmt(s.payload.subject.ebitdaMargin, '%')}</td>
                <td>{fmt(s.payload.subject.netMargin, '%')}</td></tr>
              {#each s.payload.peers as p}
                <tr><td>{p.ticker}</td><td>{fmt(p.evToRevenue, 'x')}</td><td>{fmt(p.grossMargin, '%')}</td>
                  <td>{fmt(p.ebitdaMargin, '%')}</td><td>{fmt(p.netMargin, '%')}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'oppsrisks'}
          <div class="two-col">
            <div><h3>Opportunities</h3><ul>{#each s.payload.opportunities as o}<li>{o}</li>{/each}</ul></div>
            <div><h3>Risks</h3><ul>{#each s.payload.risks as r}<li>{r}</li>{/each}</ul></div>
          </div>
        {:else if active === 'grade'}
          <div class="grade"><div class="score">{s.payload.score}</div>
            <div><strong>{s.payload.band}</strong><p>{s.payload.rationale}</p></div></div>
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; color: #e5e7eb; }
  h1 { margin-bottom: 0.25rem; }
  .note { color: #9ca3af; font-size: 0.85rem; margin-bottom: 1rem; }
  .search { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .search input { flex: 1; padding: 0.5rem; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 6px; }
  .search button, .refresh { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid #374151; margin-bottom: 1rem; flex-wrap: wrap; }
  .tabs button { padding: 0.5rem 0.9rem; background: none; border: none; color: #9ca3af; cursor: pointer; border-bottom: 2px solid transparent; }
  .tabs button.active { color: #e5e7eb; border-bottom-color: #2563eb; }
  .panel-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .badge { font-size: 0.7rem; background: #374151; padding: 0.15rem 0.5rem; border-radius: 999px; }
  .refresh { margin-left: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #1f2937; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td.drivers { text-align: left; color: #9ca3af; font-size: 0.78rem; max-width: 260px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .two-col h3 { color: #e5e7eb; } .two-col li { margin-bottom: 0.4rem; color: #d1d5db; }
  .grade { display: flex; gap: 1.5rem; align-items: center; }
  .grade .score { font-size: 3rem; font-weight: 700; color: #22c55e; }
  .subject { background: #0b2545; font-weight: 600; }
  .muted { color: #9ca3af; } .error { color: #f87171; }
  .believability { color: #d1d5db; font-style: italic; margin-bottom: 0.75rem; }
</style>
