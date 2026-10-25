/** A request that gets no answer for this long is abandoned; the report build then fails instead of hanging. */
export declare const REQUEST_TIMEOUT_MS = 15000;
export declare class BinanceError extends Error {
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    readonly status: number;
    /** Binance's own error code from the response body (e.g. -1003, -1021). */
    readonly code?: number | undefined;
    /** `Retry-After` seconds Binance sent along with the error (429 / 418), when it did. */
    readonly retryAfterSeconds?: number | undefined;
    constructor(message: string, 
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    status: number, 
    /** Binance's own error code from the response body (e.g. -1003, -1021). */
    code?: number | undefined, 
    /** `Retry-After` seconds Binance sent along with the error (429 / 418), when it did. */
    retryAfterSeconds?: number | undefined);
}
/**
 * Binance asks us to back off: HTTP 429, HTTP 418 (IP ban) or code -1003 (request weight exceeded).
 * Retrying such a request only lengthens the ban, so nothing here retries it.
 */
export declare function isRateLimit(e: unknown): e is BinanceError;
type Params = Record<string, string | number | undefined>;
export interface BinanceClient {
    /** Public endpoint, no signature. */
    public<T>(path: string, params?: Params): Promise<T>;
    /** USER_DATA endpoint, HMAC-SHA256 signed. */
    signed<T>(path: string, params?: Params): Promise<T>;
    /** Last `X-MBX-USED-WEIGHT-1M` seen (IP weight used in the current minute, limit 2400). */
    usedWeight(): number;
}
export declare function createClient(apiKey: string, apiSecret: string, opts?: {
    timeoutMs?: number;
}): BinanceClient;
/**
 * Run `fn` over `items` with at most `limit` in flight. Once one job has rejected no further job is
 * started (the ones already in flight finish, their results are dropped) and the first error is thrown.
 */
export declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>;
/** Pauses between the attempts of `withRetry`: two retries, 500 ms then 1 500 ms. */
export declare const RETRY_DELAYS_MS: readonly number[];
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
export declare function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
/**
 * Binance's IP budget is 2400 weight per UTC minute (shared with routes/symbols.ts
 * on this host). Above `threshold`, wait for the next minute before the next
 * burst (a cold 89-day userTrades walk is ≈ 1 800 weight).
 */
export declare function weightGuard(client: BinanceClient, threshold?: number, sleep?: (ms: number) => Promise<void>): Promise<void>;
export {};
