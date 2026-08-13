/**
 * Why the portfolio page has no Alpaca connection.
 *
 * `/api/alpaca` returns `connected: false` for three unrelated failures. The page
 * used to render "configure your credentials in Vercel environment variables" for
 * all three, so a rotated key or an Alpaca outage read as a missing variable and
 * sent the reader hunting through config that was already correct.
 */
export type DisconnectReason = 'not_configured' | 'auth_rejected' | 'unreachable';

export interface DisconnectDescription {
  title: string;
  message: string;
  /** Only true when the credentials are genuinely absent. */
  showEnvVarHelp: boolean;
  detail: string | null;
}

export function describeAlpacaDisconnect(
  reason: DisconnectReason,
  detail?: string
): DisconnectDescription {
  const d = detail ?? null;

  if (reason === 'auth_rejected') {
    return {
      title: 'Alpaca rejected these credentials',
      message:
        'The keys are configured but Alpaca refused them. They may have been rotated, ' +
        'or they may be live-trading keys — this dashboard talks to the paper endpoint.',
      showEnvVarHelp: false,
      detail: d,
    };
  }

  if (reason === 'unreachable') {
    return {
      title: 'Could not reach Alpaca',
      message:
        'The keys are configured but the request to Alpaca failed. This is usually ' +
        'transient — reload in a moment.',
      showEnvVarHelp: false,
      detail: d,
    };
  }

  // Default, including an older deployment that sends no reason at all.
  return {
    title: 'Connect Alpaca Account',
    message: 'To use portfolio features, configure your Alpaca API credentials:',
    showEnvVarHelp: true,
    detail: d,
  };
}
