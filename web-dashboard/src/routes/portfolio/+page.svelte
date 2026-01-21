<script lang="ts">
  import { onMount } from 'svelte';

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

  // Order form state
  let orderTicker = '';
  let orderAction: 'BUY' | 'SELL' = 'BUY';
  let orderQuantity = 1;
  let orderType: 'MKT' | 'LMT' = 'MKT';
  let orderPrice = 0;
  let orderSubmitting = false;
  let orderMessage = '';

  onMount(async () => {
    await Promise.all([
      fetchAccount(),
      fetchPositions(),
      fetchOrders(),
    ]);
    loading = false;
  });

  async function fetchAccount() {
    try {
      const res = await fetch('/api/webull?type=account');
      if (res.ok) {
        account = await res.json();
        connected = true;
      }
    } catch (e) {
      console.error('Failed to fetch account:', e);
    }
  }

  async function fetchPositions() {
    try {
      const res = await fetch('/api/webull?type=positions');
      if (res.ok) {
        positions = await res.json();
      }
    } catch (e) {
      console.error('Failed to fetch positions:', e);
    }
  }

  async function fetchOrders() {
    try {
      const res = await fetch('/api/webull?type=orders');
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
      const res = await fetch('/api/webull', {
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
        // Refresh orders
        await fetchOrders();
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
    <h3>Connect Webull Account</h3>
    <p>To use portfolio features, configure your Webull credentials in the environment variables:</p>
    <ul>
      <li><code>WEBULL_EMAIL</code></li>
      <li><code>WEBULL_PASSWORD</code></li>
      <li><code>WEBULL_TRADING_PIN</code> (for paper trading)</li>
    </ul>
    <p class="note">Paper trading is enabled by default for safety.</p>
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

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .form-row {
      flex-direction: column;
    }
  }
</style>
