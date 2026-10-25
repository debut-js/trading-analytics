export interface CopyTrading {
    /** accounts copying right now */
    copiers: number;
    /** the slot cap in force */
    maxCopiers: number;
    /** accounts that ever copied */
    totalCopiers: number;
    /** assets under copy, USDT */
    aum: number;
    /** profit-sharing rate, per cent */
    profitSharing: number | null;
    status: string;
    startTime: number | null;
}
export declare function fetchCopyTrading(portfolioId: string, timeoutMs?: number, fetchFn?: typeof fetch): Promise<CopyTrading>;
/** Bybit's figures for the leader: current followers, followers ever, assets under copy (E8 integers in the payload). The slot cap is not in this payload (0 = unknown). */
export declare function fetchBybitCopyTrading(leaderMark: string, timeoutMs?: number, fetchFn?: typeof fetch): Promise<CopyTrading>;
/** The exchanges' figures as one (the merged slice): counts and assets added; null when no exchange answered. */
export declare function mergeCopyTrading(list: (CopyTrading | null | undefined)[]): CopyTrading | null;
/**
 * Starts a refresh when the last one is older than four minutes, waits for it a few seconds at most, and returns the latest
 * value — the previous cycle's when the edge is slow (the figure lags one report at worst). Throws only when there is no value
 * at all and the last refresh failed, so the report's warning names the cause.
 */
export declare function bybitCopyTradingLatest(leaderMark: string, now?: number): Promise<CopyTrading | null>;
