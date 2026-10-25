// The lead portfolio's public figures: how many accounts copy it now, the cap, the assets under copy. Binance's
// official API has no such endpoint; the copy-trading web page reads them from `bapi/.../lead-portfolio/detail`, public and unsigned.
// An unofficial interface that may change without notice — the report treats it as an optional source (null + a warning on failure).
// Both figures are off unless the account is a lead trader and says which portfolio it is (BINANCE_COPY_PORTFOLIO_ID, BYBIT_COPY_LEADER_MARK).
const DETAIL_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail';
/** The leader page's own figures endpoint; the only one of the page's calls that answers outside a browser (the others sit behind Akamai). */
const BYBIT_INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
/**
 * Bybit's edge (Akamai) answers 403 to Node's TLS handshake while it lets curl through (2026-10-23: the same URL, 403 from fetch and
 * https.get, 200 from curl). When fetch is refused, the same GET goes out through the curl of the image (Dockerfile installs it);
 * without curl the error of the fetch stands.
 */
async function curlJson(url, timeoutMs) {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
        execFile('curl', ['-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-H', 'accept: application/json', '-A', BROWSER_UA, url], { maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            if (err)
                return reject(new Error(`curl: ${stderr.toString().trim() || err.message}`));
            try {
                resolve(JSON.parse(stdout.toString()));
            }
            catch {
                reject(new Error(`curl: not JSON (${stdout.toString().slice(0, 80)})`));
            }
        });
    });
}
export async function fetchCopyTrading(portfolioId, timeoutMs = 8000, fetchFn = fetch) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetchFn(`${DETAIL_URL}?portfolioId=${encodeURIComponent(portfolioId)}`, {
            headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', clienttype: 'web', lang: 'en' },
            signal: ctl.signal,
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const body = (await res.json());
        const d = body.data;
        if (!d || typeof d !== 'object')
            throw new Error(`no data (code ${String(body.code ?? '?')})`);
        const rec = d;
        const n = (k) => {
            const v = Number(rec[k]);
            return Number.isFinite(v) ? v : null;
        };
        const copiers = n('currentCopyCount');
        if (copiers === null)
            throw new Error('currentCopyCount missing');
        return {
            copiers,
            maxCopiers: n('finalEffectiveMaxCopyCount') || n('maxCopyCount') || 0, // the effective cap is 0 while no risk control applies: fall through to the plain cap
            totalCopiers: n('totalCopyCount') ?? copiers,
            aum: n('aumAmount') ?? 0,
            profitSharing: n('profitSharingRate'),
            status: typeof rec.status === 'string' ? rec.status : 'UNKNOWN',
            startTime: n('startTime'),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
/** Bybit's figures for the leader: current followers, followers ever, assets under copy (E8 integers in the payload). The slot cap is not in this payload (0 = unknown). */
export async function fetchBybitCopyTrading(leaderMark, timeoutMs = 25_000, fetchFn = fetch) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const url = `${BYBIT_INCOME_URL}?leaderMark=${encodeURIComponent(leaderMark)}`;
        const res = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal: ctl.signal });
        let body;
        if (res.status === 403)
            body = (await curlJson(url, timeoutMs)); // the edge refused the handshake, not the request
        else if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        else
            body = (await res.json());
        const rec = body.result;
        if (body.retCode !== 0 || !rec || typeof rec !== 'object')
            throw new Error(`retCode ${String(body.retCode ?? '?')} ${String(body.retMsg ?? '')}`.trim());
        const r = rec;
        const n = (k) => {
            const v = Number(r[k]);
            return Number.isFinite(v) ? v : null;
        };
        const copiers = n('currentFollowerCount');
        if (copiers === null)
            throw new Error('currentFollowerCount missing');
        const aum = n('aumE8');
        return {
            copiers,
            maxCopiers: 0,
            totalCopiers: n('cumFollowerNum') ?? copiers,
            aum: aum === null ? 0 : aum / 1e8,
            profitSharing: null,
            status: 'ACTIVE',
            startTime: null,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
/** The exchanges' figures as one (the merged slice): counts and assets added; null when no exchange answered. */
export function mergeCopyTrading(list) {
    const have = list.filter((c) => !!c);
    if (!have.length)
        return null;
    const sum = (pick) => have.reduce((s, c) => s + pick(c), 0);
    const starts = have.map((c) => c.startTime).filter((t) => t !== null);
    return {
        copiers: sum((c) => c.copiers),
        maxCopiers: sum((c) => c.maxCopiers),
        totalCopiers: sum((c) => c.totalCopiers),
        aum: sum((c) => c.aum),
        profitSharing: have.find((c) => c.profitSharing !== null)?.profitSharing ?? null,
        status: have.some((c) => c.status === 'ACTIVE') ? 'ACTIVE' : have[0].status,
        startTime: starts.length ? Math.min(...starts) : null,
    };
}
/** The Bybit figures as the report uses them: refreshed in the background (the edge takes 8–10 s to answer), the last value served. */
const bybitLatest = { value: null, at: 0, error: null, inflight: null };
const BYBIT_REFRESH_MS = 4 * 60_000;
const BYBIT_GRACE_MS = 3_000;
/**
 * Starts a refresh when the last one is older than four minutes, waits for it a few seconds at most, and returns the latest
 * value — the previous cycle's when the edge is slow (the figure lags one report at worst). Throws only when there is no value
 * at all and the last refresh failed, so the report's warning names the cause.
 */
export async function bybitCopyTradingLatest(leaderMark, now = Date.now()) {
    if (!bybitLatest.inflight && now - bybitLatest.at > BYBIT_REFRESH_MS) {
        bybitLatest.inflight = fetchBybitCopyTrading(leaderMark)
            .then((v) => {
            bybitLatest.value = v;
            bybitLatest.error = null;
        })
            .catch((e) => {
            bybitLatest.error = e instanceof Error ? e.message : String(e);
        })
            .finally(() => {
            bybitLatest.at = Date.now();
            bybitLatest.inflight = null;
        });
    }
    if (bybitLatest.inflight)
        await Promise.race([bybitLatest.inflight, new Promise((r) => setTimeout(r, BYBIT_GRACE_MS))]);
    if (bybitLatest.value === null && bybitLatest.error)
        throw new Error(bybitLatest.error);
    return bybitLatest.value;
}
