<script lang="ts">
  export let form: { error?: string } | null = null;
  export let data: { configured: boolean };
</script>

<svelte:head><title>Sign in - Stock Screener</title></svelte:head>

<div class="login-wrap">
  <div class="card login-card">
    <h2>Stock Screener</h2>
    <p class="note">This dashboard is private. Enter the password to continue.</p>

    {#if !data.configured}
      <p class="note err">
        No password is configured on the server, so nothing can sign in. Set
        <code>DASHBOARD_PASSWORD</code> and redeploy.
      </p>
    {/if}

    <form method="POST">
      <input
        type="password"
        name="password"
        placeholder="Password"
        autocomplete="current-password"
        aria-label="Password"
        required
      />
      <button type="submit">Sign in</button>
    </form>

    {#if form?.error}
      <p class="note err">{form.error}</p>
    {/if}
  </div>
</div>

<style>
  .login-wrap { display: flex; justify-content: center; padding: 4rem 1rem; }
  .login-card { max-width: 22rem; width: 100%; }
  form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem; }
  input { padding: 0.6rem; border-radius: 4px; border: 1px solid var(--border, #333);
          background: var(--bg-alt, #111); color: inherit; font-size: 1rem; }
  button { padding: 0.6rem; border-radius: 4px; border: 0; cursor: pointer;
           background: var(--blue, #2563eb); color: #fff; font-size: 1rem; }
  .err { color: var(--red, #dc2626); }
</style>
