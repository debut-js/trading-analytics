export type SourceKey = 'binance' | 'bybit';
export type ReportSource = 'all' | SourceKey;
export declare const SOURCE_KEYS: readonly SourceKey[];
export declare const REPORT_SOURCES: readonly ReportSource[];
export declare const SOURCE_LABELS: Record<SourceKey, string>;
export declare const isSourceKey: (s: unknown) => s is SourceKey;
export declare const isReportSource: (s: unknown) => s is ReportSource;
/** Records written before the second source existed carry no `source`; they are Binance's. */
export declare const sourceOf: (r: {
    source?: SourceKey;
}) => SourceKey;
/** How one source fared in the last collection; `report.sources` carries it with the balances. */
export interface SourceStatus {
    key: SourceKey;
    /** The keys are set. */
    configured: boolean;
    /** The collection succeeded; false = the report is served without this source and meta.warnings says why. */
    ok: boolean;
    error: string | null;
}
