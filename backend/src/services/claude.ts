// backend/src/services/claude.ts
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ClaudeCallOptions {
  model: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface ClaudeCallResult<T> {
  parsed: T | null;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  model: string;
  error?: string;
}

// Per-million-token pricing (USD). Update when models change.
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
};

export function estimateCostUsd(r: ClaudeCallResult<unknown>): number {
  const p = PRICING[r.model];
  if (!p) return 0;
  return (
    (r.inputTokens / 1_000_000) * p.input +
    (r.outputTokens / 1_000_000) * p.output +
    (r.cacheReadTokens / 1_000_000) * p.cacheRead +
    (r.cacheCreationTokens / 1_000_000) * p.cacheWrite
  );
}

export async function callClaudeJson<T>(opts: ClaudeCallOptions): Promise<ClaudeCallResult<T>> {
  const started = Date.now();
  try {
    const res = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.2,
      system: [
        {
          type: 'text',
          text: opts.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: opts.userPrompt }],
    });
    const raw =
      res.content[0]?.type === 'text' ? res.content[0].text : '';
    let parsed: T | null = null;
    let parseError: string | undefined;
    try {
      // Strip any markdown fences the model added despite instructions.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned) as T;
    } catch (e) {
      parseError = `JSON parse failed: ${(e as Error).message}`;
    }
    const result: ClaudeCallResult<T> = {
      parsed,
      raw,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: res.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
      model: opts.model,
      error: parseError,
    };
    const cost = estimateCostUsd(result);
    console.log(
      `[claude] model=${opts.model} in=${result.inputTokens} out=${result.outputTokens} ` +
      `cacheR=${result.cacheReadTokens} cacheW=${result.cacheCreationTokens} ` +
      `latency=${result.latencyMs}ms cost=$${cost.toFixed(4)}` +
      (parseError ? ` parseError="${parseError}"` : '')
    );
    return result;
  } catch (e) {
    const err = (e as Error).message;
    const result: ClaudeCallResult<T> = {
      parsed: null,
      raw: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: Date.now() - started,
      model: opts.model,
      error: err,
    };
    console.error(`[claude] model=${opts.model} ERROR: ${err}`);
    return result;
  }
}
