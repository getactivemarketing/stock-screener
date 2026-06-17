import OpenAI from 'openai';

/** Strip markdown fences / prose and parse the first JSON object. Returns null on failure. */
export function parseJSONResponse(text: string): unknown | null {
  if (!text) return null;
  let t = text.trim();
  // strip ```json ... ``` or ``` ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through to embedded-object extraction
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ask Perplexity (sonar) for a JSON answer. Returns parsed object or null.
 * `apiKey` is passed in by the caller (route reads it from env) for testability.
 */
export async function askPerplexityJSON(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000
): Promise<unknown | null> {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' });
  try {
    const res = await client.chat.completions.create({
      model: 'sonar',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    return parseJSONResponse(res.choices[0]?.message?.content || '');
  } catch (err) {
    console.error('[perplexity] request failed:', err);
    return null;
  }
}

export const JSON_SYSTEM_PROMPT =
  'You are a professional equity analyst. Respond ONLY with valid JSON matching the requested schema, no markdown fences, no commentary.';
