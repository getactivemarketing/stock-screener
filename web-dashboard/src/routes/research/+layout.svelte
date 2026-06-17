<script lang="ts">
  let { children } = $props();
</script>

<nav class="research-nav">
  <a href="/research/company">Company Analysis</a>
  <a href="/research/entry">Entry Analysis</a>
</nav>
{@render children()}

<style>
  .research-nav { display: flex; gap: 1rem; padding: 0.75rem 1.5rem; border-bottom: 1px solid #1f2937; }
  .research-nav a { color: #9ca3af; text-decoration: none; }
  .research-nav a:hover { color: #e5e7eb; }
</style>
