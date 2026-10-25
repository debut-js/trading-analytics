export interface Episode {
    peak: string;
    trough: string;
    recovered: string | null;
    /** peak − trough, positive magnitude */
    depth: number;
    /** depth / equityAtPeak (fraction); 0 when equityAtPeak ≤ 0 */
    depthPct: number;
    /** balance at the end of the peak day */
    equityAtPeak: number;
    /** trough − peak, calendar days */
    lengthDays: number;
    /** recovered − trough, calendar days; null while open */
    recoveryDays: number | null;
}
export interface DrawdownStats {
    maxAbs: number;
    maxPct: number;
    /** sorted by depth desc; the client shows the top 3 */
    episodes: Episode[];
    current: number;
    currentPct: number;
    daysSinceHigh: number;
    highDate: string;
    underwaterDays: number;
    /** √mean((dd_i / equityAtCurrentPeak_i)²) over ALL days of the window */
    ulcer: number;
    /** Σnet / maxAbs; null when maxAbs = 0 */
    recoveryFactor: number | null;
}
export interface DrawdownPoint {
    date: string;
    cum: number;
    net: number;
    balance: number;
}
export declare function drawdownStats(series: DrawdownPoint[]): DrawdownStats;
