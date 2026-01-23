import db from '../db/index.js';
import { sendEmailAlert } from './notifications/email.js';
import { sendDiscordAlert, sendDiscordSummary } from './notifications/discord.js';
import { sendSlackAlert, sendSlackSummary } from './notifications/slack.js';
import type { TickerAnalysis } from '../types/index.js';

export interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  alertType: string;
  conditions: AlertConditions;
  channels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertConditions {
  // Classification alerts
  classification?: string[];
  attentionMin?: number;
  momentumMin?: number;
  fundamentalsMin?: number;
  riskMax?: number;
  // Technical alerts
  technicalSignal?: string[];
  rsiMin?: number;
  rsiMax?: number;
  // Options alerts
  optionsSignal?: string[];
  callPutRatioMin?: number;
  // SEC alerts
  insiderBuying?: boolean;
  recent8K?: boolean;
}

interface AlertPayload {
  ticker: string;
  alertType: string;
  classification: string;
  scores: {
    attention: number;
    momentum: number;
    fundamentals: number;
    risk: number;
  };
  price: number;
  targetPrice: number | null;
  stopLoss: number | null;
  bullCase: string;
  bearCase: string;
  technicalSignal?: string;
}

/**
 * Load all enabled alert rules from database
 */
export async function loadAlertRules(): Promise<AlertRule[]> {
  try {
    const results = await db.query<{
      id: number;
      name: string;
      description: string | null;
      enabled: boolean;
      alert_type: string;
      conditions: AlertConditions;
      channels: string[];
      created_at: Date;
      updated_at: Date;
    }>(`
      SELECT * FROM alert_rules WHERE enabled = true ORDER BY id
    `);

    return results.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      alertType: row.alert_type,
      conditions: row.conditions,
      channels: row.channels,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    console.error('Failed to load alert rules:', error);
    return [];
  }
}

/**
 * Check if a ticker analysis matches alert conditions
 */
function matchesConditions(analysis: TickerAnalysis, conditions: AlertConditions): boolean {
  const { scores, classification } = analysis;

  // Classification filter
  if (conditions.classification && conditions.classification.length > 0) {
    if (!conditions.classification.includes(classification.classification)) {
      return false;
    }
  }

  // Score thresholds
  if (conditions.attentionMin !== undefined && scores.attention < conditions.attentionMin) {
    return false;
  }

  if (conditions.momentumMin !== undefined && scores.momentum < conditions.momentumMin) {
    return false;
  }

  if (conditions.fundamentalsMin !== undefined && scores.fundamentals < conditions.fundamentalsMin) {
    return false;
  }

  if (conditions.riskMax !== undefined && scores.risk > conditions.riskMax) {
    return false;
  }

  return true;
}

/**
 * Send alert to all configured channels
 */
async function sendToChannels(payload: AlertPayload, channels: string[]): Promise<string[]> {
  const sentTo: string[] = [];

  for (const channel of channels) {
    let success = false;

    switch (channel) {
      case 'email':
        success = await sendEmailAlert({
          subject: `Stock Alert: ${payload.ticker} - ${payload.classification.toUpperCase()}`,
          ...payload,
        });
        break;

      case 'discord':
        success = await sendDiscordAlert(payload);
        break;

      case 'slack':
        success = await sendSlackAlert(payload);
        break;

      default:
        console.warn(`Unknown notification channel: ${channel}`);
    }

    if (success) {
      sentTo.push(channel);
    }
  }

  return sentTo;
}

/**
 * Record alert in database
 */
async function recordAlert(
  scanResultId: number,
  ticker: string,
  alertType: string,
  scores: object,
  classification: object,
  message: string,
  sentTo: string[]
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO alerts (scan_result_id, ticker, alert_type, scores, classification, message, sent_to)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [scanResultId, ticker, alertType, JSON.stringify(scores), JSON.stringify(classification), message, sentTo]);
  } catch (error) {
    console.error('Failed to record alert:', error);
  }
}

/**
 * Process alerts for a single ticker analysis
 */
export async function processAlertsForTicker(
  analysis: TickerAnalysis & { targets?: any },
  scanResultId: number,
  rules?: AlertRule[]
): Promise<number> {
  // Load rules if not provided
  const alertRules = rules || await loadAlertRules();

  if (alertRules.length === 0) {
    // No custom rules - use default alert logic
    return processDefaultAlert(analysis, scanResultId);
  }

  let alertsSent = 0;

  for (const rule of alertRules) {
    if (!matchesConditions(analysis, rule.conditions)) {
      continue;
    }

    const payload: AlertPayload = {
      ticker: analysis.ticker,
      alertType: rule.alertType,
      classification: analysis.classification.classification,
      scores: analysis.scores,
      price: analysis.price.price,
      targetPrice: analysis.targets?.average || null,
      stopLoss: analysis.targets?.stopLoss || null,
      bullCase: analysis.classification.bullCase,
      bearCase: analysis.classification.bearCase,
    };

    const sentTo = await sendToChannels(payload, rule.channels);

    if (sentTo.length > 0) {
      await recordAlert(
        scanResultId,
        analysis.ticker,
        rule.alertType,
        analysis.scores,
        analysis.classification,
        `Alert triggered by rule: ${rule.name}`,
        sentTo
      );
      alertsSent++;
    }
  }

  return alertsSent;
}

/**
 * Process default alert based on built-in classification logic
 */
async function processDefaultAlert(
  analysis: TickerAnalysis & { targets?: any },
  scanResultId: number
): Promise<number> {
  if (!analysis.alertTriggered || !analysis.alertType) {
    return 0;
  }

  // Determine channels based on alert type
  const channels = ['discord', 'slack']; // Default to webhook channels

  const payload: AlertPayload = {
    ticker: analysis.ticker,
    alertType: analysis.alertType,
    classification: analysis.classification.classification,
    scores: analysis.scores,
    price: analysis.price.price,
    targetPrice: analysis.targets?.average || null,
    stopLoss: analysis.targets?.stopLoss || null,
    bullCase: analysis.classification.bullCase,
    bearCase: analysis.classification.bearCase,
  };

  const sentTo = await sendToChannels(payload, channels);

  if (sentTo.length > 0) {
    await recordAlert(
      scanResultId,
      analysis.ticker,
      analysis.alertType,
      analysis.scores,
      analysis.classification,
      `${analysis.alertType} alert triggered`,
      sentTo
    );
    return 1;
  }

  return 0;
}

/**
 * Send a summary notification after scan completion
 */
export async function sendScanSummary(summary: {
  totalScanned: number;
  runners: number;
  valuePlays: number;
  alerts: number;
  topPicks: Array<{ ticker: string; classification: string; attention: number }>;
}): Promise<void> {
  // Send to Discord
  await sendDiscordSummary(summary);

  // Send to Slack
  await sendSlackSummary(summary);
}

/**
 * Create a new alert rule
 */
export async function createAlertRule(
  name: string,
  alertType: string,
  conditions: AlertConditions,
  channels: string[],
  description?: string
): Promise<AlertRule | null> {
  try {
    const result = await db.query<any>(`
      INSERT INTO alert_rules (name, description, alert_type, conditions, channels)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, description || null, alertType, JSON.stringify(conditions), channels]);

    if (result.length === 0) return null;

    return {
      id: result[0].id,
      name: result[0].name,
      description: result[0].description,
      enabled: result[0].enabled,
      alertType: result[0].alert_type,
      conditions: result[0].conditions,
      channels: result[0].channels,
      createdAt: result[0].created_at,
      updatedAt: result[0].updated_at,
    };
  } catch (error) {
    console.error('Failed to create alert rule:', error);
    return null;
  }
}

/**
 * Update an alert rule
 */
export async function updateAlertRule(
  id: number,
  updates: Partial<{
    name: string;
    description: string;
    enabled: boolean;
    alertType: string;
    conditions: AlertConditions;
    channels: string[];
  }>
): Promise<boolean> {
  try {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      values.push(updates.enabled);
    }
    if (updates.alertType !== undefined) {
      setClauses.push(`alert_type = $${paramIndex++}`);
      values.push(updates.alertType);
    }
    if (updates.conditions !== undefined) {
      setClauses.push(`conditions = $${paramIndex++}`);
      values.push(JSON.stringify(updates.conditions));
    }
    if (updates.channels !== undefined) {
      setClauses.push(`channels = $${paramIndex++}`);
      values.push(updates.channels);
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    await db.query(
      `UPDATE alert_rules SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    return true;
  } catch (error) {
    console.error('Failed to update alert rule:', error);
    return false;
  }
}

/**
 * Delete an alert rule
 */
export async function deleteAlertRule(id: number): Promise<boolean> {
  try {
    await db.query('DELETE FROM alert_rules WHERE id = $1', [id]);
    return true;
  } catch (error) {
    console.error('Failed to delete alert rule:', error);
    return false;
  }
}

/**
 * Test notification channels
 */
export async function testNotificationChannels(): Promise<{
  email: boolean;
  discord: boolean;
  slack: boolean;
}> {
  const testPayload: AlertPayload = {
    ticker: 'TEST',
    alertType: 'test',
    classification: 'runner',
    scores: { attention: 85, momentum: 80, fundamentals: 60, risk: 35 },
    price: 10.00,
    targetPrice: 12.50,
    stopLoss: 9.00,
    bullCase: 'This is a test alert to verify notification channels are working.',
    bearCase: 'If you see this message, your notification channel is configured correctly.',
  };

  const [email, discord, slack] = await Promise.all([
    sendEmailAlert({ subject: 'Test Alert - Stock Screener', ...testPayload }),
    sendDiscordAlert(testPayload),
    sendSlackAlert(testPayload),
  ]);

  return { email, discord, slack };
}

export default {
  loadAlertRules,
  processAlertsForTicker,
  sendScanSummary,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  testNotificationChannels,
};
