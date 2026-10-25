import { type UserTrade } from './analytics.js';
import type { Trip } from './trips.js';
export interface DayUsage {
    /** Highest initial margin of the day ($) and the open size at that moment ($). */
    peakIM: number;
    peakN: number;
    /** Time-weighted average initial margin over the day ($) and the average open size ($). */
    avgIM: number;
    avgN: number;
}
/**
 * `fills` in any order; `trips` give each coin's leverage (a coin without one takes the usual leverage of the account);
 * `from` is where the fill history starts (nothing is known before it), `now` the end of the last day.
 */
export declare function usageDaily(fills: UserTrade[], trips: Trip[], from: number, now: number): Record<string, DayUsage>;
