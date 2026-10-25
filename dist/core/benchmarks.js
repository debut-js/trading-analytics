// Benchmarks for the main chart: daily closes of the largest coins by market cap, so the page can lay
// "the same money held in BTC" over the strategy's curve. The public USDⓈ-M klines endpoint (the one klines.ts already
// uses, no key weight beyond 1 per call), one call per coin, kept in memory for a few hours. A failed refresh keeps the
// last good closes; before the first success the endpoint answers an empty list and the page simply offers no compare.
import { dayKey } from './analytics.js';
/** The ten largest coins by market cap with a Binance USDⓈ-M perpetual, stablecoins left out. */
export const BENCHMARKS = [
    { key: 'BTC', name: 'Bitcoin' },
    { key: 'ETH', name: 'Ethereum' },
    { key: 'XRP', name: 'XRP' },
    { key: 'BNB', name: 'BNB' },
    { key: 'SOL', name: 'Solana' },
    { key: 'DOGE', name: 'Dogecoin' },
    { key: 'TRX', name: 'TRON' },
    { key: 'ADA', name: 'Cardano' },
    { key: 'LINK', name: 'Chainlink' },
    { key: 'AVAX', name: 'Avalanche' },
];
/** Up to `limit` daily closes of <key>USDT (limit 400 covers this year and the strategy's whole history). */
export async function fetchDailyCloses(client, key, limit = 400) {
    const rows = await client.public('/fapi/v1/klines', { symbol: `${key}USDT`, interval: '1d', limit });
    const out = {};
    for (const k of rows) {
        const openTime = Number(k[0]);
        const close = Number(k[4]);
        if (Number.isFinite(openTime) && Number.isFinite(close) && close > 0)
            out[dayKey(openTime)] = close;
    }
    return out;
}
export function createBenchmarksStore(ttlMs = 6 * 60 * 60 * 1000, log = () => { }) {
    let state = { fetchedAt: null, coins: [] };
    let inflight = null;
    const refresh = async (client, now) => {
        const coins = [];
        for (const b of BENCHMARKS) {
            try {
                const daily = await fetchDailyCloses(client, b.key);
                if (Object.keys(daily).length)
                    coins.push({ key: b.key, name: b.name, daily });
            }
            catch (e) {
                // one coin failing keeps its last good series, the rest still refresh
                const prev = state.coins.find((c) => c.key === b.key);
                if (prev)
                    coins.push(prev);
                log(`benchmarks: ${b.key}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (coins.length)
            state = { fetchedAt: now, coins };
    };
    return {
        async get(client, now) {
            const stale = state.fetchedAt === null || now - state.fetchedAt > ttlMs;
            if (stale) {
                inflight ??= refresh(client, now).finally(() => { inflight = null; });
                // the first call waits for the data; later ones answer from the cache while it refreshes
                if (state.fetchedAt === null)
                    await inflight;
            }
            return state;
        },
    };
}
