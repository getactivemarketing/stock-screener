<script lang="ts">
  import { onMount } from 'svelte';

  let ticker = $state('');
  let desiredUsd = $state(4000);
  let loading = $state(false);
  let error = $state('');
  let plan = $state<any>(null);
  let planId = $state<number | null>(null);
  let orders = $state<any[]>([]);
  let staging = $state(false);
  let confirming = $state(false);
  let openPlans = $state<any[]>([]);

  // Staged plans leave GTC orders live on the broker indefinitely. planId used
  // to live only in component state, so a reload stranded those orders with no
  // way to reconcile or cancel them from here. Load them back on mount instead.
  onMount(loadOpenPlans);

  async function loadOpenPlans() {
    try {
      const res = await fetch('/api/research/entry/plans');
      const data = await res.json();
      if (res.ok) openPlans = data.plans ?? [];
    } catch { /* non-fatal: the build flow still works without the resume list */ }
  }

  async function resumePlan(p: any) {
    plan = p.plan; planId = p.id; ticker = p.ticker; confirming = false; error = '';
    orders = [];
    await refreshStatus();
  }

  async function buildPlan() {
    if (!ticker.trim()) return;
    loading = true; error = ''; plan = null; planId = null; orders = []; confirming = false;
    try {
      const res = await fetch('/api/research/entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.trim().toUpperCase(), desiredUsd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      plan = data.plan; planId = data.planId;
    } catch (e: any) { error = e.message; }
    loading = false;
  }

  async function stage() {
    if (planId == null) return;
    staging = true; error = '';
    try {
      const res = await fetch('/api/research/entry/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Staging failed');
      orders = data.orders; confirming = false;
      await loadOpenPlans(); // the plan is now staged and resumable
    } catch (e: any) { error = e.message; }
    staging = false;
  }

  async function refreshStatus() {
    if (planId == null) return;
    const res = await fetch(`/api/research/entry/status?planId=${planId}`);
    const data = await res.json();
    if (res.ok) orders = data.orders;
  }

  async function cancelRemaining() {
    if (planId == null) return;
    const res = await fetch('/api/research/entry/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    if (res.ok) { await refreshStatus(); await loadOpenPlans(); }
  }

  const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
</script>

<div class="page">
  <h1>Entry Analysis</h1>
  <p class="note">Stages GTC limit orders on the paper account (tagged <code>s2-</code>). Shares it with the auto-trader's positions.</p>

  <div class="search">
    <input placeholder="Ticker (e.g. AAPL)" bind:value={ticker} onkeydown={(e) => e.key === 'Enter' && buildPlan()} />
    <input type="number" min="100" step="100" bind:value={desiredUsd} />
    <button onclick={buildPlan} disabled={loading}>{loading ? 'Building…' : 'Build Plan'}</button>
  </div>

  {#if error}<p class="error">⚠ {error}</p>{/if}

  {#if openPlans.length > 0}
    <div class="resume">
      <h3>Staged plans</h3>
      <p class="note">These placed GTC orders that stay live on the broker until they fill or you cancel them.</p>
      {#each openPlans as p}
        <div class="resume-row">
          <span><strong>#{p.id} {p.ticker}</strong></span>
          <span>{p.liveOrders} order{p.liveOrders === 1 ? '' : 's'} still open</span>
          <span class="dim">{new Date(p.createdAt).toLocaleDateString()}</span>
          <button onclick={() => resumePlan(p)} disabled={planId === p.id}>
            {planId === p.id ? 'Open' : 'Resume'}
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if plan}
    <div class="indicators">
      <span>Price {money(plan.indicators.currentPrice)}</span>
      <span>8/20/50d {plan.indicators.ma8?.toFixed(2) ?? '—'} / {plan.indicators.ma20?.toFixed(2) ?? '—'} / {plan.indicators.ma50?.toFixed(2) ?? '—'}</span>
      <span>52w {plan.indicators.low52w?.toFixed(2) ?? '—'}–{plan.indicators.high52w?.toFixed(2) ?? '—'}</span>
      <span>Rel vol {plan.indicators.relativeVolume?.toFixed(2) ?? '—'}x</span>
      <span>Volatility {plan.indicators.volatilityBand}</span>
    </div>

    <div class="narrative">
      <p><strong>Volume:</strong> {plan.narrative.volumeTrend}</p>
      <p><strong>Short interest:</strong> {plan.narrative.shortInterest}</p>
      <p><strong>Holders &amp; drivers:</strong> {plan.narrative.holdersAndDrivers}</p>
    </div>

    <h3>Entry plan — {plan.tranches.length} tranches, total {money(plan.totalCost)} of {money(plan.desiredUsd)}</h3>
    <table>
      <thead><tr><th>#</th><th>Shares</th><th>Limit</th><th>Cost</th><th>Rationale</th></tr></thead>
      <tbody>
        {#each plan.tranches as t}
          <tr><td>{t.trancheN}</td><td>{t.shares}</td><td>{money(t.limitPrice)}</td>
            <td>{money(t.shares * t.limitPrice)}</td><td class="rat">{t.rationale}</td></tr>
        {/each}
      </tbody>
    </table>

    {#if orders.length === 0}
      {#if !confirming}
        <button class="stage" onclick={() => (confirming = true)}>Stage these orders</button>
      {:else}
        <div class="confirm">
          <p>Place {plan.tranches.length} GTC limit buys totaling {money(plan.totalCost)} on the paper account?</p>
          <button class="stage" onclick={stage} disabled={staging}>{staging ? 'Placing…' : 'Confirm'}</button>
          <button onclick={() => (confirming = false)}>Cancel</button>
        </div>
      {/if}
    {:else}
      <h3>Staged orders</h3>
      <table>
        <thead><tr><th>#</th><th>Shares</th><th>Limit</th><th>Status</th><th>Alpaca ID</th></tr></thead>
        <tbody>
          {#each orders as o}
            <tr><td>{o.trancheN}</td><td>{o.shares}</td><td>{money(o.limitPrice)}</td>
              <td>{o.status}</td><td class="rat">{o.alpacaOrderId ?? '—'}</td></tr>
          {/each}
        </tbody>
      </table>
      <div class="actions">
        <button onclick={refreshStatus}>Refresh status</button>
        <button class="danger" onclick={cancelRemaining}>Cancel remaining</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; color: #e5e7eb; }
  h1 { margin-bottom: 0.25rem; }
  .note { color: #9ca3af; font-size: 0.85rem; margin-bottom: 1rem; }
  .note code { background: #1f2937; padding: 0 0.25rem; border-radius: 3px; }
  .search { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .search input[type="text"], .search input:not([type]) { flex: 1; }
  .search input { padding: 0.5rem; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 6px; }
  .search input[type="number"] { width: 120px; }
  button { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
  button.danger { background: #b91c1c; }
  .indicators { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.85rem; color: #d1d5db; margin-bottom: 0.75rem; }
  .narrative p { color: #d1d5db; font-size: 0.85rem; margin: 0.25rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.5rem 0 1rem; }
  th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #1f2937; text-align: right; }
  th:first-child, td:first-child, td.rat { text-align: left; }
  td.rat { color: #9ca3af; font-size: 0.78rem; }
  .stage { background: #16a34a; }
  .confirm { display: flex; gap: 0.75rem; align-items: center; background: #0b2545; padding: 0.75rem; border-radius: 6px; }
  .confirm p { margin: 0; flex: 1; }
  .actions { display: flex; gap: 0.75rem; }
  .error { color: #f87171; }
  .resume { background: #14213d; border: 1px solid #1e3a5f; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; }
  .resume h3 { margin: 0 0 0.25rem; font-size: 0.95rem; }
  .resume .note { margin-bottom: 0.6rem; }
  .resume-row { display: flex; align-items: center; gap: 1rem; font-size: 0.85rem; padding: 0.35rem 0; border-top: 1px solid #1e3a5f; }
  .resume-row button { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
  .resume-row button:disabled { background: #374151; cursor: default; }
  .dim { color: #9ca3af; margin-left: auto; }
</style>
