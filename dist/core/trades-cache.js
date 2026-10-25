// Fixed-interval memo of /fapi/v1/userTrades slices.
//
// userTrades accepts at most a 7-day span per request, so fills are fetched in
// 7-day slices aligned to Monday 00:00 UTC. A slice whose end is in the past
// can never change (fills are immutable), so it is kept in RAM keyed
// `symbol|sliceStart` and reused by every later report; only the slice that
// contains `now` is refetched. Limits: entries older than 24 h and anything
// past 50 MB in total are evicted (LRU on access). Nothing is persisted and
// the footer says so (client).
import { mapLimit, withRetry } from './binance.js';
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
/** 00:00:00.000 UTC of the Monday on or before `t`. */
export function mondayUtc(t) {
    const d = new Date(t);
    const back = (d.getUTCDay() + 6) % 7; // Sun=0 → 6 days back, Mon=1 → 0, …, Sat=6 → 5
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}
export function createTradesCache(opts = {}) {
    const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
    // Map iteration order is insertion order; `get` re-inserts the entry, so the
    // first key is always the least recently used one.
    const map = new Map();
    let bytes = 0;
    const key = (symbol, sliceStart) => `${symbol}|${sliceStart}`;
    const drop = (k) => {
        const e = map.get(k);
        if (!e)
            return;
        bytes -= e.bytes;
        map.delete(k);
    };
    const prune = (now) => {
        for (const [k, e] of map)
            if (now - e.at > maxAgeMs)
                drop(k);
        while (bytes > maxBytes && map.size > 0)
            drop(map.keys().next().value);
    };
    return {
        get(symbol, sliceStart) {
            const k = key(symbol, sliceStart);
            const e = map.get(k);
            if (!e)
                return undefined;
            map.delete(k);
            map.set(k, e);
            return e.rows;
        },
        set(symbol, sliceStart, rows, now) {
            const k = key(symbol, sliceStart);
            drop(k);
            const size = JSON.stringify(rows).length;
            map.set(k, { rows, bytes: size, at: now });
            bytes += size;
            prune(now);
        },
        stats() {
            let oldest = null;
            for (const k of map.keys()) {
                const s = Number(k.slice(k.lastIndexOf('|') + 1));
                if (oldest === null || s < oldest)
                    oldest = s;
            }
            return { slices: map.size, oldestSliceStart: oldest, bytes };
        },
        prune,
    };
}
/**
 * One userTrades request; a saturated page (1000 rows) is split until every slice fits.
 * Every request is retried twice (500 ms, 1 500 ms) unless Binance rate-limits us, so a blip does not cost the report its fills;
 * a request that still fails rejects, and so does the whole window — never a silently shorter one.
 */
export async function fetchTradesWindow(client, symbol, start, end, retry) {
    const rows = await withRetry(() => client.signed('/fapi/v1/userTrades', { symbol, startTime: start, endTime: end, limit: 1000 }), retry);
    if (rows.length >= 1000 && end - start > 60_000) {
        const mid = Math.floor((start + end) / 2);
        const [a, b] = await Promise.all([fetchTradesWindow(client, symbol, start, mid, retry), fetchTradesWindow(client, symbol, mid + 1, end, retry)]);
        return [...a, ...b];
    }
    return rows;
}
/**
 * Fills of `symbols` inside [from, to], fetched in Monday-aligned 7-day slices.
 * Closed slices (sliceEnd < now) come from `cache` when present; the slice that
 * contains `now` is always refetched (and never stored).
 * Rejects as soon as one slice cannot be fetched even after its retries (`retry` is for tests);
 * the slices still waiting are then never requested.
 */
export async function fetchTradesSliced(client, cache, symbols, from, to, now, retry) {
    const jobs = [];
    for (const symbol of symbols) {
        for (let start = mondayUtc(from); start <= to; start += WEEK) {
            const end = start + WEEK - 1;
            jobs.push({ symbol, start, end, closed: end < now });
        }
    }
    const chunks = await mapLimit(jobs, 6, async (j) => {
        if (j.closed && cache) {
            const hit = cache.get(j.symbol, j.start);
            if (hit)
                return hit;
        }
        const rows = await fetchTradesWindow(client, j.symbol, j.start, j.closed ? j.end : Math.min(j.end, now), retry);
        if (j.closed && cache)
            cache.set(j.symbol, j.start, rows, now);
        return rows;
    });
    return chunks.flat().filter((t) => t.time >= from && t.time <= to);
}
