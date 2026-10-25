import { type DailyPoint } from './analytics.js';
import { type Trip } from './trips.js';
import type { DayRef } from './windows.js';
export interface PeriodRow {
    kind: 'week' | 'month';
    /** '2026-W37' / '2026-09' */
    key: string;
    /** 'W37' / 'Sep 2026' */
    label: string;
    /** max(period start, inception) */
    from: string;
    /** min(period end, today) */
    to: string;
    /** Number of daily rows inside the period (T of Modified Dietz). */
    days: number;
    /** Period end is after today — printed as `to date`. */
    toDate: boolean;
    net: number;
    /** Modified Dietz (fraction); null when the zero rule or a non-positive denominator forbids it. */
    ret: number | null;
    /** Σ commission, Binance sign (≤ 0). */
    fees: number;
    funding: number;
    realized: number;
    /** Counted trips (closed, not truncated) exiting inside the period; null while the fills window does not cover `from`. */
    trades: number | null;
    /** wins / trades (breakeven in the denominator); null when trades is null or 0. */
    winRate: number | null;
    /** Days with net > 0. */
    greenDays: number;
    /** Days with net ≠ 0. */
    activeDays: number;
    /** Positive magnitude: max(peak − cum) with cum restarting at 0 on the first day of the period. */
    maxDD: number;
    bestDay: DayRef | null;
    worstDay: DayRef | null;
}
export interface PeriodRange {
    key: string;
    label: string;
    from: string;
    to: string;
}
/** ISO-8601 week: weeks run Mon–Sun, week 1 is the one containing 4 January (equivalently, the first Thursday). */
export declare function isoWeek(day: string): {
    year: number;
    week: number;
};
/** Monday..Sunday (UTC) of the ISO week containing `day`. */
export declare function weekOf(day: string): PeriodRange;
/** 1st..last day (UTC) of the calendar month containing `day`. */
export declare function monthOf(day: string): PeriodRange;
export declare function buildPeriods(input: {
    daily: DailyPoint[];
    trips: Trip[];
    tradesFrom: string;
    now: number;
    /** Wallet balance at the start of `daily[0]` (default 0): the first period's V₀ when the income history is capped. */
    openingBalance?: number;
}): {
    weekly: PeriodRow[];
    monthly: PeriodRow[];
};
