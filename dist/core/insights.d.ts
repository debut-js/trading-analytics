import type { PeriodRow } from './periods.js';
import type { WindowStats } from './windows.js';
export type InsightKey = 'hero' | 'periods' | 'drawdown' | 'structure' | 'a1' | 'a2' | 'a3' | 'a4';
export type Insights = Record<InsightKey, string>;
/** Same shape as report.ts `Capital['step']` (S-E imports this type). */
export interface CapitalStep {
    date: string;
    amount: number;
    netSince: number;
    returnSince: number | null;
    daysSince: number;
    preNet: number;
}
export interface InsightsInput {
    /** The selected window — hero, periods, drawdown, structure. */
    window: WindowStats;
    /** The appendix window (30d when 7d is selected) — a1…a4. */
    appendix: WindowStats;
    monthly: PeriodRow[];
    step: CapitalStep | null;
    inceptionDate: string;
    historyCapped: boolean;
    now: number;
}
type Ctx = Pick<InsightsInput, 'inceptionDate' | 'historyCapped'>;
/** `30 d of fills` when the fills window is shorter than the window, else `32 d`. */
export declare function windowChip(ws: WindowStats): string;
/** Neutral caption: `Since 9 Sep · 32 days · 236 trades` / `Last 30 days · 236 trades`. */
export declare function fallbackInsight(ws: WindowStats, ctx: Ctx): string;
export declare function buildInsights(input: InsightsInput): Insights;
export {};
