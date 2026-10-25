import { type DailyPoint, type IncomeRecord, type RateFn, type UserTrade } from './analytics.js';
import { type SourceKey } from './sources.js';
export interface Trip {
    symbol: string;
    /** The exchange: trips never span sources, a symbol traded on both gives two trips. */
    source: SourceKey;
    /** The symbol's leverage setting on the anchor row; null when the row is missing (flat symbol on Bybit) or unset. */
    leverage: number | null;
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    direction: 'long' | 'short';
    entryTime: number;
    exitTime: number | null;
    holdMin: number | null;
    entryVwap: number;
    exitVwap: number | null;
    /** max |pos| during the trip */
    qty: number;
    /** Σ quoteQty of opening legs / closing legs / opening legs filled as taker */
    entryNotional: number;
    exitNotional: number;
    entryTakerNotional: number;
    /** Σ realizedPnl; a flip fill's realizedPnl goes entirely to the trip it closes (Binance books it on the reduced part only, §3.2 step 3) */
    gross: number;
    /** POSITIVE magnitude: Σ commission × rate(commissionAsset, dayKey(fill.time)) */
    fees: number;
    /** Σ FUNDING_FEE of the symbol with time ∈ [entryTime, exitTime ?? now], signed as Binance gives it */
    funding: number;
    /** gross − fees + funding */
    net: number;
    /** net / entryNotional (fraction); 0 when entryNotional = 0 (truncated trip with no in-window entry legs) */
    retNotional: number;
    equityAtEntry: number;
    /** entryNotional / equityAtEntry; null when equityAtEntry ≤ 0 */
    sizeX: number | null;
    legs: {
        entry: 'M' | 'T' | 'mixed';
        exit: 'M' | 'T' | 'mixed' | null;
    };
    fills: number;
    truncated: boolean;
    status: 'closed' | 'open';
    r: number | null;
}
export interface TripsInput {
    trades: UserTrade[];
    /** UNFILTERED positionRisk (anchor); Bybit rows carry `source: 'bybit'` and list open positions only */
    positions: {
        symbol: string;
        positionSide: string;
        positionAmt: string;
        source?: SourceKey;
        leverage?: string;
    }[];
    /** any records; the module picks FUNDING_FEE */
    income: IncomeRecord[];
    rate: RateFn;
    daily: DailyPoint[];
    hedgeMode: boolean;
    now: number;
}
export interface TripsResult {
    trips: Trip[];
    warnings: string[];
}
/** Balance at the end of the previous day + transfers of the entry day; 0 when the day is not in `daily`. */
export declare function equityAtEntry(daily: DailyPoint[], entryTime: number): number;
/** §3.2. Key = `${source}|${symbol}`, plus `|${positionSide}` in hedge mode (or for a fill with a side, Bybit's hedge mode). Output: open trips first (entryTime desc), then closed by exitTime desc. */
export declare function reconstructTrips(input: TripsInput): TripsResult;
/** Breakeven = net rounds to 0 cents (§3.2 step 7): not a win, not a loss, still in the win-rate denominator. */
export declare function tripOutcome(t: Trip): 'win' | 'loss' | 'breakeven';
/** Statistics run only over closed, untruncated trips (§3.2 step 6). */
export declare function isCounted(t: Trip): boolean;
/** 1R = median |retNotional| over counted losers (§3.1 "1R"); null when there are none. */
export declare function oneROf(trips: Trip[]): number | null;
/** t.r = retNotional / oneR for counted trips, null otherwise (mutates). */
export declare function assignR(trips: Trip[], oneR: number | null): void;
