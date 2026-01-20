import OpenAI from 'openai';
import { config } from '../lib/config.js';
import type {
  Scores,
  MergedSentiment,
  PriceData,
  FundamentalData,
  ClassificationResult,
  Classification,
} from '../types/index.js';

// Perplexity uses OpenAI-compatible API
const perplexity = new OpenAI({
  apiKey: config.perplexityApiKey,
  baseURL: 'https://api.perplexity.ai',
});

interface TickerContext {
  ticker: string;
  scores: Scores;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  preliminaryClassification: Classification;
}

/**
 * Use Perplexity to generate detailed analysis for a ticker
 */
export async function generateAnalysis(context: TickerContext): Promise<ClassificationResult> {
  const prompt = buildPrompt(context);

  try {
    const response = await perplexity.chat.completions.create({
      model: 'llama-3.1-sonar-small-128k-online',
      messages: [
        {
          role: 'system',
          content: 'You are a quantitative stock analyst. Respond only with valid JSON, no markdown or explanation.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    });

    const responseText = response.choices[0]?.message?.content || '';
    return parseResponse(responseText, context.preliminaryClassification);
  } catch (error) {
    console.error(`Perplexity analysis failed for ${context.ticker}:`, error);
    // Return a default response if Perplexity fails
    return {
      classification: context.preliminaryClassification,
      confidence: 0.5,
      bullCase: 'Analysis unavailable',
      bearCase: 'Analysis unavailable',
      catalysts: [],
    };
  }
}

function buildPrompt(context: TickerContext): string {
  const { ticker, scores, sentiment, price, fundamentals, preliminaryClassification } = context;

  return `Analyze this penny stock and provide a brief assessment.

TICKER: ${ticker}
COMPANY: ${fundamentals.name || 'Unknown'}
SECTOR: ${fundamentals.sector || 'Unknown'}
EXCHANGE: ${fundamentals.exchange || 'Unknown'}

COMPUTED SCORES (0-100):
- Attention Score: ${scores.attention} (social media buzz and sentiment)
- Momentum Score: ${scores.momentum} (price action and volume)
- Fundamentals Score: ${scores.fundamentals} (financial health)
- Risk Score: ${scores.risk} (pump & dump probability)

SENTIMENT DATA:
- Total Mentions: ${sentiment.totalMentions}
- Average Sentiment: ${sentiment.avgSentiment.toFixed(1)}
- Momentum (vs prior period): ${sentiment.maxMomentum.toFixed(2)}x
- Sources tracking: ${sentiment.sourceCount}

PRICE DATA:
- Current Price: $${price.price.toFixed(2)}
- 1-Day Change: ${price.change1dPercent.toFixed(2)}%
- 5-Day Change: ${price.change5dPercent.toFixed(2)}%
- 30-Day Change: ${price.change30dPercent.toFixed(2)}%
- Relative Volume: ${price.relativeVolume.toFixed(2)}x average
- Distance from 52W High: ${(((price.high52w - price.price) / price.high52w) * 100).toFixed(1)}%

FUNDAMENTALS:
- Market Cap: $${formatMarketCap(fundamentals.marketCap)}
- P/E Ratio: ${fundamentals.peRatio ?? 'N/A'}
- Revenue Growth: ${fundamentals.revenueGrowth ? fundamentals.revenueGrowth.toFixed(1) + '%' : 'N/A'}
- Gross Margin: ${fundamentals.grossMargin ? fundamentals.grossMargin.toFixed(1) + '%' : 'N/A'}
- Debt/Equity: ${fundamentals.debtEquity ?? 'N/A'}

PRELIMINARY CLASSIFICATION: ${preliminaryClassification}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "classification": "runner" | "value" | "both" | "avoid" | "watch",
  "confidence": 0.0-1.0,
  "bullCase": "1-2 sentence bull case",
  "bearCase": "1-2 sentence bear case",
  "catalysts": ["catalyst1", "catalyst2"]
}`;
}

function parseResponse(response: string, fallbackClassification: Classification): ClassificationResult {
  try {
    // Extract JSON from response (handle markdown code blocks if present)
    let jsonStr = response.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      classification: validateClassification(parsed.classification) || fallbackClassification,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      bullCase: typeof parsed.bullCase === 'string' ? parsed.bullCase : 'Analysis unavailable',
      bearCase: typeof parsed.bearCase === 'string' ? parsed.bearCase : 'Analysis unavailable',
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.filter((c: unknown) => typeof c === 'string') : [],
    };
  } catch (error) {
    console.error('Failed to parse Perplexity response:', error);
    console.error('Raw response:', response);
    return {
      classification: fallbackClassification,
      confidence: 0.5,
      bullCase: 'Analysis parsing failed',
      bearCase: 'Analysis parsing failed',
      catalysts: [],
    };
  }
}

function validateClassification(value: unknown): Classification | null {
  const valid: Classification[] = ['runner', 'value', 'both', 'avoid', 'watch'];
  return valid.includes(value as Classification) ? (value as Classification) : null;
}

function formatMarketCap(value: number): string {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + 'B';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(2) + 'K';
  return value.toString();
}

export default {
  generateAnalysis,
};
