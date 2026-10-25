import type { IncomeRecord, UserTrade } from './analytics.js';
import type { BybitExecution, BybitLogRow, BybitOrder, BybitPosition, BybitRaw } from './bybit.js';
import type { RawAccount, RawOrder, RawPosition } from './report.js';
/** Stable 53-bit integer of a string (two FNV-1a passes): Bybit ids are UUID-like strings, the record types want numbers. */
export declare function hash53(s: string): number;
export interface BybitMapped {
    account: RawAccount;
    positions: RawPosition[];
    income: IncomeRecord[];
    trades: UserTrade[];
    orders: RawOrder[];
    adl: {
        symbol: string;
        adlQuantile: Record<string, number>;
    }[];
    /** From the account's margin mode (REGULAR / PORTFOLIO = cross). */
    marginType: 'cross' | 'isolated';
    isMasterTrader: boolean | null;
    warnings: string[];
}
/** The transaction log as Binance income records. */
export declare function mapBybitIncome(log: BybitLogRow[]): IncomeRecord[];
/** The fills, with the realised PnL joined from the log by `tradeId`; `id` = rank in time order (the trips sort by it). */
export declare function mapBybitFills(executions: BybitExecution[], log: BybitLogRow[], warnings: string[]): UserTrade[];
export declare function mapBybitPositions(positions: BybitPosition[], marginType: 'cross' | 'isolated'): RawPosition[];
/**
 * Open orders as /openOrders rows: a conditional one carries its trigger as the stop price and `closePosition` when it
 * closes on trigger. A position's own take profit / stop loss that has no conditional order of its kind resting becomes a
 * synthetic close-all order, so the positions table shows it like Binance's close-all stops.
 */
export declare function mapBybitOrders(orders: BybitOrder[], positions: BybitPosition[]): RawOrder[];
/** The Unified wallet as a Binance futures account: USD totals, the coins as assets. */
export declare function mapBybitAccount(raw: BybitRaw): RawAccount;
/** Bybit contracts named differently from Binance's for the same coin. */
export declare const BYBIT_SYMBOL_ALIAS: Record<string, string>;
export declare function mapBybit(input: BybitRaw): BybitMapped;
