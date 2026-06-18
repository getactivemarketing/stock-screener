import { describe, it, expect } from 'vitest';
import { parseJSONResponse } from './perplexity';

describe('parseJSONResponse', () => {
  it('parses clean JSON', () => {
    expect(parseJSONResponse('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(parseJSONResponse('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('strips bare ``` fences', () => {
    expect(parseJSONResponse('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });
  it('extracts the first JSON object embedded in prose', () => {
    expect(parseJSONResponse('Here you go: {"a":4} cheers')).toEqual({ a: 4 });
  });
  it('returns null on unparseable input', () => {
    expect(parseJSONResponse('not json at all')).toBeNull();
  });
});
