// Token marks for the page. First the `background` SVGs of @web3icons/core (MIT, ): the mark on its
// brand-coloured square, which the page clips to a circle, read on demand from the package and kept in memory. A coin the
// pack lacks falls back on CoinGecko's logo: the public search finds the coin by
// ticker (the largest by market cap when tickers clash), the image is fetched by this server once and kept in memory, and
// the page gets it from our own route, so the browser never talks to CoinGecko and the CSP stays one origin. A coin CoinGecko
// does not know tries CoinCap's ticker-named logos next.
// CoinGecko's free API asks for attribution: the page's footer credits it.
/** Binance's ticker → the pack's name, where they differ. */
const ALIAS = { RENDER: 'RNDR' };
export const isIconName = (s) => /^[A-Z0-9]{1,16}$/.test(s);
const packCache = new Map();
/** The background-variant SVG of `symbol` from the pack (`ADA`, `1INCH`, …; the client strips `USDT` and a `1000` multiplier), or null. */
export function tokenIconSvg(symbol) {
    if (!isIconName(symbol))
        return Promise.resolve(null);
    const name = ALIAS[symbol] ?? symbol;
    let p = packCache.get(name);
    if (!p) {
        p = import(`@web3icons/core/svgs/tokens/background/${name}.svg.js`).then((m) => (typeof m.default === 'string' && m.default.startsWith('<svg') ? m.default : null), () => null);
        packCache.set(name, p);
    }
    return p;
}
// ---------------- CoinGecko fallback ----------------
const CG_SEARCH = 'https://api.coingecko.com/api/v3/search';
const CG_GAP_MS = 4_000; // one search every 4 s: well inside the keyless rate limit
const CG_WAIT_MS = 5_000; // how long a page's request waits before the route answers "later"
const MISS_TTL_MS = 24 * 3600_000; // a coin CoinGecko does not know is asked again a day later
const ERROR_TTL_MS = 10 * 60_000; // after a failure (429, a timeout) the coin is asked again ten minutes later
const MAX_BYTES = 256 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']); // no remote SVG: it could carry script
const cgCache = new Map();
let queue = Promise.resolve();
let lastCall = 0;
/** Runs `fn` after the previous CoinGecko call, at least CG_GAP_MS after it. */
function inTurn(fn) {
    const run = queue.then(async () => {
        const wait = lastCall + CG_GAP_MS - Date.now();
        if (wait > 0)
            await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();
        return fn();
    });
    queue = run.catch(() => undefined);
    return run;
}
async function fetchFromCoinGecko(symbol) {
    const res = await inTurn(() => fetch(`${CG_SEARCH}?query=${encodeURIComponent(symbol)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }));
    if (!res.ok)
        throw new Error(`coingecko search ${res.status}`);
    const data = (await res.json());
    const same = (data.coins ?? []).filter((c) => (c.symbol ?? '').toUpperCase() === symbol && typeof c.large === 'string');
    same.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    const url = same[0]?.large;
    if (!url)
        return fromCoinCap(symbol);
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)coingecko\.com$/.test(u.hostname))
        return null;
    const img = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!img.ok)
        throw new Error(`coingecko image ${img.status}`);
    const type = (img.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type))
        return null;
    const body = Buffer.from(await img.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES)
        return null;
    return { body, type };
}
function coinGecko(symbol) {
    const now = Date.now();
    const hit = cgCache.get(symbol);
    if (hit) {
        if ('pending' in hit)
            return hit.pending;
        if (now - hit.at < hit.ttl)
            return hit.icon;
    }
    const pending = fetchFromCoinGecko(symbol).then((icon) => { cgCache.set(symbol, { at: Date.now(), icon, ttl: icon ? Infinity : MISS_TTL_MS }); return icon; }, () => { cgCache.set(symbol, { at: Date.now(), icon: null, ttl: ERROR_TTL_MS }); return null; });
    cgCache.set(symbol, { at: now, pending });
    return pending;
}
/** CoinCap's logo by ticker: the second fallback, for a coin CoinGecko's search does not know (PNG only). */
async function fromCoinCap(symbol) {
    const img = await fetch(`https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`, { signal: AbortSignal.timeout(10_000) });
    if (img.status === 404 || img.status === 403)
        return null;
    if (!img.ok)
        throw new Error(`coincap image ${img.status}`);
    const type = (img.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type))
        return null;
    const body = Buffer.from(await img.arrayBuffer());
    return body.length && body.length <= MAX_BYTES ? { body, type } : null;
}
/** The coin's mark: the pack's SVG, else CoinGecko's logo, else CoinCap's, else null (the page keeps the coin's first letter). */
export async function tokenIcon(symbol) {
    if (!isIconName(symbol))
        return null;
    const svg = await tokenIconSvg(symbol);
    if (svg)
        return { body: svg, type: 'image/svg+xml; charset=utf-8' };
    const cg = coinGecko(ALIAS[symbol] ?? symbol);
    if (!(cg instanceof Promise))
        return cg;
    const timer = new Promise((r) => setTimeout(() => r('pending'), CG_WAIT_MS));
    return Promise.race([cg, timer]);
}
