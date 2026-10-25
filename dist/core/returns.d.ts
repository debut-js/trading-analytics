import { type DailyPoint, type IncomeRecord, type RateFn } from './analytics.js';
export interface DayCash {
    date: string;
    net: number;
    transfers: number;
    balance: number;
}
/** zero rule: with V₀ = 0 the weighted flows must reach max($10, 2·|Σnet|). */
export declare const ZERO_RULE_MIN = 10;
/** guard: a sub-period opening below $10 is skipped (counted in `skipped`). */
export declare const TWR_MIN_BALANCE = 10;
/**
 * Modified Dietz: R = Σnet / (V₀ + Σ wᵢ·Fᵢ) with wᵢ = (T − i)/T,
 * i = 0-based day index, T = days.length (transfers land at the start of their day).
 * V₀ = 0 is allowed only when Σwᵢ·Fᵢ ≥ max($10, 2·|Σnet|); any denominator ≤ 0 → null.
 */
export declare function modifiedDietz(days: DayCash[], v0: number): number | null;
export interface TwrResult {
    twr: number | null;
    subPeriods: number;
    skipped: number;
}
/**
 * Sub-period TWR: records inside [from, to] in (time, tranId) order;
 * every flow (and non-trading bonus — capital, not performance) closes the
 * running sub-period: r_k = Σnet_k / balanceAtStart_k. Sub-periods with
 * balanceAtStart < $10 and net ≠ 0 are skipped (counted); empty ones (net = 0)
 * are dropped silently. twr = Π(1 + r_k) − 1, null when no sub-period survived.
 */
export declare function subPeriodTwr(records: IncomeRecord[], rate: RateFn, opts: {
    from: number;
    to: number;
    startBalance: number;
}): TwrResult;
/** Last day i ≥ 1 whose deposit is ≥ 20 % of the previous day's closing balance. */
export declare function detectCapitalStep(daily: DailyPoint[]): {
    index: number;
    date: string;
    amount: number;
} | null;
