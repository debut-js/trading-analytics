// The exchanges the dashboard reads. Every raw record, position, order and trip
// carries its `source`; `all` is the merged report. Kept in its own module so analytics.ts and report.ts can both import it.
export const SOURCE_KEYS = ['binance', 'bybit'];
export const REPORT_SOURCES = ['all', 'binance', 'bybit'];
export const SOURCE_LABELS = { binance: 'Binance', bybit: 'Bybit' };
export const isSourceKey = (s) => s === 'binance' || s === 'bybit';
export const isReportSource = (s) => s === 'all' || isSourceKey(s);
/** Records written before the second source existed carry no `source`; they are Binance's. */
export const sourceOf = (r) => r.source ?? 'binance';
