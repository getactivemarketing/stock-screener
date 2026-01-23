import { config } from '../../lib/config.js';

interface EmailAlert {
  subject: string;
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
}

/**
 * Send email alert using SendGrid
 */
export async function sendEmailAlert(alert: EmailAlert): Promise<boolean> {
  if (!config.sendgridApiKey || !config.alertEmail) {
    console.log('Email notifications not configured (missing SENDGRID_API_KEY or ALERT_EMAIL)');
    return false;
  }

  try {
    const htmlContent = generateEmailHtml(alert);
    const textContent = generateEmailText(alert);

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.sendgridApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: config.alertEmail }],
          },
        ],
        from: { email: 'alerts@stockscreener.app', name: 'Stock Screener' },
        subject: alert.subject,
        content: [
          { type: 'text/plain', value: textContent },
          { type: 'text/html', value: htmlContent },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('SendGrid error:', error);
      return false;
    }

    console.log(`Email alert sent for ${alert.ticker}`);
    return true;
  } catch (error) {
    console.error('Failed to send email alert:', error);
    return false;
  }
}

/**
 * Generate HTML email content
 */
function generateEmailHtml(alert: EmailAlert): string {
  const classificationColor = getClassificationColor(alert.classification);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 8px; padding: 24px; }
    .header { text-align: center; margin-bottom: 24px; }
    .ticker { font-size: 32px; font-weight: bold; color: #fff; }
    .badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: bold; color: #fff; background: ${classificationColor}; margin-top: 8px; }
    .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0; }
    .score-box { text-align: center; padding: 12px; background: #0f172a; border-radius: 8px; }
    .score-value { font-size: 24px; font-weight: bold; }
    .score-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; }
    .targets { display: flex; gap: 20px; justify-content: center; margin: 20px 0; }
    .target { text-align: center; }
    .target-value { font-size: 20px; font-weight: bold; }
    .target-label { font-size: 12px; color: #94a3b8; }
    .positive { color: #22c55e; }
    .negative { color: #ef4444; }
    .analysis { margin-top: 24px; }
    .analysis h3 { font-size: 14px; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px; }
    .analysis p { margin: 0 0 16px; }
    .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="ticker">${alert.ticker}</div>
      <div class="badge">${alert.classification.toUpperCase()}</div>
      <div style="margin-top: 8px; color: #94a3b8;">
        $${alert.price.toFixed(2)}
      </div>
    </div>

    <div class="scores">
      <div class="score-box">
        <div class="score-value">${alert.scores.attention}</div>
        <div class="score-label">Attention</div>
      </div>
      <div class="score-box">
        <div class="score-value">${alert.scores.momentum}</div>
        <div class="score-label">Momentum</div>
      </div>
      <div class="score-box">
        <div class="score-value">${alert.scores.fundamentals}</div>
        <div class="score-label">Fundamentals</div>
      </div>
      <div class="score-box">
        <div class="score-value">${alert.scores.risk}</div>
        <div class="score-label">Risk</div>
      </div>
    </div>

    ${alert.targetPrice || alert.stopLoss ? `
    <div class="targets">
      ${alert.targetPrice ? `
      <div class="target">
        <div class="target-value positive">$${alert.targetPrice.toFixed(2)}</div>
        <div class="target-label">Target Price</div>
      </div>
      ` : ''}
      ${alert.stopLoss ? `
      <div class="target">
        <div class="target-value negative">$${alert.stopLoss.toFixed(2)}</div>
        <div class="target-label">Stop Loss</div>
      </div>
      ` : ''}
    </div>
    ` : ''}

    <div class="analysis">
      <h3 style="color: #22c55e;">Bull Case</h3>
      <p>${alert.bullCase}</p>

      <h3 style="color: #ef4444;">Bear Case</h3>
      <p>${alert.bearCase}</p>
    </div>

    <div class="footer">
      Stock Screener Alert - ${new Date().toLocaleString()}
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate plain text email content
 */
function generateEmailText(alert: EmailAlert): string {
  return `
STOCK SCREENER ALERT: ${alert.ticker}
================================

Classification: ${alert.classification.toUpperCase()}
Price: $${alert.price.toFixed(2)}

SCORES
- Attention: ${alert.scores.attention}
- Momentum: ${alert.scores.momentum}
- Fundamentals: ${alert.scores.fundamentals}
- Risk: ${alert.scores.risk}

${alert.targetPrice ? `Target Price: $${alert.targetPrice.toFixed(2)}` : ''}
${alert.stopLoss ? `Stop Loss: $${alert.stopLoss.toFixed(2)}` : ''}

BULL CASE
${alert.bullCase}

BEAR CASE
${alert.bearCase}

---
Stock Screener Alert - ${new Date().toLocaleString()}
  `.trim();
}

/**
 * Get color for classification badge
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

export default {
  sendEmailAlert,
};
