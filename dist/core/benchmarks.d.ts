import type { BinanceClient } from './binance.js';
/** The ten largest coins by market cap with a Binance USDⓈ-M perpetual, stablecoins left out. */
export declare const BENCHMARKS: readonly [{
    readonly key: "BTC";
    readonly name: "Bitcoin";
}, {
    readonly key: "ETH";
    readonly name: "Ethereum";
}, {
    readonly key: "XRP";
    readonly name: "XRP";
}, {
    readonly key: "BNB";
    readonly name: "BNB";
}, {
    readonly key: "SOL";
    readonly name: "Solana";
}, {
    readonly key: "DOGE";
    readonly name: "Dogecoin";
}, {
    readonly key: "TRX";
    readonly name: "TRON";
}, {
    readonly key: "ADA";
    readonly name: "Cardano";
}, {
    readonly key: "LINK";
    readonly name: "Chainlink";
}, {
    readonly key: "AVAX";
    readonly name: "Avalanche";
}];
export interface BenchmarkSeries {
    key: string;
    name: string;
    /** 'YYYY-MM-DD' (UTC open time) → close, oldest first. */
    daily: Record<string, number>;
}
export interface BenchmarksPayload {
    fetchedAt: number | null;
    coins: BenchmarkSeries[];
}
/** Up to `limit` daily closes of <key>USDT (limit 400 covers this year and the strategy's whole history). */
export declare function fetchDailyCloses(client: BinanceClient, key: string, limit?: number): Promise<Record<string, number>>;
export interface BenchmarksStore {
    /** The cached series, refreshed first when older than the TTL (one refresh in flight at a time). Never throws. */
    get(client: BinanceClient, now: number): Promise<BenchmarksPayload>;
}
export declare function createBenchmarksStore(ttlMs?: number, log?: (msg: string) => void): BenchmarksStore;
