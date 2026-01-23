import { query } from '$lib/db';

interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  alert_type: string;
  conditions: object;
  channels: string[];
  created_at: string;
  updated_at: string;
}

interface AlertHistory {
  id: number;
  ticker: string;
  alert_type: string;
  alert_timestamp: string;
  scores: object;
  classification: object;
  message: string;
  sent_to: string[];
}

export async function load() {
  try {
    // Fetch alert rules
    const rules = await query<AlertRule>(`
      SELECT * FROM alert_rules ORDER BY created_at DESC
    `);

    // Fetch recent alert history
    const history = await query<AlertHistory>(`
      SELECT * FROM alerts
      ORDER BY alert_timestamp DESC
      LIMIT 50
    `);

    // Fetch alert stats
    const stats = await query<{
      alert_type: string;
      count: number;
      last_triggered: string;
    }>(`
      SELECT
        alert_type,
        COUNT(*) as count,
        MAX(alert_timestamp) as last_triggered
      FROM alerts
      WHERE alert_timestamp > NOW() - INTERVAL '30 days'
      GROUP BY alert_type
      ORDER BY count DESC
    `);

    return {
      rules,
      history,
      stats,
    };
  } catch (error) {
    console.error('Failed to load alerts data:', error);
    return {
      rules: [],
      history: [],
      stats: [],
    };
  }
}
