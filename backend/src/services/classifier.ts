import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import type {
  Scores,
  MergedSentiment,
  PriceData,
  FundamentalData,
  ClassificationResult,
  Classification,
} from '../types/index.js';

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
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
 * Use Claude to generate detailed analysis for a ticker
 */
export async function generateAnalysis(context: TickerContext): Promise<ClassificationResult> {
  const prompt = buildPrompt(context);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    return parseResponse(responseText, context.preliminaryClassification);
  } catch (error) {
    console.error(`Claude analysis failed for ${context.ticker}:`, error);
    // Return a default response if Claude fails
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

  return `You are a quantitative stock analyst. Analyze this penny stock and provide a brief assessment.

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

Respond with a JSON object containing:
{
  "classification": "runner" | "value" | "both" | "avoid" | "watch",
  "confidence": 0.0-1.0,
  "bullCase": "1-2 sentence bull case",
  "bearCase": "1-2 sentence bear case",
  "catalysts": ["catalyst1", "catalyst2"]
}

Be concise. Focus on actionable insights. If this looks like a pump-and-dump, say so clearly in the bear case.`;
}

function parseResponse(response: string, fallbackClassification: Classification): ClassificationResult {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      classification: validateClassification(parsed.classification) || fallbackClassification,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      bullCase: typeof parsed.bullCase === 'string' ? parsed.bullCase : 'Analysis unavailable',
      bearCase: typeof parsed.bearCase === 'string' ? parsed.bearCase : 'Analysis unavailable',
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.filter((c: unknown) => typeof c === 'string') : [],
    };
  } catch (error) {
    console.error('Failed to parse Claude response:', error);
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
