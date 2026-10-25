// The exchanges the dashboard reads. Every raw record, position, order and trip
// carries its `source`; `all` is the merged report. Kept in its own module so analytics.ts and report.ts can both import it.

export type SourceKey = 'binance' | 'bybit';
export type ReportSource = 'all' | SourceKey;

export const SOURCE_KEYS: readonly SourceKey[] = ['binance', 'bybit'];
export const REPORT_SOURCES: readonly ReportSource[] = ['all', 'binance', 'bybit'];
export const SOURCE_LABELS: Record<SourceKey, string> = { binance: 'Binance', bybit: 'Bybit' };

export const isSourceKey = (s: unknown): s is SourceKey => s === 'binance' || s === 'bybit';
export const isReportSource = (s: unknown): s is ReportSource => s === 'all' || isSourceKey(s);

/** Records written before the second source existed carry no `source`; they are Binance's. */
export const sourceOf = (r: { source?: SourceKey }): SourceKey => r.source ?? 'binance';

/** How one source fared in the last collection; `report.sources` carries it with the balances. */
export interface SourceStatus {
  key: SourceKey;
  /** The keys are set. */
  configured: boolean;
  /** The collection succeeded; false = the report is served without this source and meta.warnings says why. */
  ok: boolean;
  error: string | null;
}
