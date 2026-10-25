import { type DailyPoint, type IncomeRecord, type PnlBreakdown, type RateFn, type UserTrade } from './analytics.js';
import { type DrawdownStats } from './drawdown.js';
import { type Trip } from './trips.js';
export type WindowKey = 'all' | 'ytd' | '60d' | '30d';
export declare const WINDOW_KEYS: WindowKey[];
export interface SeriesPoint {
    date: string;
    net: number;
    /** cumulative net, restarting at 0 on the first day of the window */
    cum: number;
    /** cum − running peak, ≤ 0 */
    dd: number;
    balance: number;
    transfers: number;
    ret: number | null;
    realized: number;
    /** = commission (≤ 0) */
    fees: number;
    funding: number;
    active: boolean;
}
export interface DayRef {
    date: string;
    net: number;
}
/** byHour key 0..23 label '00'; byHour4 key 0..5 label '00–04'; byWeekday key 0..6 (Mon = 0) label 'Mon'; lowN = n < 10 */
export interface Bucket {
    key: number;
    label: string;
    n: number;
    net: number;
    winRate: number | null;
    lowN: boolean;
}
/** Symbols = trips in the window ∪ fills in the fills window; fees/funding carry Binance's sign (fees ≤ 0); sorted by net desc. */
export interface SymbolRow {
    symbol: string;
    net: number;
    realized: number;
    fees: number;
    funding: number;
    trips: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRate: number | null;
    profitFactor: number | null;
    volume: number;
    makerShare: number | null;
    lastActive: number | null;
    /** now − lastActive > 7 d (or never active) */
    dormant: boolean;
    /** trips < 5 */
    lowN: boolean;
    long: {
        trips: number;
        net: number;
    };
    short: {
        trips: number;
        net: number;
    };
}
/** share = realized_dir / Σ realized of both directions (null when Σ ≤ 0) */
export interface DirectionRow {
    direction: 'long' | 'short';
    n: number;
    wins: number;
    losses: number;
    winRate: number | null;
    net: number;
    realized: number;
    share: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    expectancy: number | null;
    medianHold: number | null;
}
/** 20 bins of 0.2 % from −2 % to +2 % (fractions); tails collapse into the end bins; modes = bin centres (null when n < 50 or a side is empty). */
export interface Histogram {
    unit: '%';
    step: number;
    bins: {
        from: number;
        to: number;
        n: number;
        net: number;
        winRate: number | null;
        tail: 'low' | 'high' | null;
    }[];
    mean: number;
    modes: {
        loss: number;
        win: number;
    } | null;
}
export interface WindowStats {
    key: WindowKey;
    days: number;
    from: string;
    to: string;
    /** dayKey(max(fromMs, now − tradesLookbackDays·DAY)) */
    tradesFrom: string;
    /** min(days, tradesLookbackDays) */
    tradesWindowDays: number;
    series: SeriesPoint[];
    pnl: PnlBreakdown;
    mwr: number | null;
    twr: number | null;
    twrSubPeriods: {
        n: number;
        skipped: number;
    };
    /** Only when the capital step lies inside the window. net/ret/days cover the days AFTER the step day; preNet = Σnet of the window up to and including the step day. */
    sinceStep: {
        date: string;
        amount: number;
        net: number;
        ret: number | null;
        days: number;
        preNet: number;
    } | null;
    drawdown: DrawdownStats;
    daily: {
        active: number;
        green: number;
        red: number;
        idle: number;
        mean: number;
        median: number;
        std: number;
        best: DayRef | null;
        worst: DayRef | null;
        p10: number;
        p90: number;
        skew: number;
        exKurt: number;
        gainToPain: number | null;
        streakGreen: number;
        streakRed: number;
    };
    /** active < 60 → hidden (sharpe, sortino and calmar are all null); < 90 → provisional; values as today's performance(); calmar null while CAGR < 0 */
    ratios: {
        sharpe: number | null;
        sortino: number | null;
        calmar: number | null;
        maturity: 'hidden' | 'provisional' | 'full';
    };
    trades: {
        n: number;
        truncated: number;
        open: number;
        wins: number;
        losses: number;
        breakeven: number;
        winRate: number | null;
        wilson: [number, number] | null;
        profitFactor: number | null;
        avgWin: number | null;
        avgLoss: number | null;
        payoff: number | null;
        expectancy: number | null;
        expectancyR: number | null;
        oneR: number | null;
        sqn: number | null;
        largestWin: number | null;
        largestLoss: number | null;
        /** breakeven ends both streaks */
        streaks: {
            w: number;
            l: number;
            expW: number;
            expL: number;
            pLoss6in100: number | null;
        };
        /** minutes; winners/losers = medians */
        hold: {
            median: number;
            p10: number;
            p90: number;
            winners: number;
            losers: number;
        } | null;
        /** edges 5,15,30,60,120,240,480,null — bin k collects holdMin ≤ upTo_k */
        holdHist: {
            upTo: number | null;
            n: number;
            net: number;
        }[];
        sizeX: number | null;
        /** server always emits 'trip-net' */
        basis: 'trip-net' | 'order-gross';
    };
    fees: {
        /** = pnl.commission (≤ 0) */
        total: number;
        /** |total| / realized (null if realized ≤ 0) */
        shareOfGross: number | null;
        /** |total| / net (null if net ≤ 0) */
        shareOfNet: number | null;
        /** fills-window quantities; feesFills ≤ 0; bps = |feesFills| / volume */
        feesFills: number;
        volume: number;
        makerVolume: number;
        takerVolume: number;
        bps: number | null;
        /** −Σ trip.fees / n (≤ 0) */
        perTrip: number | null;
        makerShare: number | null;
        /** ISO weeks inside the fills window */
        makerWeekly: {
            week: string;
            makerShare: number | null;
        }[];
        /** Σ entryTakerNotional × (taker − maker) per symbol rates; 0.10 × |total| */
        whatIf: {
            allMakerEntries: number;
            bnbDiscount: number;
            ratesAssumed: boolean;
        };
    };
    bySymbol: SymbolRow[];
    byDirection: DirectionRow[];
    byHour: Bucket[];
    byHour4: Bucket[];
    byWeekday: Bucket[];
    concentration: {
        symbols: number;
        top2Share: number | null;
        netWithoutTop2: number;
        negativeSymbols: number;
        hhi: number | null;
        effectiveN: number | null;
    };
    /** null when trades.n = 0 */
    histogram: Histogram | null;
    activity: {
        symbols: number;
        active7d: number;
        dormant: number;
        fills: number;
        orders: number;
        ordersPerDay: number;
    };
}
export interface WindowsInput {
    daily: DailyPoint[];
    incomeRaw: IncomeRecord[];
    trades: UserTrade[];
    trips: Trip[];
    rate: RateFn;
    now: number;
    tradesLookbackDays: number;
    commissionRates: {
        symbol: string;
        maker: number;
        taker: number;
    }[];
    /**
     * Wallet balance at the start of `daily[0]`. 0 (the default) when the series begins with the account itself;
     * report.ts passes the reconstructed balance when the 89-day income lookback cut the history, so the account
     * already held money on day 0. It is the V₀ of the window that starts at day 0 (`all`); `30d`/`7d` start from
     * the closing balance of the day before their first row instead.
     */
    openingBalance?: number;
}
export declare function computeWindow(input: WindowsInput, key: WindowKey): WindowStats;
export declare function computeWindows(input: WindowsInput): Record<WindowKey, WindowStats>;
