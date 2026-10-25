export declare const BYBIT_HOST = "https://api.bybit.com";
/** Bybit's documented alternate mainnet host: the client moves to it after an HTTP 403 from the first (an edge block of the
    server's IP, 2026-10-23: `/v5/market/time` answered 403 to a cloud host for a while) and stays there for the process. */
export declare const BYBIT_FALLBACK_HOST = "https://api.bytick.com";
/** A request that gets no answer for this long is abandoned; the Bybit half then fails and the report says so. */
export declare const REQUEST_TIMEOUT_MS = 15000;
export declare class BybitError extends Error {
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    readonly status: number;
    /** Bybit's `retCode` (e.g. 10006 too many visits, 10003 invalid key). */
    readonly retCode?: number | undefined;
    constructor(message: string, 
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    status: number, 
    /** Bybit's `retCode` (e.g. 10006 too many visits, 10003 invalid key). */
    retCode?: number | undefined);
}
/** Bybit asks us to back off: retCode 10006 (endpoint limit) or HTTP 403 (the 600-per-5-s IP limit; the ban lifts after ~10 min). */
export declare function isBybitRateLimit(e: unknown): e is BybitError;
type Params = Record<string, string | number | undefined>;
export interface BybitClient {
    /** `GET` of a V5 endpoint; private paths are signed. Returns `result` of the envelope, throws `BybitError` on `retCode ≠ 0`. */
    get<T>(path: string, params?: Params): Promise<T>;
}
export declare function createBybitClient(apiKey: string, apiSecret: string, opts?: {
    host?: string;
    fallbackHost?: string | null;
    timeoutMs?: number;
}): BybitClient;
export interface BybitAccountInfo {
    unifiedMarginStatus: number;
    marginMode: 'REGULAR_MARGIN' | 'PORTFOLIO_MARGIN' | 'ISOLATED_MARGIN' | string;
    isMasterTrader: boolean;
    updatedTime?: string;
}
export interface BybitCoin {
    coin: string;
    equity: string;
    usdValue: string;
    walletBalance: string;
    unrealisedPnl: string;
    cumRealisedPnl: string;
    totalOrderIM: string;
    totalPositionIM: string;
    totalPositionMM: string;
    bonus?: string;
}
export interface BybitWallet {
    accountType: string;
    totalEquity: string;
    totalWalletBalance: string;
    totalMarginBalance: string;
    totalAvailableBalance: string;
    totalPerpUPL: string;
    totalInitialMargin: string;
    totalMaintenanceMargin: string;
    coin: BybitCoin[];
}
export interface BybitPosition {
    symbol: string;
    side: 'Buy' | 'Sell' | '';
    size: string;
    avgPrice: string;
    positionValue: string;
    leverage: string;
    markPrice: string;
    liqPrice: string;
    positionIM: string;
    positionMM: string;
    takeProfit: string;
    stopLoss: string;
    trailingStop: string;
    unrealisedPnl: string;
    curRealisedPnl: string;
    cumRealisedPnl: string;
    adlRankIndicator: number;
    /** 0 one-way, 1 the buy side of hedge mode, 2 the sell side. */
    positionIdx: number;
    positionStatus: string;
    createdTime: string;
    updatedTime: string;
}
/** One row of /v5/account/transaction-log (Unified account). */
export interface BybitLogRow {
    id: string;
    symbol: string;
    category: string;
    side: string;
    transactionTime: string;
    type: string;
    qty: string;
    size: string;
    currency: string;
    tradePrice: string;
    /** Funding received (+) or paid (−). */
    funding: string;
    /** Trading fee charged (+ = expense, − = rebate). */
    fee: string;
    /** Realised PnL of the execution, a transfer's amount, a settlement's session PnL; excludes fee and funding. */
    cashFlow: string;
    /** = cashFlow + funding − fee. */
    change: string;
    cashBalance: string;
    feeRate: string;
    bonusChange: string;
    tradeId: string;
    orderId: string;
    orderLinkId: string;
}
/** One fill of /v5/execution/list. */
export interface BybitExecution {
    symbol: string;
    orderId: string;
    orderLinkId: string;
    side: 'Buy' | 'Sell';
    orderPrice: string;
    orderQty: string;
    leavesQty: string;
    createType?: string;
    orderType: string;
    stopOrderType: string;
    execFee: string;
    execId: string;
    execPrice: string;
    execQty: string;
    /** Trade, AdlTrade, BustTrade, Delivery, Funding, Settle, … */
    execType: string;
    execValue: string;
    execTime: string;
    feeCurrency?: string;
    isMaker: boolean;
    feeRate: string;
    markPrice: string;
    closedSize: string;
}
/** One order of /v5/order/realtime (resting and untriggered conditional ones). */
export interface BybitOrder {
    orderId: string;
    orderLinkId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit' | string;
    price: string;
    qty: string;
    cumExecQty: string;
    leavesQty: string;
    orderStatus: string;
    /** '' for a plain order; TakeProfit, StopLoss, PartialTakeProfit, PartialStopLoss, Stop, TrailingStop, … */
    stopOrderType: string;
    triggerPrice: string;
    takeProfit: string;
    stopLoss: string;
    reduceOnly: boolean;
    closeOnTrigger: boolean;
    positionIdx: number;
    timeInForce: string;
    createdTime: string;
    updatedTime: string;
}
export interface BybitRaw {
    /** Clock of the collection. */
    now: number;
    info: BybitAccountInfo | null;
    wallet: BybitWallet;
    positions: BybitPosition[];
    /** Every row since `from` (all categories: transfers carry none). */
    log: BybitLogRow[];
    /** Every fill since `tradesFrom`. */
    executions: BybitExecution[];
    orders: BybitOrder[];
    warnings: string[];
}
export interface CollectBybitOptions {
    /** Transaction log from here (the income look-back, clamped at the data cut-off by the caller). */
    from: number;
    /** Fills from here (the trades look-back). */
    tradesFrom: number;
    now: number;
    /** Settlement coin of the linear contracts; USDT. */
    settleCoin?: string;
}
/**
 * All Bybit I/O for one report. The wallet and the positions are required (like Binance's account and positionRisk);
 * the account info and the open orders are optional and only leave a warning when they fail.
 */
export declare function collectBybitRaw(client: BybitClient, opts: CollectBybitOptions): Promise<BybitRaw>;
export {};
