// Simple fetch wrapper with retry and rate limiting

interface FetchOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private maxConcurrent: number,
    private minDelayMs: number
  ) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    setTimeout(() => {
      this.running--;
      const next = this.queue.shift();
      if (next) {
        this.running++;
        next();
      }
    }, this.minDelayMs);
  }
}

// Rate limiters for different APIs
export const rateLimiters = {
  alphaVantage: new RateLimiter(1, 12000), // 5 calls/min = 12s between calls
  finnhub: new RateLimiter(2, 1000), // 60 calls/min
  apewisdom: new RateLimiter(2, 500),
  swaggy: new RateLimiter(1, 1000),
  altindex: new RateLimiter(1, 1000),
};

export async function fetchWithRetry<T>(
  url: string,
  options: FetchOptions = {},
  rateLimiter?: RateLimiter
): Promise<T> {
  const { timeout = 10000, retries = 3, retryDelay = 1000, ...fetchOptions } = options;

  if (rateLimiter) {
    await rateLimiter.acquire();
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as T;

      if (rateLimiter) {
        rateLimiter.release();
      }

      return data;
    } catch (error) {
      lastError = error as Error;
      console.warn(`Fetch attempt ${attempt + 1} failed for ${url}:`, lastError.message);

      if (attempt < retries - 1) {
        await sleep(retryDelay * (attempt + 1));
      }
    }
  }

  if (rateLimiter) {
    rateLimiter.release();
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
