// Capital usage from the fills: the money open positions tie up, moment by moment, as each fill changes a
// position's size. A trip-level estimate counted every position at its full size from its first fill, while the strategy
// builds and unwinds positions over dozens of fills and hours, so the daily peaks came out far too high.
//
// Per day: the peak and the time-weighted average of the initial margin (size / leverage) over all open positions, with the
// position size at those moments so the page can add the maintenance margin at the account's own rate.
import { dayKey } from './analytics.js';
const DAY = 86_400_000;
const num = (s) => {
    const v = typeof s === 'number' ? s : Number(s);
    return Number.isFinite(v) ? v : 0;
};
/**
 * `fills` in any order; `trips` give each coin's leverage (a coin without one takes the usual leverage of the account);
 * `from` is where the fill history starts (nothing is known before it), `now` the end of the last day.
 */
export function usageDaily(fills, trips, from, now) {
    const levOf = new Map();
    const known = [];
    for (const t of trips) {
        const lev = t.leverage;
        if (lev && lev > 0) {
            levOf.set(`${t.source ?? 'binance'}|${t.symbol}`, lev);
            known.push(lev);
        }
    }
    known.sort((a, b) => a - b);
    const usual = known.length ? known[Math.floor(known.length / 2)] : 10;
    const sorted = fills.filter((f) => f.time >= from && f.time <= now).sort((a, b) => a.time - b.time || a.id - b.id);
    const pos = new Map();
    let im = 0, n = 0; // the running totals: initial margin and open size
    const out = {};
    if (!sorted.length)
        return out;
    let day = Math.floor(sorted[0].time / DAY) * DAY;
    let t0 = day, areaIM = 0, areaN = 0, peakIM = 0, peakN = 0;
    const close = (until) => {
        areaIM += im * (until - t0);
        areaN += n * (until - t0);
        t0 = until;
    };
    const flush = () => {
        const span = Math.min(day + DAY, now) - day;
        if (span > 0)
            out[dayKey(day)] = { peakIM, peakN, avgIM: areaIM / span, avgN: areaN / span };
        day += DAY;
        t0 = day;
        areaIM = 0;
        areaN = 0;
        peakIM = im;
        peakN = n;
    };
    for (const f of sorted) {
        while (f.time >= day + DAY) {
            close(day + DAY);
            flush();
        }
        close(f.time);
        const source = f.source ?? 'binance';
        const key = `${source}|${f.symbol}|${f.positionSide}`;
        const p = pos.get(key) ?? { qty: 0, price: 0, lev: levOf.get(`${source}|${f.symbol}`) ?? usual };
        const before = Math.abs(p.qty) * p.price;
        p.qty += (f.side === 'BUY' ? 1 : -1) * num(f.qty);
        if (Math.abs(p.qty) < 1e-12)
            p.qty = 0;
        p.price = num(f.price) || p.price;
        const after = Math.abs(p.qty) * p.price;
        pos.set(key, p);
        n += after - before;
        im += (after - before) / p.lev;
        if (n < 1e-9) {
            n = Math.max(0, n);
        }
        if (im < 1e-9) {
            im = Math.max(0, im);
        }
        if (im > peakIM) {
            peakIM = im;
            peakN = n;
        }
    }
    while (day + DAY <= now) {
        close(day + DAY);
        flush();
    }
    if (day < now) {
        close(now);
        flush();
    }
    return out;
}
