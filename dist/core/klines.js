// BNBUSDT daily closes from the public klines endpoint. Fees paid in BNB (the fee-discount asset) are
// valued at the close of the day they were charged, not at today's price:
// ~$13 of the fixture's +$25.35 hero figure is BNB, so this matters.
//
// One KlinesStore lives per process (plugin.ts). A failed
// refresh keeps the last good closes ('last-good') so the hero does not jump
// by half its value when Binance hiccups; 'none' only before the first success.
import { MAIN_ASSET, dayKey } from './analytics.js';
/** GET /fapi/v1/klines?symbol=BNBUSDT&interval=1d&limit=<limit> (public, weight 1) → { 'YYYY-MM-DD': close }. */
export async function fetchBnbDailyCloses(client, limit = 90) {
    const rows = await client.public('/fapi/v1/klines', { symbol: 'BNBUSDT', interval: '1d', limit });
    const out = {};
    for (const k of rows) {
        const openTime = Number(k[0]);
        const close = Number(k[4]);
        if (!Number.isFinite(openTime) || !Number.isFinite(close) || close <= 0)
            continue;
        out[dayKey(openTime)] = close;
    }
    return out;
}
/** `current` = close of the max key; source 'klines'. */
export function bnbRatesFromCloses(daily, now) {
    const keys = Object.keys(daily).sort();
    const last = keys[keys.length - 1];
    const sorted = {};
    for (const k of keys)
        sorted[k] = daily[k];
    return { current: last === undefined ? 0 : daily[last], daily: sorted, source: 'klines', fetchedAt: now };
}
const EMPTY = { current: 0, daily: {}, source: 'none', fetchedAt: null };
export function createKlinesStore() {
    let state = EMPTY;
    return {
        async refresh(client, now) {
            try {
                const daily = await fetchBnbDailyCloses(client);
                if (Object.keys(daily).length === 0)
                    throw new Error('empty klines response');
                state = bnbRatesFromCloses(daily, now);
                return null;
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (state.fetchedAt !== null) {
                    const fetchedAtIso = new Date(state.fetchedAt).toISOString();
                    state = { ...state, source: 'last-good' };
                    return `klines: ${message}; using BNBUSDT closes fetched at ${fetchedAtIso}`;
                }
                state = EMPTY;
                return `klines: ${message}; BNB rate unavailable`;
            }
        },
        get: () => ({ ...state, daily: { ...state.daily } }),
    };
}
/**
 * Resolution: 'USDT' → 1; 'BNB' → bnb.daily[day] ?? close of the latest daily
 * key ≤ day ?? (bnb.current > 0 ? bnb.current : undefined); anything else → others[asset].
 */
export function makeRateFn(bnb, others = {}) {
    const keys = Object.keys(bnb.daily).sort();
    return (asset, day) => {
        if (asset === MAIN_ASSET)
            return 1;
        if (asset === 'BNB') {
            const exact = bnb.daily[day];
            if (exact !== undefined)
                return exact;
            let best;
            for (const k of keys) {
                if (k <= day)
                    best = k;
                else
                    break;
            }
            if (best !== undefined)
                return bnb.daily[best];
            return bnb.current > 0 ? bnb.current : undefined;
        }
        return others[asset];
    };
}
