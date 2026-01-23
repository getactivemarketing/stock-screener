<script lang="ts">
  import type { PageData } from './$types';

  export let data: PageData;

  let { rules, history, stats } = data;
  let showNewRuleForm = false;
  let editingRule: any = null;

  // New rule form state
  let newRule = {
    name: '',
    description: '',
    alertType: 'classification',
    conditions: {
      classification: [] as string[],
      attentionMin: 70,
      momentumMin: 60,
      riskMax: 70,
    },
    channels: ['discord'] as string[],
  };

  const alertTypes = [
    { value: 'classification', label: 'Classification Alert' },
    { value: 'technical', label: 'Technical Signal' },
    { value: 'options', label: 'Options Flow' },
    { value: 'sec', label: 'SEC Filing' },
    { value: 'price_target', label: 'Price Target' },
  ];

  const channels = [
    { value: 'discord', label: 'Discord' },
    { value: 'slack', label: 'Slack' },
    { value: 'email', label: 'Email' },
  ];

  const classifications = [
    { value: 'runner', label: 'Runner' },
    { value: 'value', label: 'Value' },
    { value: 'both', label: 'Both' },
    { value: 'avoid', label: 'Avoid' },
  ];

  async function createRule() {
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newRule.name,
          description: newRule.description,
          alertType: newRule.alertType,
          conditions: newRule.conditions,
          channels: newRule.channels,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        rules = [data.rule, ...rules];
        showNewRuleForm = false;
        resetNewRule();
      }
    } catch (error) {
      console.error('Failed to create rule:', error);
    }
  }

  async function toggleRule(rule: any) {
    try {
      const res = await fetch('/api/alerts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: rule.id,
          enabled: !rule.enabled,
        }),
      });

      if (res.ok) {
        rule.enabled = !rule.enabled;
        rules = [...rules];
      }
    } catch (error) {
      console.error('Failed to toggle rule:', error);
    }
  }

  async function deleteRule(id: number) {
    if (!confirm('Are you sure you want to delete this alert rule?')) {
      return;
    }

    try {
      const res = await fetch(`/api/alerts?id=${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        rules = rules.filter(r => r.id !== id);
      }
    } catch (error) {
      console.error('Failed to delete rule:', error);
    }
  }

  function resetNewRule() {
    newRule = {
      name: '',
      description: '',
      alertType: 'classification',
      conditions: {
        classification: [],
        attentionMin: 70,
        momentumMin: 60,
        riskMax: 70,
      },
      channels: ['discord'],
    };
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }

  function getAlertTypeIcon(type: string): string {
    switch (type) {
      case 'runner': return '🚀';
      case 'value': return '💎';
      case 'both': return '⭐';
      case 'pump_warning': return '⚠️';
      case 'technical': return '📈';
      case 'options': return '📊';
      case 'sec': return '📋';
      default: return '🔔';
    }
  }
</script>

<svelte:head>
  <title>Alerts - Stock Screener</title>
</svelte:head>

<div class="alerts-page">
  <h1>Alert Management</h1>

  <!-- Stats Overview -->
  <div class="stats-grid">
    {#each stats as stat}
      <div class="stat-card">
        <div class="stat-icon">{getAlertTypeIcon(stat.alert_type)}</div>
        <div class="stat-content">
          <div class="stat-value">{stat.count}</div>
          <div class="stat-label">{stat.alert_type} alerts</div>
          <div class="stat-date">Last: {formatDate(stat.last_triggered)}</div>
        </div>
      </div>
    {/each}
    {#if stats.length === 0}
      <div class="stat-card empty">
        <p>No alerts in the last 30 days</p>
      </div>
    {/if}
  </div>

  <!-- Alert Rules Section -->
  <section class="rules-section">
    <div class="section-header">
      <h2>Alert Rules</h2>
      <button class="btn btn-primary" on:click={() => showNewRuleForm = !showNewRuleForm}>
        {showNewRuleForm ? 'Cancel' : '+ New Rule'}
      </button>
    </div>

    {#if showNewRuleForm}
      <div class="card new-rule-form">
        <h3>Create New Alert Rule</h3>
        <form on:submit|preventDefault={createRule}>
          <div class="form-group">
            <label for="name">Rule Name</label>
            <input type="text" id="name" bind:value={newRule.name} required placeholder="e.g., High Momentum Runners" />
          </div>

          <div class="form-group">
            <label for="description">Description (optional)</label>
            <input type="text" id="description" bind:value={newRule.description} placeholder="Brief description of this rule" />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="alertType">Alert Type</label>
              <select id="alertType" bind:value={newRule.alertType}>
                {#each alertTypes as type}
                  <option value={type.value}>{type.label}</option>
                {/each}
              </select>
            </div>

            <div class="form-group">
              <label>Notification Channels</label>
              <div class="checkbox-group">
                {#each channels as channel}
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      bind:group={newRule.channels}
                      value={channel.value}
                    />
                    {channel.label}
                  </label>
                {/each}
              </div>
            </div>
          </div>

          <div class="form-group">
            <label>Classifications to Alert On</label>
            <div class="checkbox-group">
              {#each classifications as cls}
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    bind:group={newRule.conditions.classification}
                    value={cls.value}
                  />
                  {cls.label}
                </label>
              {/each}
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="attentionMin">Min Attention Score</label>
              <input type="number" id="attentionMin" bind:value={newRule.conditions.attentionMin} min="0" max="100" />
            </div>
            <div class="form-group">
              <label for="momentumMin">Min Momentum Score</label>
              <input type="number" id="momentumMin" bind:value={newRule.conditions.momentumMin} min="0" max="100" />
            </div>
            <div class="form-group">
              <label for="riskMax">Max Risk Score</label>
              <input type="number" id="riskMax" bind:value={newRule.conditions.riskMax} min="0" max="100" />
            </div>
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-secondary" on:click={() => showNewRuleForm = false}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Create Rule
            </button>
          </div>
        </form>
      </div>
    {/if}

    <div class="rules-list">
      {#each rules as rule}
        <div class="rule-card {rule.enabled ? '' : 'disabled'}">
          <div class="rule-header">
            <div class="rule-info">
              <h3>{rule.name}</h3>
              {#if rule.description}
                <p class="rule-description">{rule.description}</p>
              {/if}
            </div>
            <div class="rule-actions">
              <button
                class="btn btn-sm {rule.enabled ? 'btn-success' : 'btn-secondary'}"
                on:click={() => toggleRule(rule)}
              >
                {rule.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <button class="btn btn-sm btn-danger" on:click={() => deleteRule(rule.id)}>
                Delete
              </button>
            </div>
          </div>

          <div class="rule-details">
            <div class="rule-detail">
              <span class="detail-label">Type:</span>
              <span class="badge">{rule.alert_type}</span>
            </div>
            <div class="rule-detail">
              <span class="detail-label">Channels:</span>
              {#each rule.channels as channel}
                <span class="badge badge-channel">{channel}</span>
              {/each}
            </div>
            <div class="rule-detail">
              <span class="detail-label">Conditions:</span>
              <code>{JSON.stringify(rule.conditions)}</code>
            </div>
          </div>

          <div class="rule-meta">
            Created: {formatDate(rule.created_at)}
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <p>No alert rules configured yet.</p>
          <button class="btn btn-primary" on:click={() => showNewRuleForm = true}>
            Create Your First Rule
          </button>
        </div>
      {/each}
    </div>
  </section>

  <!-- Alert History Section -->
  <section class="history-section">
    <h2>Recent Alert History</h2>

    <div class="history-list">
      {#each history as alert}
        <div class="history-item">
          <div class="history-icon">{getAlertTypeIcon(alert.alert_type)}</div>
          <div class="history-content">
            <div class="history-header">
              <a href="/ticker/{alert.ticker}" class="ticker-link">{alert.ticker}</a>
              <span class="badge">{alert.alert_type}</span>
              <span class="history-time">{formatDate(alert.alert_timestamp)}</span>
            </div>
            {#if alert.message}
              <p class="history-message">{alert.message}</p>
            {/if}
            <div class="history-channels">
              Sent to: {alert.sent_to.join(', ')}
            </div>
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <p>No alerts have been triggered yet.</p>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .alerts-page {
    max-width: 1200px;
    margin: 0 auto;
  }

  h1 {
    margin-bottom: 1.5rem;
  }

  h2 {
    font-size: 1.25rem;
    margin-bottom: 1rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    background: var(--card-bg);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .stat-card.empty {
    grid-column: 1 / -1;
    justify-content: center;
    color: var(--text-muted);
  }

  .stat-icon {
    font-size: 2rem;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .stat-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-transform: capitalize;
  }

  .stat-date {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .rules-section,
  .history-section {
    margin-bottom: 2rem;
  }

  .new-rule-form {
    margin-bottom: 1.5rem;
    padding: 1.5rem;
  }

  .new-rule-form h3 {
    margin-bottom: 1rem;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    font-size: 0.875rem;
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .checkbox-group {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .form-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }

  .rules-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .rule-card {
    background: var(--card-bg);
    border-radius: 8px;
    padding: 1rem;
    border: 1px solid var(--border);
  }

  .rule-card.disabled {
    opacity: 0.6;
  }

  .rule-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }

  .rule-info h3 {
    font-size: 1rem;
    margin-bottom: 0.25rem;
  }

  .rule-description {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .rule-actions {
    display: flex;
    gap: 0.5rem;
  }

  .rule-details {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .rule-detail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .detail-label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .rule-detail code {
    font-size: 0.75rem;
    background: var(--bg);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rule-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .history-item {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    background: var(--card-bg);
    border-radius: 8px;
  }

  .history-icon {
    font-size: 1.5rem;
  }

  .history-content {
    flex: 1;
  }

  .history-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .ticker-link {
    font-weight: 700;
    color: var(--blue);
    text-decoration: none;
  }

  .ticker-link:hover {
    text-decoration: underline;
  }

  .history-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .history-message {
    font-size: 0.875rem;
    margin: 0.5rem 0;
  }

  .history-channels {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }

  .badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    background: var(--bg);
    text-transform: capitalize;
  }

  .badge-channel {
    background: var(--blue);
    color: white;
  }

  .btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .btn:hover {
    opacity: 0.9;
  }

  .btn-primary {
    background: var(--blue);
    color: white;
  }

  .btn-secondary {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn-success {
    background: var(--green);
    color: white;
  }

  .btn-danger {
    background: var(--red);
    color: white;
  }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  @media (max-width: 768px) {
    .rule-header {
      flex-direction: column;
      gap: 1rem;
    }

    .rule-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
