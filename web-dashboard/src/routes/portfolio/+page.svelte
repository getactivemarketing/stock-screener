<script lang="ts">
  import { onMount } from 'svelte';
  import { describeAlpacaDisconnect, type DisconnectDescription } from '$lib/alpaca-status';

  interface Account {
    accountId: string;
    accountType: 'PAPER' | 'LIVE';
    totalValue: number;
    cashBalance: number;
    buyingPower: number;
    dayPL: number;
    dayPLPercent: number;
    totalPL: number;
    totalPLPercent: number;
  }

  interface Position {
    ticker: string;
    quantity: number;
    avgCost: number;
    marketValue: number;
    unrealizedPL: number;
    unrealizedPLPercent: number;
    lastPrice: number;
  }

  interface Order {
    orderId: string;
    ticker: string;
    action: 'BUY' | 'SELL';
    orderType: string;
    quantity: number;
    price?: number;
    status: string;
    filledQuantity: number;
    createTime: string;
  }

  let account: Account | null = null;
  let positions: Position[] = [];
  let orders: Order[] = [];
  let loading = true;
  let activeTab = 'positions';
  let connected = false;
  let disconnect: DisconnectDescription | null = null;

  // Order form state
  let orderTicker = '';
  let orderAction: 'BUY' | 'SELL' = 'BUY';
  let orderQuantity = 1;
  let orderType: 'MKT' | 'LMT' = 'MKT';
  let orderPrice = 0;
  let orderSubmitting = false;
  let orderMessage = '';

  interface AITrade {
    id: string;
    ticker: string;
    action: 'BUY' | 'SELL';
    quantity: number;
    status: string;
    filled_price: number | null;
    classification: string | null;
    trade_rationale: string | null;
    key_risk: string | null;
    scores: any;
    stop_loss: number | null;
    target_price: number | null;
    created_at: string;
    company_name: string | null;
    tier: string | null;
    value_score: number | null;
    catalyst_score: number | null;
    emerging_industry_score: number | null;
  }

  let aiTrades: AITrade[] = [];
  let aiTradesTotal = 0;
  let aiTradeFilter = 'all';

  async function fetchAITrades() {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (aiTradeFilter !== 'all') params.set('action', aiTradeFilter);
      const res = await fetch(`/api/trades?${params}`);
      if (res.ok) {
        const data = await res.json();
        aiTrades = data.trades || [];
        aiTradesTotal = data.total || 0;
      }
    } catch (e) {
      console.error('Failed to fetch AI trades:', e);
    }
  }

  onMount(async () => {
    await Promise.all([
      fetchAccount(),
      fetchPositions(),
      fetchOrders(),
      fetchAITrades(),
    ]);
    loading = false;
  });

  async function fetchAccount() {
    try {
      const res = await fetch('/api/alpaca?type=account');
      if (res.ok) {
        const data = await res.json();
        account = data;
        connected = data.connected !== false;
        if (!connected) {
          disconnect = describeAlpacaDisconnect(data.reason, data.detail ?? undefined);
        }
      }
    } catch (e) {
      console.error('Failed to fetch account:', e);
    }
  }

  async function fetchPositions() {
    try {
      const res = await fetch('/api/alpaca?type=positions');
      if (res.ok) {
        positions = await res.json();
      }
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }
  }

  async function fetchOrders() {
    try {
      const res = await fetch('/api/alpaca?type=orders');
      if (res.ok) {
        orders = await res.json();
      }
    } catch (e) {
      console.error('Failed to fetch orders:', e);
    }
  }

  async function submitOrder() {
    if (!orderTicker || orderQuantity <= 0) {
      orderMessage = 'Please enter ticker and quantity';
      return;
    }

    orderSubmitting = true;
    orderMessage = '';

    try {
      const res = await fetch('/api/alpaca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: orderAction,
          ticker: orderTicker.toUpperCase(),
          quantity: orderQuantity,
          orderType,
          price: orderType === 'LMT' ? orderPrice : undefined,
        }),
      });

      const result = await res.json();

      if (result.success) {
        orderMessage = `Order placed: ${orderAction} ${orderQuantity} ${orderTicker}`;
        orderTicker = '';
        orderQuantity = 1;
        // Refresh orders and positions
        await Promise.all([fetchOrders(), fetchPositions()]);
      } else {
        orderMessage = result.error || 'Order failed';
      }
    } catch (e) {
      orderMessage = 'Failed to place order';
    }

    orderSubmitting = false;
  }

  function formatCurrency(num: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(num);
  }

  function formatPercent(num: number): string {
    const sign = num >= 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }
</script>

<svelte:head>
  <title>Portfolio - Stock Screener</title>
</svelte:head>

<h2>Portfolio</h2>

{#if loading}
  <div class="loading-container">
    <p>Loading portfolio...</p>
  </div>
{:else if !connected}
  <div class="card connect-card">
    <h3>{disconnect?.title ?? 'Connect Alpaca Account'}</h3>
    <p>{disconnect?.message ?? 'To use portfolio features, configure your Alpaca API credentials:'}</p>
    {#if disconnect?.showEnvVarHelp ?? true}
      <ul>
        <li><code>ALPACA_API_KEY</code></li>
        <li><code>ALPACA_API_SECRET</code></li>
      </ul>
      <p class="note">
        Set these in Vercel environment variables for the deployed site, or in
        <code>web-dashboard/.env</code> for local development.
      </p>
      <p class="note">Get your free API keys at <a href="https://alpaca.markets" target="_blank">alpaca.markets</a></p>
    {/if}
    {#if disconnect?.detail}
      <p class="note detail">{disconnect.detail}</p>
    {/if}
    <p class="note">Paper trading is used by default for safety.</p>
  </div>
{:else}
  <!-- Account Summary -->
  {#if account}
    <div class="account-summary">
      <div class="account-badge">
        <span class="badge badge-{account.accountType.toLowerCase()}">{account.accountType}</span>
      </div>
      <div class="stats-grid">
        <div class="card stat-card">
          <div class="stat-value">{formatCurrency(account.totalValue)}</div>
          <div class="stat-label">Total Value</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">{formatCurrency(account.cashBalance)}</div>
          <div class="stat-label">Cash Balance</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">{formatCurrency(account.buyingPower)}</div>
          <div class="stat-label">Buying Power</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value {account.dayPL >= 0 ? 'positive' : 'negative'}">
            {formatCurrency(account.dayPL)}
          </div>
          <div class="stat-label">Day P/L ({formatPercent(account.dayPLPercent)})</div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Tabs -->
  <div class="tabs">
    <button class:active={activeTab === 'positions'} on:click={() => activeTab = 'positions'}>
      Positions ({positions.length})
    </button>
    <button class:active={activeTab === 'orders'} on:click={() => activeTab = 'orders'}>
      Orders ({orders.length})
    </button>
    <button class:active={activeTab === 'trade'} on:click={() => activeTab = 'trade'}>
      Trade
    </button>
    <button class:active={activeTab === 'aiTrades'} on:click={() => activeTab = 'aiTrades'}>
      AI Trades ({aiTradesTotal})
    </button>
  </div>

  <!-- Positions Tab -->
  {#if activeTab === 'positions'}
    <div class="card">
      {#if positions.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Qty</th>
              <th>Avg Cost</th>
              <th>Last Price</th>
              <th>Market Value</th>
              <th>P/L</th>
              <th>P/L %</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each positions as pos}
              <tr>
                <td><a href="/ticker/{pos.ticker}"><strong>{pos.ticker}</strong></a></td>
                <td>{pos.quantity}</td>
                <td>{formatCurrency(pos.avgCost)}</td>
                <td>{formatCurrency(pos.lastPrice)}</td>
                <td>{formatCurrency(pos.marketValue)}</td>
                <td class={pos.unrealizedPL >= 0 ? 'positive' : 'negative'}>
                  {formatCurrency(pos.unrealizedPL)}
                </td>
                <td class={pos.unrealizedPLPercent >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(pos.unrealizedPLPercent)}
                </td>
                <td>
                  <button
                    class="btn-sell"
                    on:click={() => { orderTicker = pos.ticker; orderAction = 'SELL'; orderQuantity = pos.quantity; activeTab = 'trade'; }}
                  >
                    Sell
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-data">No open positions</p>
      {/if}
    </div>
  {/if}

  <!-- Orders Tab -->
  {#if activeTab === 'orders'}
    <div class="card">
      {#if orders.length > 0}
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Ticker</th>
              <th>Action</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Filled</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each orders as order}
              <tr>
                <td>{formatDate(order.createTime)}</td>
                <td><strong>{order.ticker}</strong></td>
                <td class={order.action === 'BUY' ? 'buy' : 'sell'}>{order.action}</td>
                <td>{order.orderType}</td>
                <td>{order.quantity}</td>
                <td>{order.price ? formatCurrency(order.price) : 'MKT'}</td>
                <td>{order.filledQuantity}/{order.quantity}</td>
                <td><span class="status status-{order.status.toLowerCase()}">{order.status}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-data">No orders</p>
      {/if}
    </div>
  {/if}

  <!-- Trade Tab -->
  {#if activeTab === 'trade'}
    <div class="card trade-card">
      <h3>Place Paper Trade</h3>

      <div class="trade-form">
        <div class="form-row">
          <div class="form-group">
            <label for="ticker">Ticker</label>
            <input
              id="ticker"
              type="text"
              bind:value={orderTicker}
              placeholder="AAPL"
              class="input-ticker"
            />
          </div>

          <div class="form-group">
            <label for="action">Action</label>
            <select id="action" bind:value={orderAction}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="quantity">Quantity</label>
            <input
              id="quantity"
              type="number"
              bind:value={orderQuantity}
              min="1"
            />
          </div>

          <div class="form-group">
            <label for="orderType">Order Type</label>
            <select id="orderType" bind:value={orderType}>
              <option value="MKT">Market</option>
              <option value="LMT">Limit</option>
            </select>
          </div>
        </div>

        {#if orderType === 'LMT'}
          <div class="form-row">
            <div class="form-group">
              <label for="price">Limit Price</label>
              <input
                id="price"
                type="number"
                bind:value={orderPrice}
                min="0.01"
                step="0.01"
              />
            </div>
          </div>
        {/if}

        <button
          class="btn-submit {orderAction.toLowerCase()}"
          on:click={submitOrder}
          disabled={orderSubmitting}
        >
          {orderSubmitting ? 'Placing...' : `${orderAction} ${orderTicker || 'Stock'}`}
        </button>

        {#if orderMessage}
          <p class="order-message">{orderMessage}</p>
        {/if}
      </div>
    </div>
  {/if}

  <!-- AI Trades Tab -->
  {#if activeTab === 'aiTrades'}
    <div class="card">
      <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
        <button class="filter-btn" class:active={aiTradeFilter === 'all'} on:click={() => { aiTradeFilter = 'all'; fetchAITrades(); }}>All</button>
        <button class="filter-btn" class:active={aiTradeFilter === 'BUY'} on:click={() => { aiTradeFilter = 'BUY'; fetchAITrades(); }}>Buys</button>
        <button class="filter-btn" class:active={aiTradeFilter === 'SELL'} on:click={() => { aiTradeFilter = 'SELL'; fetchAITrades(); }}>Sells</button>
      </div>

      {#if aiTrades.length > 0}
        {#each aiTrades as trade}
          <div class="ai-trade-card">
            <div class="ai-trade-header">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="action-badge action-{trade.action.toLowerCase()}">{trade.action}</span>
                {#if trade.tier}
                  <span class="tier-badge tier-{trade.tier.toLowerCase()}">{trade.tier === 'MOMENTUM' ? 'M' : 'Q'}</span>
                {/if}
                <a href="/ticker/{trade.ticker}"><strong>{trade.ticker}</strong></a>
                <span style="color: var(--text-muted);">{trade.quantity} shares {trade.filled_price ? `@ $${Number(trade.filled_price).toFixed(2)}` : ''}</span>
                {#if trade.classification}
                  <span class="badge badge-{trade.classification}">{trade.classification}</span>
                {/if}
                <span class="status status-{trade.status?.toLowerCase()}">{trade.status}</span>
              </div>
              <span style="color: var(--text-muted); font-size: 0.75rem;">{formatDate(trade.created_at)}</span>
            </div>
            {#if trade.trade_rationale}
              <div class="ai-trade-body">
                <span style="color: var(--text); font-size: 0.8rem;">{trade.trade_rationale}</span>
                {#if trade.value_score !== null && trade.value_score !== undefined}
                  <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 8px;">
                    V:{trade.value_score} C:{trade.catalyst_score} E:{trade.emerging_industry_score}
                  </span>
                {/if}
                {#if trade.target_price}
                  <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 8px;">
                    Target: ${Number(trade.target_price).toFixed(2)}
                  </span>
                {/if}
                {#if trade.stop_loss}
                  <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 8px;">
                    Stop: ${Number(trade.stop_loss).toFixed(2)}
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {:else}
        <p class="no-data">No AI trades yet. Enable trading in config to start.</p>
      {/if}
    </div>
  {/if}
{/if}

<style>
  h2 {
    margin-bottom: 1rem;
  }

  .loading-container {
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
  }

  .connect-card {
    max-width: 500px;
  }

  .connect-card h3 {
    margin-bottom: 1rem;
  }

  .connect-card ul {
    margin: 1rem 0;
    padding-left: 1.5rem;
  }

  .connect-card li {
    margin-bottom: 0.5rem;
  }

  .connect-card code {
    background: var(--bg);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .note {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-top: 1rem;
  }

  .note a {
    color: var(--blue);
  }

  /* Raw error text from Alpaca -- monospaced so an HTTP status stays readable. */
  .note.detail {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    word-break: break-word;
  }

  .account-summary {
    margin-bottom: 1.5rem;
  }

  .account-badge {
    margin-bottom: 1rem;
  }

  .badge-paper {
    background: var(--blue);
  }

  .badge-live {
    background: var(--green);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .stat-card {
    text-align: center;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .stat-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
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

  .card {
    margin-bottom: 1.5rem;
  }

  .data-table {
    width: 100%;
    font-size: 0.875rem;
    border-collapse: collapse;
  }

  .data-table th,
  .data-table td {
    padding: 0.75rem 0.5rem;
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

  .btn-sell {
    background: var(--red);
    color: white;
    border: none;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .btn-sell:hover {
    opacity: 0.9;
  }

  .buy { color: var(--green); }
  .sell { color: var(--red); }

  .status {
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    text-transform: uppercase;
  }

  .status-pending { background: var(--yellow); color: #000; }
  .status-filled { background: var(--green); color: #fff; }
  .status-cancelled { background: var(--red); color: #fff; }

  .no-data {
    color: var(--text-muted);
    font-style: italic;
    padding: 2rem;
    text-align: center;
  }

  .trade-card h3 {
    margin-bottom: 1.5rem;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.875rem;
  }

  .trade-form {
    max-width: 400px;
  }

  .form-row {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .form-group {
    flex: 1;
  }

  .form-group label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 0.75rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 1rem;
  }

  .input-ticker {
    text-transform: uppercase;
  }

  .btn-submit {
    width: 100%;
    padding: 1rem;
    border: none;
    border-radius: 4px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    margin-top: 1rem;
  }

  .btn-submit.buy {
    background: var(--green);
    color: white;
  }

  .btn-submit.sell {
    background: var(--red);
    color: white;
  }

  .btn-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .order-message {
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--bg);
    border-radius: 4px;
    text-align: center;
  }

  .ai-trade-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .ai-trade-header {
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-card);
  }

  .ai-trade-body {
    padding: 8px 12px;
    background: var(--bg);
    border-top: 1px solid var(--border);
  }

  .action-badge {
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .action-buy { background: var(--green); color: #000; }
  .action-sell { background: var(--red); color: #fff; }

  .filter-btn {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .filter-btn.active {
    border-color: var(--blue);
    color: var(--text);
  }

  .tier-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
  }

  .tier-momentum { background: var(--yellow); color: #000; }
  .tier-quality { background: var(--blue); color: #fff; }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .form-row {
      flex-direction: column;
    }
  }
</style>
