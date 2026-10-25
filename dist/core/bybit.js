// Minimal signed client for Bybit V5 REST (read-only endpoints) and the raw collection the Bybit half of a report needs.
// Keys never leave this process (they sign requests server-side); the browser only receives the computed report.
// Mapping the raw payloads into the Binance-shaped records the analytics run on is bybit-map.ts (pure), so the fixtures
// can be dumped as the raw lists and replayed.
import { createHmac } from 'node:crypto';
export const BYBIT_HOST = 'https://api.bybit.com';
/** Bybit's documented alternate mainnet host: the client moves to it after an HTTP 403 from the first (an edge block of the
    server's IP, 2026-10-23: `/v5/market/time` answered 403 to a cloud host for a while) and stays there for the process. */
export const BYBIT_FALLBACK_HOST = 'https://api.bytick.com';
/** A request that gets no answer for this long is abandoned; the Bybit half then fails and the report says so. */
export const REQUEST_TIMEOUT_MS = 15_000;
const RECV_WINDOW_MS = 10_000;
const DAY = 86_400_000;
/** The history endpoints take at most 7 days per request. */
const WINDOW_MS = 7 * DAY - 1;
const MAX_PAGES = 200;
export class BybitError extends Error {
    status;
    retCode;
    constructor(message, 
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    status, 
    /** Bybit's `retCode` (e.g. 10006 too many visits, 10003 invalid key). */
    retCode) {
        super(message);
        this.status = status;
        this.retCode = retCode;
    }
}
/** Bybit asks us to back off: retCode 10006 (endpoint limit) or HTTP 403 (the 600-per-5-s IP limit; the ban lifts after ~10 min). */
export function isBybitRateLimit(e) {
    return e instanceof BybitError && (e.retCode === 10006 || e.status === 403);
}
const isAbort = (e) => {
    const name = typeof e === 'object' && e !== null ? e.name : undefined;
    return name === 'TimeoutError' || name === 'AbortError';
};
function toQuery(params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined)
            qs.append(k, String(v));
    }
    return qs.toString();
}
export function createBybitClient(apiKey, apiSecret, opts = {}) {
    const hosts = [(opts.host ?? BYBIT_HOST).replace(/\/$/, '')];
    const fallback = opts.fallbackHost === undefined ? BYBIT_FALLBACK_HOST : opts.fallbackHost;
    if (fallback && fallback.replace(/\/$/, '') !== hosts[0])
        hosts.push(fallback.replace(/\/$/, ''));
    let hostIndex = 0;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let timeOffset = 0;
    let offsetSyncedAt = 0;
    async function request(path, query, signed) {
        try {
            return await requestOn(hosts[hostIndex], path, query, signed);
        }
        catch (e) {
            // 403 = the edge refused this IP outright (a rate-limit ban or a block), not the request: the alternate host, once, then for good.
            if (e instanceof BybitError && e.status === 403 && hostIndex < hosts.length - 1) {
                hostIndex++;
                return requestOn(hosts[hostIndex], path, query, signed);
            }
            throw e;
        }
    }
    async function requestOn(host, path, query, signed) {
        const headers = {};
        if (signed) {
            // Signature (docs/v5/guide): HMAC-SHA256 over timestamp + key + recvWindow + queryString, lower-case hex.
            const ts = String(Date.now() + timeOffset);
            headers['X-BAPI-API-KEY'] = apiKey;
            headers['X-BAPI-TIMESTAMP'] = ts;
            headers['X-BAPI-RECV-WINDOW'] = String(RECV_WINDOW_MS);
            headers['X-BAPI-SIGN'] = createHmac('sha256', apiSecret).update(`${ts}${apiKey}${RECV_WINDOW_MS}${query}`).digest('hex');
        }
        let res;
        let text;
        try {
            // One signal for the whole exchange, body included: a socket that stalls mid-response must not hang the build either.
            res = await fetch(`${host}${path}${query ? `?${query}` : ''}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
            text = await res.text();
        }
        catch (e) {
            if (isAbort(e))
                throw new BybitError(`Bybit ${path}: no response within ${timeoutMs / 1000} s`, 0);
            throw e;
        }
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            throw new BybitError(`Bybit ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
        }
        if (!res.ok)
            throw new BybitError(`Bybit ${path}: HTTP ${res.status} ${body.retMsg ?? ''}`.trim(), res.status, body.retCode);
        if (body.retCode !== 0)
            throw new BybitError(`Bybit ${path}: ${body.retMsg} (${body.retCode})`, res.status, body.retCode);
        return body.result;
    }
    async function syncTime() {
        // Signed requests are rejected (10002) when our clock sits outside the recv window of the server's.
        if (Date.now() - offsetSyncedAt < 10 * 60_000)
            return;
        const t = await request('/v5/market/time', '', false);
        const serverMs = Number(t.timeSecond) * 1000 + Math.floor((Number(t.timeNano) % 1e9) / 1e6);
        if (Number.isFinite(serverMs) && serverMs > 0)
            timeOffset = serverMs - Date.now();
        offsetSyncedAt = Date.now();
    }
    return {
        async get(path, params = {}) {
            const signed = !path.startsWith('/v5/market/');
            if (signed)
                await syncTime();
            return request(path, toQuery(params), signed);
        },
    };
}
/** Walks the cursor of one request until the last page. */
async function pages(client, path, params) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.get(path, { ...params, cursor });
        out.push(...(res.list ?? []));
        cursor = res.nextPageCursor || undefined;
        if (!cursor)
            break;
    }
    return out;
}
/** The history endpoints: 7-day windows from `from` to `to`, oldest first, every window paged; rows deduplicated by `keyOf`. */
async function windows(client, path, params, from, to, keyOf) {
    const seen = new Set();
    const out = [];
    for (let start = from; start <= to; start += WINDOW_MS + 1) {
        const rows = await pages(client, path, { ...params, startTime: start, endTime: Math.min(to, start + WINDOW_MS) });
        for (const r of rows) {
            const k = keyOf(r);
            if (seen.has(k))
                continue;
            seen.add(k);
            out.push(r);
        }
    }
    return out;
}
/**
 * All Bybit I/O for one report. The wallet and the positions are required (like Binance's account and positionRisk);
 * the account info and the open orders are optional and only leave a warning when they fail.
 */
export async function collectBybitRaw(client, opts) {
    const settleCoin = opts.settleCoin ?? 'USDT';
    const warnings = [];
    const optional = async (label, p, fallback) => {
        try {
            return await p;
        }
        catch (e) {
            warnings.push(`bybit ${label}: ${e instanceof Error ? e.message : String(e)}`);
            return fallback;
        }
    };
    const [info, wallets, positions, orders] = await Promise.all([
        optional('accountInfo', client.get('/v5/account/info'), null),
        client.get('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
        pages(client, '/v5/position/list', { category: 'linear', settleCoin, limit: 200 }),
        optional('openOrders', pages(client, '/v5/order/realtime', { category: 'linear', settleCoin, openOnly: 0, limit: 50 }), []),
    ]);
    const wallet = wallets.list?.[0];
    if (!wallet)
        throw new BybitError('Bybit /v5/account/wallet-balance: no UNIFIED wallet in the answer', 200);
    // No `category` filter on the log: the transfer rows carry none, and a deposit filtered out would read as profit.
    const log = await windows(client, '/v5/account/transaction-log', { accountType: 'UNIFIED', limit: 50 }, opts.from, opts.now, (r) => r.id);
    const executions = await windows(client, '/v5/execution/list', { category: 'linear', limit: 100 }, opts.tradesFrom, opts.now, (e) => e.execId);
    return { now: opts.now, info, wallet, positions, log, executions, orders, warnings };
}
