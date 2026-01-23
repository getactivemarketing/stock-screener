import { config } from '../../lib/config.js';

interface SlackAlert {
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

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  accessory?: object;
}

/**
 * Send Slack webhook alert
 */
export async function sendSlackAlert(alert: SlackAlert): Promise<boolean> {
  if (!config.slackWebhookUrl) {
    console.log('Slack notifications not configured (missing SLACK_WEBHOOK_URL)');
    return false;
  }

  try {
    const blocks = createSlackBlocks(alert);

    const response = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: `${getClassificationEmoji(alert.classification)} Stock Alert: ${alert.ticker}`,
        blocks,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Slack webhook error:', error);
      return false;
    }

    console.log(`Slack alert sent for ${alert.ticker}`);
    return true;
  } catch (error) {
    console.error('Failed to send Slack alert:', error);
    return false;
  }
}

/**
 * Create Slack blocks for alert
 */
function createSlackBlocks(alert: SlackAlert): SlackBlock[] {
  const emoji = getClassificationEmoji(alert.classification);
  const color = getClassificationColor(alert.classification);

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${alert.ticker} - ${alert.alertType.toUpperCase()} Alert`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Price:*\n$${alert.price.toFixed(2)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Classification:*\n${alert.classification.toUpperCase()}`,
        },
        {
          type: 'mrkdwn',
          text: `*Attention:*\n${alert.scores.attention}/100`,
        },
        {
          type: 'mrkdwn',
          text: `*Momentum:*\n${alert.scores.momentum}/100`,
        },
        {
          type: 'mrkdwn',
          text: `*Fundamentals:*\n${alert.scores.fundamentals}/100`,
        },
        {
          type: 'mrkdwn',
          text: `*Risk:*\n${alert.scores.risk}/100`,
        },
      ],
    },
  ];

  // Add target prices section
  if (alert.targetPrice || alert.stopLoss) {
    const targetFields: SlackBlock['fields'] = [];

    if (alert.targetPrice) {
      const upside = ((alert.targetPrice - alert.price) / alert.price * 100).toFixed(1);
      targetFields.push({
        type: 'mrkdwn',
        text: `*Target Price:*\n$${alert.targetPrice.toFixed(2)} (${upside}%)`,
      });
    }

    if (alert.stopLoss) {
      const downside = ((alert.stopLoss - alert.price) / alert.price * 100).toFixed(1);
      targetFields.push({
        type: 'mrkdwn',
        text: `*Stop Loss:*\n$${alert.stopLoss.toFixed(2)} (${downside}%)`,
      });
    }

    if (targetFields.length > 0) {
      blocks.push({
        type: 'section',
        fields: targetFields,
      });
    }
  }

  // Add technical signal if available
  if (alert.technicalSignal) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Technical Signal:* ${alert.technicalSignal.toUpperCase()}`,
      },
    });
  }

  // Add divider
  blocks.push({ type: 'divider' });

  // Add bull case
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:chart_with_upwards_trend: Bull Case:*\n${truncateText(alert.bullCase, 300)}`,
    },
  });

  // Add bear case
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:chart_with_downwards_trend: Bear Case:*\n${truncateText(alert.bearCase, 300)}`,
    },
  });

  // Add context (timestamp)
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Stock Screener | ${new Date().toLocaleString()}`,
      },
    ],
  } as any);

  return blocks;
}

/**
 * Truncate text for Slack (has character limits)
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

/**
 * Get emoji for classification
 */
function getClassificationEmoji(classification: string): string {
  switch (classification) {
    case 'runner':
      return ':rocket:';
    case 'value':
      return ':gem:';
    case 'both':
      return ':star:';
    case 'avoid':
      return ':warning:';
    default:
      return ':eyes:';
  }
}

/**
 * Get color for classification
 */
function getClassificationColor(classification: string): string {
  switch (classification) {
    case 'runner':
      return '#22c55e';
    case 'value':
      return '#3b82f6';
    case 'both':
      return '#a855f7';
    case 'avoid':
      return '#ef4444';
    default:
      return '#eab308';
  }
}

/**
 * Send a batch summary to Slack
 */
export async function sendSlackSummary(summary: {
  totalScanned: number;
  runners: number;
  valuePlays: number;
  alerts: number;
  topPicks: Array<{ ticker: string; classification: string; attention: number }>;
}): Promise<boolean> {
  if (!config.slackWebhookUrl) {
    return false;
  }

  try {
    const topPicksText = summary.topPicks
      .map((p, i) => `${i + 1}. *${p.ticker}* - ${p.classification} (Attention: ${p.attention})`)
      .join('\n');

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':chart_with_upwards_trend: Scan Complete',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total Scanned:*\n${summary.totalScanned}` },
          { type: 'mrkdwn', text: `*Runners:*\n${summary.runners}` },
          { type: 'mrkdwn', text: `*Value Plays:*\n${summary.valuePlays}` },
          { type: 'mrkdwn', text: `*Alerts:*\n${summary.alerts}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Top Picks:*\n${topPicksText || 'None'}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Stock Screener | ${new Date().toLocaleString()}`,
          },
        ],
      } as any,
    ];

    const response = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Scan Complete',
        blocks,
      }),
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to send Slack summary:', error);
    return false;
  }
}

export default {
  sendSlackAlert,
  sendSlackSummary,
};
