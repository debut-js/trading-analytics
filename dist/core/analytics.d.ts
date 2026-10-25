import type { SourceKey } from './sources.js';
export interface IncomeRecord {
    symbol: string;
    incomeType: string;
    income: string;
    asset: string;
    time: number;
    tranId: number;
    tradeId?: string;
    info?: string;
    /** The exchange the record came from; absent = Binance (records predating the second source). */
    source?: SourceKey;
}
export interface UserTrade {
    symbol: string;
    id: number;
    orderId: number;
    side: 'BUY' | 'SELL';
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    price: string;
    qty: string;
    quoteQty: string;
    realizedPnl: string;
    commission: string;
    commissionAsset: string;
    maker: boolean;
    time: number;
    source?: SourceKey;
}
export declare const MAIN_ASSET = "USDT";
export declare const dayKey: (t: number) => string;
export type IncomeKind = 'flow' | 'realized' | 'commission' | 'funding' | 'nonTrading' | 'other';
/** Money moving in/out of the futures wallet — never performance. */
export declare const INCOME_FLOWS: ReadonlySet<string>;
/** Rebates that hand part of a commission back → booked against commission. */
export declare const INCOME_FEE_OFFSETS: ReadonlySet<string>;
/** Gifts from Binance — in the wallet, not performance; excluded from net, own line in A6. */
export declare const INCOME_NON_TRADING: ReadonlySet<string>;
export declare function incomeKind(type: string): IncomeKind;
/**
 * Main-asset value of one unit of `asset` on UTC day `day` ('YYYY-MM-DD').
 * `undefined` = unpriced: the record is skipped from money analytics and
 * reported in `IncomeAnalytics.unpriced`. BNB is priced at the BNBUSDT daily
 * close (klines.ts), so a fee paid in BNB on 16 Sep is worth what BNB closed
 * at on 16 Sep — not today's price.
 */
export type RateFn = (asset: string, day: string) => number | undefined;
/** USDT → 1, everything else from a flat map (tests / assets priced at one current mark). */
export declare function rateFromMap(rates: Record<string, number>): RateFn;
/** USDT → 1, everything else unpriced. */
export declare const USDT_ONLY: RateFn;
/** Futures wallet valued in the main asset on `day`; assets without a rate are skipped. */
export declare function walletValue(assets: {
    asset: string;
    walletBalance: string | number;
}[], rate: RateFn, day: string): number;
export interface PnlBreakdown {
    realized: number;
    /** COMMISSION plus fee offsets (rebates). Negative = paid. */
    commission: number;
    funding: number;
    /** Everything else that is a trading result: INSURANCE_CLEAR, unknown types. */
    other: number;
    /** WELCOME_BONUS / CONTEST_REWARD — lands in the wallet but is not performance. Excluded from net. */
    nonTrading: number;
    /** realized + commission + funding + other. */
    net: number;
    transfers: number;
}
export interface DailyPoint extends PnlBreakdown {
    date: string;
    /** Futures wallet balance (main asset) at the end of the day, reconstructed backwards from the current balance. */
    balance: number;
    /** Daily return: net / balance at start of day. null when start balance is ~0. */
    ret: number | null;
}
export interface SymbolStats extends PnlBreakdown {
    symbol: string;
    closes: number;
    wins: number;
    losses: number;
    grossProfit: number;
    grossLoss: number;
    lastActivity: number;
}
export interface IncomeAnalytics {
    from: number;
    to: number;
    records: number;
    byType: {
        type: string;
        asset: string;
        total: number;
        count: number;
    }[];
    periods: Record<'1d' | '7d' | '30d' | 'all', PnlBreakdown>;
    daily: DailyPoint[];
    bySymbol: SymbolStats[];
    byHour: {
        hour: number;
        realized: number;
        count: number;
    }[];
    byWeekday: {
        weekday: number;
        realized: number;
        count: number;
    }[];
    /** Per closing-fill stats from REALIZED_PNL records (whole income window). */
    closes: {
        count: number;
        wins: number;
        losses: number;
        winRate: number | null;
        profitFactor: number | null;
        avgWin: number | null;
        avgLoss: number | null;
    };
    performance: Performance;
    /** Records skipped because `rate(asset, day)` was undefined — signed native units, sorted by count desc. */
    unpriced: {
        asset: string;
        total: number;
        count: number;
    }[];
}
export interface Performance {
    /** Time-weighted return over the window (transfers neutralised). */
    twr: number | null;
    maxDrawdownPct: number | null;
    /** Largest peak-to-trough fall of cumulative net PnL, in main asset. */
    maxDrawdownAbs: number;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    avgDailyNet: number;
    medianDailyNet: number;
    stdDailyNet: number;
    bestDay: {
        date: string;
        net: number;
    } | null;
    worstDay: {
        date: string;
        net: number;
    } | null;
    greenDays: number;
    redDays: number;
    activeDays: number;
    maxWinStreakDays: number;
    maxLossStreakDays: number;
    /** Funding + commission as share of gross realized profit. */
    costRatio: number | null;
}
/**
 * @param currentBalance futures wallet value in main-asset terms (see `walletValue`).
 * @param rate main-asset value of one unit of `asset` on a given UTC day. Records
 *   without a rate stay out of the money-weighted analytics (still listed in
 *   byType and reported in `unpriced`).
 */
export declare function analyzeIncome(records: IncomeRecord[], currentBalance: number, now: number, rate?: RateFn): IncomeAnalytics;
export interface TradeAnalytics {
    from: number;
    to: number;
    fills: number;
    orders: number;
    volume: number;
    buyVolume: number;
    sellVolume: number;
    makerShare: number | null;
    /** Native commission per asset (unconverted), e.g. [{ asset: 'USDT', total: 34.19 }, { asset: 'BNB', total: 0.0175 }]. */
    commission: {
        asset: string;
        total: number;
    }[];
    /** Σ commission × rate(asset, day of fill), all assets; unpriced assets count as 0. */
    commissionUsdt: number;
    avgOrderNotional: number | null;
    ordersPerDay: number;
    /** Orders with non-zero realized PnL, i.e. reducing / closing a position. */
    closing: {
        count: number;
        wins: number;
        losses: number;
        winRate: number | null;
        avgWin: number | null;
        avgLoss: number | null;
        payoff: number | null;
        profitFactor: number | null;
        expectancy: number | null;
        largestWin: number | null;
        largestLoss: number | null;
        maxWinStreak: number;
        maxLossStreak: number;
    };
    byDirection: {
        direction: 'long' | 'short';
        closes: number;
        wins: number;
        realized: number;
        winRate: number | null;
    }[];
    bySymbol: {
        symbol: string;
        volume: number;
        fills: number;
        makerShare: number | null;
        commission: number;
        realized: number;
    }[];
    dailyVolume: {
        date: string;
        volume: number;
    }[];
    recent: {
        time: number;
        symbol: string;
        side: string;
        positionSide: string;
        qty: number;
        avgPrice: number;
        notional: number;
        realized: number;
        commission: number;
        maker: boolean;
    }[];
}
/**
 * @param rate converts every fill's commission to the main asset on the fill's
 *   UTC day, so BNB-paid fees land in per-order / per-symbol numbers instead of
 *   being dropped. Unpriced assets count as 0 here (they are still
 *   listed natively in `commission`).
 */
export declare function analyzeTrades(trades: UserTrade[], from: number, to: number, rate?: RateFn): TradeAnalytics;
