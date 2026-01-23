import { config } from '../../lib/config.js';

interface DiscordAlert {
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

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
  };
  timestamp?: string;
}

/**
 * Send Discord webhook alert
 */
export async function sendDiscordAlert(alert: DiscordAlert): Promise<boolean> {
  if (!config.discordWebhookUrl) {
    console.log('Discord notifications not configured (missing DISCORD_WEBHOOK_URL)');
    return false;
  }

  try {
    const embed = createDiscordEmbed(alert);

    const response = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'Stock Screener',
        avatar_url: 'https://via.placeholder.com/128/22c55e/ffffff?text=SS',
        embeds: [embed],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Discord webhook error:', error);
      return false;
    }

    console.log(`Discord alert sent for ${alert.ticker}`);
    return true;
  } catch (error) {
    console.error('Failed to send Discord alert:', error);
    return false;
  }
}

/**
 * Create Discord embed for alert
 */
function createDiscordEmbed(alert: DiscordAlert): DiscordEmbed {
  const classificationEmoji = getClassificationEmoji(alert.classification);
  const color = getClassificationColorInt(alert.classification);

  const fields: DiscordEmbed['fields'] = [
    { name: 'Price', value: `$${alert.price.toFixed(2)}`, inline: true },
    { name: 'Classification', value: `${classificationEmoji} ${alert.classification.toUpperCase()}`, inline: true },
    { name: '\u200B', value: '\u200B', inline: true }, // Empty field for alignment
    { name: 'Attention', value: `${alert.scores.attention}/100`, inline: true },
    { name: 'Momentum', value: `${alert.scores.momentum}/100`, inline: true },
    { name: 'Risk', value: `${alert.scores.risk}/100`, inline: true },
  ];

  // Add target price if available
  if (alert.targetPrice) {
    const upside = ((alert.targetPrice - alert.price) / alert.price * 100).toFixed(1);
    fields.push({
      name: 'Target Price',
      value: `$${alert.targetPrice.toFixed(2)} (${upside}%)`,
      inline: true,
    });
  }

  // Add stop loss if available
  if (alert.stopLoss) {
    const downside = ((alert.stopLoss - alert.price) / alert.price * 100).toFixed(1);
    fields.push({
      name: 'Stop Loss',
      value: `$${alert.stopLoss.toFixed(2)} (${downside}%)`,
      inline: true,
    });
  }

  // Add technical signal if available
  if (alert.technicalSignal) {
    fields.push({
      name: 'Technical Signal',
      value: alert.technicalSignal.toUpperCase(),
      inline: true,
    });
  }

  // Add bull/bear case (truncated for Discord)
  const maxLen = 250;
  fields.push({
    name: 'Bull Case',
    value: alert.bullCase.length > maxLen ? alert.bullCase.substring(0, maxLen) + '...' : alert.bullCase,
    inline: false,
  });

  fields.push({
    name: 'Bear Case',
    value: alert.bearCase.length > maxLen ? alert.bearCase.substring(0, maxLen) + '...' : alert.bearCase,
    inline: false,
  });

  return {
    title: `${classificationEmoji} ${alert.ticker} - ${alert.alertType.toUpperCase()} Alert`,
    color,
    fields,
    footer: {
      text: 'Stock Screener',
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get emoji for classification
 */
function getClassificationEmoji(classification: string): string {
  switch (classification) {
    case 'runner':
      return '🚀';
    case 'value':
      return '💎';
    case 'both':
      return '⭐';
    case 'avoid':
      return '⚠️';
    default:
      return '👀';
  }
}

/**
 * Get Discord color integer for classification
 */
function getClassificationColorInt(classification: string): number {
  switch (classification) {
    case 'runner':
      return 0x22c55e; // Green
    case 'value':
      return 0x3b82f6; // Blue
    case 'both':
      return 0xa855f7; // Purple
    case 'avoid':
      return 0xef4444; // Red
    default:
      return 0xeab308; // Yellow
  }
}

/**
 * Send a batch summary to Discord
 */
export async function sendDiscordSummary(summary: {
  totalScanned: number;
  runners: number;
  valuePlays: number;
  alerts: number;
  topPicks: Array<{ ticker: string; classification: string; attention: number }>;
}): Promise<boolean> {
  if (!config.discordWebhookUrl) {
    return false;
  }

  try {
    const topPicksText = summary.topPicks
      .map((p, i) => `${i + 1}. **${p.ticker}** - ${p.classification} (Attention: ${p.attention})`)
      .join('\n');

    const embed: DiscordEmbed = {
      title: '📊 Scan Complete',
      description: `Scanned ${summary.totalScanned} tickers`,
      color: 0x3b82f6,
      fields: [
        { name: 'Runners', value: `${summary.runners}`, inline: true },
        { name: 'Value Plays', value: `${summary.valuePlays}`, inline: true },
        { name: 'Alerts', value: `${summary.alerts}`, inline: true },
        { name: 'Top Picks', value: topPicksText || 'None', inline: false },
      ],
      footer: { text: 'Stock Screener' },
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stock Screener',
        embeds: [embed],
      }),
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to send Discord summary:', error);
    return false;
  }
}

export default {
  sendDiscordAlert,
  sendDiscordSummary,
};
