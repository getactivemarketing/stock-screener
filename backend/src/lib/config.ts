import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  // Database
  databaseUrl: z.string().url(),

  // Sentiment APIs
  swaggyApiKey: z.string().optional(),
  altindexApiKey: z.string().optional(),

  // Market Data APIs
  alphaVantageApiKey: z.string().default(''),
  finnhubApiKey: z.string().default(''),
  polygonApiKey: z.string().optional(), // Optional: Enhanced options data

  // LLM (Perplexity)
  perplexityApiKey: z.string().default(''),

  // LLM (Anthropic) — for sector pass + veto layer
  anthropicApiKey: z.string().default(''),

  // Alerts (optional)
  slackWebhookUrl: z.string().url().optional().or(z.literal('')),
  discordWebhookUrl: z.string().url().optional().or(z.literal('')),
  sendgridApiKey: z.string().optional(),
  alertEmail: z.string().email().optional().or(z.literal('')),

  // Alpaca Trading (optional)
  alpacaApiKey: z.string().optional(),
  alpacaApiSecret: z.string().optional(),
  alpacaPaper: z.string().default('true'),

  // Runtime
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = configSchema.safeParse({
  databaseUrl: process.env.DATABASE_URL,
  swaggyApiKey: process.env.SWAGGY_API_KEY,
  altindexApiKey: process.env.ALTINDEX_API_KEY,
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
  finnhubApiKey: process.env.FINNHUB_API_KEY,
  polygonApiKey: process.env.POLYGON_API_KEY,
  perplexityApiKey: process.env.PERPLEXITY_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  alertEmail: process.env.ALERT_EMAIL,
  alpacaApiKey: process.env.ALPACA_API_KEY,
  alpacaApiSecret: process.env.ALPACA_API_SECRET,
  alpacaPaper: process.env.ALPACA_PAPER,
  nodeEnv: process.env.NODE_ENV || undefined,
});

if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

// Alert thresholds
export const alertConfig = {
  runner: {
    minAttention: 70,
    minMomentum: 70,
    maxRisk: 70,
  },
  value: {
    minFundamentals: 70,
    minMomentum: 30,
    maxMomentum: 70,
    maxRisk: 60,
  },
  pumpWarning: {
    minRisk: 80,
  },
};

// Universe filters
export const universeConfig = {
  maxPrice: 20, // Focus on stocks under $20
  maxMarketCap: Infinity, // No market cap limit
  allowedCountries: ['USA', 'United States', 'US'],
  allowedExchanges: [
    'NYSE',
    'NASDAQ',
    'NYSE ARCA',
    'NYSE MKT',
    'AMEX',
    'OTC',
    'OTCQX',
    'OTCQB',
    'PINK',
    'NEW YORK STOCK EXCHANGE, INC.',
    'NASDAQ NMS - GLOBAL MARKET',
    'NASDAQ CAPITAL MARKET',
    'NASDAQ/NGS (GLOBAL SELECT MARKET)',
    'NYSE AMERICAN, LLC',
  ],
  excludeETFs: true,
};
