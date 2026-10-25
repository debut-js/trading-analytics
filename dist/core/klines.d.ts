import { type RateFn } from './analytics.js';
import type { BinanceClient } from './binance.js';
export interface BnbRates {
    /** Close of the latest known day (0 when nothing is known). */
    current: number;
    /** 'YYYY-MM-DD' (UTC open time) → close. */
    daily: Record<string, number>;
    source: 'klines' | 'last-good' | 'none';
    fetchedAt: number | null;
}
/** GET /fapi/v1/klines?symbol=BNBUSDT&interval=1d&limit=<limit> (public, weight 1) → { 'YYYY-MM-DD': close }. */
export declare function fetchBnbDailyCloses(client: BinanceClient, limit?: number): Promise<Record<string, number>>;
/** `current` = close of the max key; source 'klines'. */
export declare function bnbRatesFromCloses(daily: Record<string, number>, now: number): BnbRates;
export interface KlinesStore {
    /**
     * Fetch; on success source = 'klines' and null is returned. On failure the
     * previous closes are kept (source 'last-good') or, before any success,
     * source = 'none'. Returns a warning string prefixed `klines: ` or null. Never throws.
     */
    refresh(client: BinanceClient, now: number): Promise<string | null>;
    get(): BnbRates;
}
export declare function createKlinesStore(): KlinesStore;
/**
 * Resolution: 'USDT' → 1; 'BNB' → bnb.daily[day] ?? close of the latest daily
 * key ≤ day ?? (bnb.current > 0 ? bnb.current : undefined); anything else → others[asset].
 */
export declare function makeRateFn(bnb: BnbRates, others?: Record<string, number>): RateFn;
