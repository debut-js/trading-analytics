import { type IncomeAnalytics, type IncomeRecord, type TradeAnalytics, type UserTrade } from './analytics.js';
import { type BinanceClient } from './binance.js';
import { type CapitalStep, type Insights } from './insights.js';
import { type BnbRates, type KlinesStore } from './klines.js';
import { type PeriodRow } from './periods.js';
import { type TradesCache } from './trades-cache.js';
import { type Trip } from './trips.js';
import { type WindowKey, type WindowStats } from './windows.js';
import { type CopyTrading } from './copy-trading.js';
import { type BybitClient } from './bybit.js';
import { type BybitMapped } from './bybit-map.js';
import { type DayUsage } from './usage.js';
import { type ReportSource, type SourceKey, type SourceStatus } from './sources.js';
/** Income history is retained for 3 months; stay a day inside the edge. */
export declare const INCOME_LOOKBACK_DAYS = 89;
export declare const DEFAULT_TITLE = "Futures account";
export interface RawAccount {
    totalWalletBalance: string;
    totalUnrealizedProfit: string;
    totalMarginBalance: string;
    totalInitialMargin: string;
    totalMaintMargin: string;
    totalPositionInitialMargin: string;
    totalOpenOrderInitialMargin: string;
    totalCrossWalletBalance: string;
    totalCrossUnPnl: string;
    availableBalance: string;
    maxWithdrawAmount: string;
    assets: {
        asset: string;
        walletBalance: string;
        unrealizedProfit: string;
        marginBalance: string;
        maintMargin: string;
        initialMargin: string;
        availableBalance: string;
        maxWithdrawAmount: string;
    }[];
}
export interface RawPosition {
    symbol: string;
    positionSide: string;
    positionAmt: string;
    entryPrice: string;
    breakEvenPrice?: string;
    markPrice: string;
    unRealizedProfit: string;
    liquidationPrice: string;
    leverage: string;
    marginType: string;
    isolatedMargin: string;
    notional: string;
    updateTime: number;
    /** The exchange; absent = Binance. */
    source?: SourceKey;
}
export interface RawOrder {
    symbol: string;
    orderId: number;
    side: string;
    positionSide: string;
    type: string;
    origType?: string;
    price: string;
    stopPrice: string;
    origQty: string;
    executedQty: string;
    reduceOnly: boolean;
    closePosition?: boolean;
    timeInForce: string;
    time: number;
    source?: SourceKey;
}
/** One row of /fapi/v1/openAlgoOrders — the Algo Service holds every conditional order (STOP, STOP_MARKET, TAKE_PROFIT, …) since 2025-12-09. */
export interface RawAlgoOrder {
    algoId: number;
    symbol: string;
    side: string;
    positionSide: string;
    orderType: string;
    quantity: string;
    triggerPrice: string;
    price: string;
    closePosition: boolean;
    reduceOnly: boolean;
    algoStatus?: string;
    createTime: number;
    updateTime?: number;
    source?: SourceKey;
}
export interface RawForceOrder {
    symbol: string;
    side: string;
    positionSide?: string;
    origQty: string;
    avgPrice: string;
    executedQty: string;
    time: number;
    clientOrderId?: string;
    source?: SourceKey;
}
/** One source's state in the last collection and its balances — `report.sources`, what the client's source filter reads. */
export interface ReportSourceInfo extends SourceStatus {
    label: string;
    walletBalance: number;
    marginBalance: number;
    unrealizedPnl: number;
    /** Open positions of the source. */
    positions: number;
}
export interface Capital {
    deposited: number;
    withdrawn: number;
    transferDays: number;
    transfers: number;
    largest: {
        date: string;
        amount: number;
    } | null;
    nativeByAsset: Record<string, number>;
    /** Same shape as insights.ts `CapitalStep`; netSince/daysSince/returnSince cover the days AFTER the step day, preNet the days up to and including it (= windows.*.sinceStep). */
    step: CapitalStep | null;
}
export interface Report {
    generatedAt: number;
    /** Which exchange(s) the report covers: `all` merges every configured source. */
    source: ReportSource;
    /** Every source the server knows, with its state and balances; the same list in every slice. */
    sources: ReportSourceInfo[];
    account: {
        walletBalance: number;
        unrealizedPnl: number;
        marginBalance: number;
        availableBalance: number;
        maxWithdraw: number;
        initialMargin: number;
        maintMargin: number;
        positionMargin: number;
        openOrderMargin: number;
        /** maintMargin / marginBalance — Binance liquidates the cross account at 100%. */
        marginRatio: number | null;
        /** Σ|notional| / marginBalance. */
        effectiveLeverage: number | null;
        longExposure: number;
        shortExposure: number;
        assets: {
            asset: string;
            wallet: number;
            unrealized: number;
            margin: number;
            available: number;
        }[];
    };
    config: {
        feeTier: number | null;
        canTrade: boolean | null;
        canDeposit: boolean | null;
        canWithdraw: boolean | null;
        hedgeMode: boolean | null;
        multiAssetsMargin: boolean | null;
        bnbFeeBurn: boolean | null;
        commission: {
            symbol: string;
            maker: number;
            taker: number;
        }[];
        tradingStatus: unknown;
        /** positionsRaw[0].marginType lower-cased; Binance's 'crossed' → 'cross'. */
        marginType: 'cross' | 'isolated' | null;
    };
    positions: {
        symbol: string;
        source: SourceKey;
        side: 'LONG' | 'SHORT';
        positionSide: string;
        size: number;
        notional: number;
        entryPrice: number;
        breakEvenPrice: number | null;
        markPrice: number;
        liquidationPrice: number | null;
        liqDistance: number | null;
        unrealizedPnl: number;
        roe: number | null;
        leverage: number;
        marginType: string;
        margin: number;
        adl: number | null;
        updateTime: number;
    }[];
    /** Resting orders (/openOrders) and conditional ones (/openAlgoOrders) in one list; `closePosition` = a close-all stop or take profit (qty 0). */
    openOrders: {
        symbol: string;
        source: SourceKey;
        side: string;
        positionSide: string;
        type: string;
        price: number;
        stopPrice: number;
        qty: number;
        filled: number;
        reduceOnly: boolean;
        closePosition: boolean;
        time: number;
    }[];
    liquidations: {
        symbol: string;
        source: SourceKey;
        side: string;
        qty: number;
        avgPrice: number;
        time: number;
        kind: 'liquidation' | 'adl';
    }[];
    income: IncomeAnalytics;
    trades: TradeAnalytics;
    /**
     * BNB valuation used for fee records. `unpriced` = Σ|income| of
     * BNB fee/funding records that could not be converted (native BNB; 0 when
     * klines work) — the §6.4 banner "Net excludes 0.0175 BNB (~$13) of fees".
     */
    rates: {
        BNB: BnbRates & {
            unpriced: number;
        };
    };
    /** §3.2 — open trips first (entryTime desc), then closed by exitTime desc; truncated ones carry the flag. */
    trips: Trip[];
    /** Capital usage per UTC day from the fills: peak and time-weighted average initial margin, with the open size at those moments. */
    usageDaily: Record<string, DayUsage>;
    lastClosedTrip: Trip | null;
    lastTradeTime: number | null;
    windows: Record<WindowKey, WindowStats>;
    periods: {
        weekly: PeriodRow[];
        monthly: PeriodRow[];
    };
    capital: Capital;
    /** Count of INSURANCE_CLEAR income records (§8.2). */
    liquidations89d: number;
    /** The copy-trading figures of the slice (copiers, cap, assets under copy): the exchange's own, or the exchanges' added for `all`; null when no source answered (meta.warnings says). */
    copyTrading: CopyTrading | null;
    /** The same per exchange, in every slice: the landing's platform tiles read their own exchange's count. */
    copyTradingBySource: Partial<Record<SourceKey, CopyTrading | null>>;
    /** The leverage setting of every symbol /positionRisk lists (flat ones too): the trade feed's ROI = return on notional × leverage. */
    leverage: Record<string, number>;
    /** === insightsByWindow.all (§8.1). */
    insights: Insights;
    insightsByWindow: Record<WindowKey, Insights>;
    meta: {
        usedWeight: number;
        durationMs: number;
        incomeLookbackDays: number;
        tradesLookbackDays: number;
        warnings: string[];
        cacheAgeMs: number;
        cacheTtlMs: number;
        historyCapped: boolean;
        inceptionDate: string;
        /** `YYYY-MM-DD`: the fixed cut-off; nothing before it is in the report. */
        dataStart: string;
        title: string;
        tradesCache: {
            slices: number;
            oldestSliceStart: number | null;
        };
    };
}
export interface RawInputs {
    now: number;
    /** The account of the slice being assembled (`filterRaw` sets it; `collectRaw` returns Binance's). */
    account: RawAccount;
    /** Every configured source's account, for `filterRaw` and the per-source summary. */
    accounts: Partial<Record<SourceKey, RawAccount>>;
    sources: SourceStatus[];
    positionsRaw: RawPosition[];
    incomeRaw: IncomeRecord[];
    tradesRaw: UserTrade[];
    config: Record<string, unknown>;
    openOrdersRaw: RawOrder[];
    openAlgoOrdersRaw: RawAlgoOrder[];
    forceOrders: RawForceOrder[];
    adl: {
        symbol: string;
        adlQuantile: Record<string, number>;
        source?: SourceKey;
    }[];
    feeBurn: {
        feeBurn: boolean;
    } | null;
    tradingStatus: unknown;
    /** The slice's copy-trading figures (`filterRaw` sets it; `collectRaw` returns Binance's). */
    copyTrading: CopyTrading | null;
    /** Per exchange, from the whole collection. */
    copyTradingBySource: Partial<Record<SourceKey, CopyTrading | null>>;
    commission: {
        symbol: string;
        maker: number;
        taker: number;
    }[];
    bnb: BnbRates;
    otherRates: Record<string, number>;
    warnings: string[];
    usedWeight: number;
    tradesCache: {
        slices: number;
        oldestSliceStart: number | null;
    };
}
export interface BuildOptions {
    tradesLookbackDays: number;
    /** One per process (plugin.ts) so last-good BNB closes survive a failed refresh. */
    klines: KlinesStore;
    /** One per process; closed 7-day userTrades slices are reused between reports. Null/absent = no memo. */
    tradesCache?: TradesCache | null;
    cacheTtlMs: number;
    inceptionDate?: string;
    /** Nothing before this UTC day (YYYY-MM-DD) counts; absent = the exchanges' whole retained history. */
    dataStart?: string;
    /** A lead trader's public copy-trading figures: the Binance lead portfolio id, the Bybit leader mark. Absent = none. */
    copyTrading?: {
        binance?: string;
        bybit?: string;
    };
    title?: string;
    /**
     * What to do when the fills (userTrades) cannot be fetched completely, even after the per-slice retries.
     * false / absent: `buildReport` throws, so the caller keeps serving its last good report instead of one with 0 trips.
     * true: the report is built without fills (trips and trade statistics empty) and `meta.warnings` says why — for the very
     * first build of the process only, when there is no cached report to fall back on.
     */
    allowMissingFills?: boolean;
    /** The Bybit client when BYBIT_DASHBOARD_API_KEY / _SECRET are set; its failure never fails the report. */
    bybit?: BybitClient | null;
    /**
     * One per process: the last Bybit collection that succeeded. A failed one (a 10006 / 403 back-off, a slow edge) falls
     * back on it for up to BYBIT_LAST_GOOD_MS, so the page does not lose its Bybit half for a refresh; meta.warnings says so.
     */
    bybitMemo?: {
        last: {
            at: number;
            data: BybitMapped;
        } | null;
        backoffUntil?: number;
    } | null;
}
/** How long a failed Bybit collection may be covered by the last good one. */
export declare const BYBIT_LAST_GOOD_MS: number;
/** Bybit is collected at most this often; reports in between reuse the last collection (it pulls the whole history each time). */
export declare const BYBIT_REFRESH_MS: number;
/**
 * After a 403 (Bybit's edge refuses this IP: its per-IP limit, which a cloud host's shared outbound addresses also count against)
 * or a 10006, Bybit is not asked again for this long, so the ban is not prolonged; the last good data covers the gap.
 */
export declare const BYBIT_BACKOFF_MS: number;
type AssembleOptions = Pick<BuildOptions, 'tradesLookbackDays' | 'cacheTtlMs' | 'inceptionDate' | 'dataStart' | 'title'> & {
    /** The slice this report is (default `all`). */
    source?: ReportSource;
    /** The per-source summary of the whole collection (default: computed from the inputs given). */
    sources?: ReportSourceInfo[];
};
/** All Binance I/O for one report. Pure assembly happens in `assembleReport`. */
export declare function collectRaw(client: BinanceClient, opts: BuildOptions): Promise<RawInputs>;
/** Pure: no clock, no I/O. `meta.cacheAgeMs` and `meta.durationMs` are 0; the route patches cacheAgeMs, `buildReport` patches durationMs. */
export declare function assembleReport(input: RawInputs, opts: AssembleOptions): Report;
/** The accounts of every source as one (the `all` slice): totals added, assets concatenated (walletValue sums them per asset). */
export declare function mergeAccounts(list: RawAccount[]): RawAccount;
/** `report.sources`: every source's state and balances, from the whole (unfiltered) collection. */
export declare function sourcesSummary(raw: RawInputs): ReportSourceInfo[];
/** The inputs of one slice: `all` keeps every record with the accounts summed; a key keeps that exchange's records and account. */
export declare function filterRaw(raw: RawInputs, source: ReportSource): RawInputs;
/** The merged report plus one per configured source — `GET /binance-dashboard/report?source=`. */
export interface Reports {
    all: Report;
    binance?: Report;
    bybit?: Report;
}
/** Pure: the three slices of one collection through `assembleReport`. */
export declare function assembleReports(raw: RawInputs, opts: AssembleOptions): Reports;
export declare function buildReports(client: BinanceClient, opts: BuildOptions): Promise<Reports>;
/** The merged report alone (the trade feed, scripts). */
export declare function buildReport(client: BinanceClient, opts: BuildOptions): Promise<Report>;
export {};
