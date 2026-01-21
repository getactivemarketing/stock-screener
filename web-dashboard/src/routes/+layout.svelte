<script>
  import '../app.css';
</script>

<header>
  <div class="container">
    <div class="header-content">
      <div class="header-title">
        <h1><a href="/">Stock Screener</a></h1>
        <p>Value + Momentum Scanner</p>
      </div>
      <nav class="header-nav">
        <a href="/">Screener</a>
        <a href="/sectors">Sectors</a>
        <a href="/analytics">Analytics</a>
        <a href="/portfolio">Portfolio</a>
      </nav>
    </div>
  </div>
</header>

<main class="container">
  <slot />
</main>

<style>
  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header-nav {
    display: flex;
    gap: 1.5rem;
  }

  .header-nav a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .header-nav a:hover {
    color: var(--text);
  }

  @media (max-width: 640px) {
    .header-content {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.75rem;
    }
  }
</style>
