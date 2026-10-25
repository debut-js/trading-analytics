import type { UserTrade } from './analytics.js';
import { type BinanceClient, type RetryOptions } from './binance.js';
export declare const DAY = 86400000;
export declare const WEEK: number;
/** 00:00:00.000 UTC of the Monday on or before `t`. */
export declare function mondayUtc(t: number): number;
export interface TradesCache {
    get(symbol: string, sliceStart: number): UserTrade[] | undefined;
    set(symbol: string, sliceStart: number, rows: UserTrade[], now: number): void;
    stats(): {
        slices: number;
        oldestSliceStart: number | null;
        bytes: number;
    };
    prune(now: number): void;
}
export declare function createTradesCache(opts?: {
    maxBytes?: number;
    maxAgeMs?: number;
}): TradesCache;
/**
 * One userTrades request; a saturated page (1000 rows) is split until every slice fits.
 * Every request is retried twice (500 ms, 1 500 ms) unless Binance rate-limits us, so a blip does not cost the report its fills;
 * a request that still fails rejects, and so does the whole window — never a silently shorter one.
 */
export declare function fetchTradesWindow(client: BinanceClient, symbol: string, start: number, end: number, retry?: RetryOptions): Promise<UserTrade[]>;
/**
 * Fills of `symbols` inside [from, to], fetched in Monday-aligned 7-day slices.
 * Closed slices (sliceEnd < now) come from `cache` when present; the slice that
 * contains `now` is always refetched (and never stored).
 * Rejects as soon as one slice cannot be fetched even after its retries (`retry` is for tests);
 * the slices still waiting are then never requested.
 */
export declare function fetchTradesSliced(client: BinanceClient, cache: TradesCache | null, symbols: string[], from: number, to: number, now: number, retry?: RetryOptions): Promise<UserTrade[]>;
