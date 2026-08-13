import { describe, it, expect } from 'vitest';
import { describeAlpacaDisconnect, type DisconnectReason } from './alpaca-status';

describe('describeAlpacaDisconnect', () => {
  it('tells the user to configure credentials ONLY when they are actually missing', () => {
    const d = describeAlpacaDisconnect('not_configured');
    expect(d.title).toBe('Connect Alpaca Account');
    expect(d.showEnvVarHelp).toBe(true);
  });

  it('does NOT blame missing config when Alpaca REJECTED the credentials', () => {
    // The bug this exists to prevent: rotated keys, or live keys pointed at the
    // paper endpoint, rendered as "configure your environment variables" and sent
    // the reader hunting through Vercel for a variable that was already set.
    const d = describeAlpacaDisconnect('auth_rejected', 'HTTP 401: forbidden');
    expect(d.showEnvVarHelp).toBe(false);
    expect(d.title).not.toBe('Connect Alpaca Account');
    expect(d.detail).toBe('HTTP 401: forbidden');
  });

  it('does NOT blame missing config when Alpaca was unreachable', () => {
    const d = describeAlpacaDisconnect('unreachable', 'fetch failed');
    expect(d.showEnvVarHelp).toBe(false);
    expect(d.detail).toBe('fetch failed');
  });

  it('distinguishes a rejection from an outage in the title', () => {
    expect(describeAlpacaDisconnect('auth_rejected').title)
      .not.toBe(describeAlpacaDisconnect('unreachable').title);
  });

  it('falls back to the configure message for an unknown reason', () => {
    // An older deployment returns connected:false with no reason field at all.
    const d = describeAlpacaDisconnect(undefined as unknown as DisconnectReason);
    expect(d.title).toBe('Connect Alpaca Account');
    expect(d.showEnvVarHelp).toBe(true);
  });

  it('omits detail when none was supplied', () => {
    expect(describeAlpacaDisconnect('auth_rejected').detail).toBeNull();
  });
});
