// backend/src/services/veto.ts
import { callClaudeJson } from './claude.js';
import {
  VETO_SYSTEM_PROMPT,
  buildVetoUserPrompt,
  parseVetoResponse,
  type VetoContext,
} from './veto-prompts.js';
import type { VetoResult } from '../types/index.js';

export interface VetoCallResult {
  result: VetoResult;          // never null — fail-open default is 'confirm'
  failed: boolean;              // true if Claude errored or returned bad JSON
  errorMessage?: string;
  model: string;
  latencyMs: number;
}

const FAIL_OPEN_RESULT: VetoResult = {
  verdict: 'confirm',
  confidence: 0,                // 0 confidence signals "this is the default, not a real verdict"
  reasoning: 'Veto call failed — defaulting to confirm (fail-open)',
  keyRisk: '',
  thesisContradictions: [],
};

export async function runVeto(ctx: VetoContext): Promise<VetoCallResult> {
  const userPrompt = buildVetoUserPrompt(ctx);
  const res = await callClaudeJson<unknown>({
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: VETO_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 600,
  });

  if (res.error || !res.parsed) {
    return {
      result: FAIL_OPEN_RESULT,
      failed: true,
      errorMessage: res.error ?? 'no parsed response',
      model: res.model,
      latencyMs: res.latencyMs,
    };
  }

  const parsed = parseVetoResponse(res.parsed);
  if (!parsed) {
    return {
      result: FAIL_OPEN_RESULT,
      failed: true,
      errorMessage: 'response did not match schema',
      model: res.model,
      latencyMs: res.latencyMs,
    };
  }

  return {
    result: parsed,
    failed: false,
    model: res.model,
    latencyMs: res.latencyMs,
  };
}
