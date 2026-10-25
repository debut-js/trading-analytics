// Minimal signed client for Binance USDⓈ-M Futures REST (read-only endpoints).
// Keys never leave this process: they sign requests server-side and the
// browser only ever receives the computed report.

import { createHmac } from 'node:crypto';

const BASE_URL = 'https://fapi.binance.com';

/** A request that gets no answer for this long is abandoned; the report build then fails instead of hanging. */
export const REQUEST_TIMEOUT_MS = 15_000;

export class BinanceError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    readonly status: number,
    /** Binance's own error code from the response body (e.g. -1003, -1021). */
    readonly code?: number,
    /** `Retry-After` seconds Binance sent along with the error (429 / 418), when it did. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Binance asks us to back off: HTTP 429, HTTP 418 (IP ban) or code -1003 (request weight exceeded).
 * Retrying such a request only lengthens the ban, so nothing here retries it.
 */
export function isRateLimit(e: unknown): e is BinanceError {
  return e instanceof BinanceError && (e.status === 418 || e.status === 429 || e.code === -1003);
}

const isAbort = (e: unknown): boolean => {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
};

type Params = Record<string, string | number | undefined>;

export interface BinanceClient {
  /** Public endpoint, no signature. */
  public<T>(path: string, params?: Params): Promise<T>;
  /** USER_DATA endpoint, HMAC-SHA256 signed. */
  signed<T>(path: string, params?: Params): Promise<T>;
  /** Last `X-MBX-USED-WEIGHT-1M` seen (IP weight used in the current minute, limit 2400). */
  usedWeight(): number;
}

function toQuery(params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.append(k, String(v));
  }
  return qs.toString();
}

export function createClient(apiKey: string, apiSecret: string, opts: { timeoutMs?: number } = {}): BinanceClient {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timeOffset = 0;
  let offsetSyncedAt = 0;
  let weight = 0;

  async function request<T>(path: string, query: string, headers: Record<string, string>): Promise<T> {
    let res: Response;
    let text: string;
    try {
      // One signal for the whole exchange, body included: a socket that stalls mid-response must not hang the build either.
      res = await fetch(`${BASE_URL}${path}${query ? `?${query}` : ''}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const w = Number(res.headers.get('x-mbx-used-weight-1m'));
      if (Number.isFinite(w) && w > 0) weight = w;
      text = await res.text();
    } catch (e) {
      if (isAbort(e)) throw new BinanceError(`Binance ${path}: no response within ${timeoutMs / 1000} s`, 0);
      throw e;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BinanceError(`Binance ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, undefined, retryAfterSeconds);
    }
    if (!res.ok) {
      const err = body as { code?: number; msg?: string };
      throw new BinanceError(`Binance ${path}: ${err.msg ?? res.statusText}`, res.status, err.code, retryAfterSeconds);
    }
    return body as T;
  }

  async function syncTime(): Promise<void> {
    // Signed requests are rejected (-1021) if our clock drifts past recvWindow.
    if (Date.now() - offsetSyncedAt < 10 * 60_000) return;
    const t = await request<{ serverTime: number }>('/fapi/v1/time', '', {});
    timeOffset = t.serverTime - Date.now();
    offsetSyncedAt = Date.now();
  }

  return {
    public: (path, params = {}) => request(path, toQuery(params), {}),
    async signed(path, params = {}) {
      await syncTime();
      const query = toQuery({ ...params, recvWindow: 10_000, timestamp: Date.now() + timeOffset });
      const signature = createHmac('sha256', apiSecret).update(query).digest('hex');
      return request(path, `${query}&signature=${signature}`, { 'X-MBX-APIKEY': apiKey });
    },
    usedWeight: () => weight,
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` over `items` with at most `limit` in flight. Once one job has rejected no further job is
 * started (the ones already in flight finish, their results are dropped) and the first error is thrown.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Pauses between the attempts of `withRetry`: two retries, 500 ms then 1 500 ms. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500];

export interface RetryOptions {
  /** Pause before retry n (default `RETRY_DELAYS_MS`); its length is the number of extra attempts. */
  delaysMs?: readonly number[];
  /** Injectable for tests (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`; if it throws, run it again after each pause of `delaysMs`, then rethrow the last error.
 * Rate limits (`isRateLimit`) are rethrown at once — retrying them extends the ban.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const delay = delays[attempt];
      if (delay === undefined || isRateLimit(e)) throw e;
      await sleep(delay);
    }
  }
}

/**
 * Binance's IP budget is 2400 weight per UTC minute (shared with routes/symbols.ts
 * on this host). Above `threshold`, wait for the next minute before the next
 * burst (a cold 89-day userTrades walk is ≈ 1 800 weight).
 */
export async function weightGuard(client: BinanceClient, threshold = 2000, sleep: (ms: number) => Promise<void> = sleepMs): Promise<void> {
  if (client.usedWeight() <= threshold) return;
  const now = Date.now();
  await sleep(60_000 - (now % 60_000) + 50);
}
