import { captureAttention } from './services/attention-capture.js';
import { materializeVelocity } from './services/attention-materialize.js';

/**
 * Entry point for the 24/7 attention capture cron.
 *
 * Runs on its own schedule rather than inside the screener pipeline, whose cron is
 * `*\/30 14-22 * * 1-5` -- weekdays 10:00-18:30 ET only, and therefore blind to the
 * overnight and weekend windows where retail attention actually builds.
 */
async function main() {
  const started = Date.now();
  try {
    const written = await captureAttention();
    const velocities = await materializeVelocity();
    console.log(`[AttentionRunner] Done: ${written} snapshots, ${velocities} velocity rows in ${Date.now() - started}ms`);
    process.exit(0);
  } catch (err) {
    console.error('[AttentionRunner] Capture FAILED -- leaving a gap rather than partial data:', err);
    process.exit(1);
  }
}

main();
