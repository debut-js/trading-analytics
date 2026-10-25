// WindowStats for the three page windows. The
// server computes everything; the client only picks `windows[w]` and draws.
//
// A window is a trailing slice of the daily series: `all` = since inception,
// `ytd` = since 1 Jan (UTC) of the current year, `60d` / `30d` = the last 60 / 30
// calendar days (today included) — the public set of 2026-10-18; the data's own
// start (report.ts DATA_START) stays the cut under every one of them. The fills
// window inside it starts at tradesFrom = max(window start, now − lookback).
// Pure: no clock, no I/O; `now` and `rate` are injected.
import { dayKey } from './analytics.js';
import { drawdownStats } from './drawdown.js';
import { exKurt, expectedStreaks, mean, median, pRunAtLeast, quantile, sampleStd, skew, sum, wilson } from './math.js';
import { detectCapitalStep, modifiedDietz, subPeriodTwr } from './returns.js';
import { isCounted, oneROf, tripOutcome } from './trips.js';
const DAY = 86_400_000;
export const WINDOW_KEYS = ['all', 'ytd', '60d', '30d'];
/** Trailing day counts; `all` and `ytd` are cut by date instead. */
const WINDOW_DAYS = { all: null, ytd: null, '60d': 60, '30d': 30 };
/** Index of the first daily row of the current UTC year (`ytd`); the row count — an empty window — while the year has no row yet. */
function ytdStart(daily, now) {
    const jan1 = `${new Date(now).getUTCFullYear()}-01-01`;
    const i = daily.findIndex((d) => d.date >= jan1);
    return i < 0 ? daily.length : i;
}
// ───────────────────────────── income side ─────────────────────────────
function sumBreakdown(rows) {
    const out = { realized: 0, commission: 0, funding: 0, other: 0, nonTrading: 0, net: 0, transfers: 0 };
    for (const r of rows) {
        out.realized += r.realized;
        out.commission += r.commission;
        out.funding += r.funding;
        out.other += r.other;
        out.nonTrading += r.nonTrading;
        out.net += r.net;
        out.transfers += r.transfers;
    }
    return out;
}
function buildSeries(slice) {
    let cum = 0;
    let peak = 0;
    return slice.map((d) => {
        cum += d.net;
        peak = Math.max(peak, cum);
        return { date: d.date, net: d.net, cum, dd: cum - peak, balance: d.balance, transfers: d.transfers, ret: d.ret, realized: d.realized, fees: d.commission, funding: d.funding, active: d.net !== 0 };
    });
}
/** the step is a property of the whole account; it is reported when its day lies inside the window. */
function computeSinceStep(daily, startIdx) {
    const step = detectCapitalStep(daily);
    if (!step || step.index < startIdx)
        return null;
    const after = daily.slice(step.index + 1);
    const stepDay = daily[step.index];
    return {
        date: step.date,
        amount: step.amount,
        net: sum(after.map((d) => d.net)),
        ret: after.length ? modifiedDietz(after, stepDay.balance) : null,
        days: after.length,
        preNet: sum(daily.slice(startIdx, step.index + 1).map((d) => d.net)),
    };
}
function dailyBlock(slice) {
    const active = slice.filter((d) => d.net !== 0);
    const nets = active.map((d) => d.net);
    let best = null;
    let worst = null;
    let green = 0;
    let red = 0;
    let maxGreen = 0;
    let maxRed = 0;
    for (const d of active) {
        if (!best || d.net > best.net)
            best = { date: d.date, net: d.net };
        if (!worst || d.net < worst.net)
            worst = { date: d.date, net: d.net };
        if (d.net > 0) {
            green++;
            red = 0;
        }
        else {
            red++;
            green = 0;
        }
        maxGreen = Math.max(maxGreen, green);
        maxRed = Math.max(maxRed, red);
    }
    const gains = sum(nets.filter((n) => n > 0));
    const pains = -sum(nets.filter((n) => n < 0));
    return {
        active: active.length,
        green: nets.filter((n) => n > 0).length,
        red: nets.filter((n) => n < 0).length,
        idle: slice.length - active.length,
        mean: mean(nets),
        median: median(nets),
        std: sampleStd(nets),
        best,
        worst,
        p10: quantile(nets, 0.1),
        p90: quantile(nets, 0.9),
        skew: skew(nets),
        exKurt: exKurt(nets),
        gainToPain: pains > 0 ? gains / pains : null,
        streakGreen: maxGreen,
        streakRed: maxRed,
    };
}
/**
 * Same formulas as analytics.ts performance() over the window's daily returns; Calmar is null while CAGR < 0.
 * Below 60 active days the page prints no ratio, so none is emitted: a 7-day window used to carry
 * Sharpe 10.65 / Calmar 6 154 that only the client's maturity check kept off the screen.
 */
function ratiosBlock(slice, activeDays) {
    const maturity = activeDays < 60 ? 'hidden' : activeDays < 90 ? 'provisional' : 'full';
    if (maturity === 'hidden')
        return { sharpe: null, sortino: null, calmar: null, maturity };
    const rets = slice.map((d) => d.ret).filter((r) => r !== null);
    let index = 1;
    let peakIdx = 1;
    let maxDdPct = 0;
    for (const r of rets) {
        index *= 1 + r;
        peakIdx = Math.max(peakIdx, index);
        maxDdPct = Math.max(maxDdPct, (peakIdx - index) / peakIdx);
    }
    const m = mean(rets);
    const s = sampleStd(rets);
    const downside = Math.sqrt(mean(rets.map((r) => Math.min(r, 0) ** 2)));
    const years = slice.length / 365;
    const cagr = rets.length && years > 0 && index > 0 ? index ** (1 / years) - 1 : null;
    return {
        sharpe: s > 0 ? (m / s) * Math.sqrt(365) : null,
        sortino: downside > 0 ? (m / downside) * Math.sqrt(365) : null,
        calmar: cagr !== null && cagr >= 0 && maxDdPct > 0 ? cagr / maxDdPct : null,
        maturity,
    };
}
/** Income-side fee ratios. */
function feesIncomeSide(pnl) {
    const total = pnl.commission;
    return {
        total,
        shareOfGross: pnl.realized > 0 ? Math.abs(total) / pnl.realized : null,
        shareOfNet: pnl.net > 0 ? Math.abs(total) / pnl.net : null,
        bnbDiscount: 0.1 * Math.abs(total),
    };
}
const HOLD_EDGES = [5, 15, 30, 60, 120, 240, 480, null];
const HIST_MIN = -0.02;
const HIST_STEP = 0.002;
const HIST_BINS = 20;
/** VIP 0 (spec A2): used for every symbol when no rates are known → ratesAssumed */
const VIP0 = { maker: 0.0002, taker: 0.0005 };
const DORMANT_MS = 7 * DAY;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const num = (s) => {
    const n = typeof s === 'number' ? s : Number(s);
    return Number.isFinite(n) ? n : 0;
};
const pad2 = (n) => String(n).padStart(2, '0');
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const hourOf = (t) => new Date(t.entryTime).getUTCHours();
/** 00:00 UTC of the Thursday in the ISO week containing `ms`. */
function thursdayOf(ms) {
    const dow = (new Date(ms).getUTCDay() + 6) % 7; // Mon = 0
    return ms - dow * DAY + 3 * DAY;
}
/** ISO week key 'YYYY-Www' (Mon–Sun, UTC) of a 'YYYY-MM-DD' day — '2026-09-09' → '2026-W37'. */
function isoWeekKey(day) {
    const thu = thursdayOf(Date.parse(`${day}T00:00:00Z`));
    const year = new Date(thu).getUTCFullYear();
    const week = 1 + Math.round((thu - thursdayOf(Date.UTC(year, 0, 4))) / (7 * DAY));
    return `${year}-W${pad2(week)}`;
}
/** trade rows + A4: statistics over the counted trips of the window. */
function tradesBlock(all, counted, now, tradesFromMs) {
    const n = counted.length;
    const nets = counted.map((t) => t.net);
    const winNets = counted.filter((t) => tripOutcome(t) === 'win').map((t) => t.net);
    const lossNets = counted.filter((t) => tripOutcome(t) === 'loss').map((t) => t.net);
    const wins = winNets.length;
    const losses = lossNets.length;
    const grossWin = sum(winNets);
    const grossLoss = -sum(lossNets);
    const avgWin = wins ? grossWin / wins : null;
    const avgLoss = losses ? sum(lossNets) / losses : null;
    const winRate = n ? wins / n : null;
    // R multiples: 1R = median |retNotional| of the window's losers
    const oneR = oneROf(counted);
    const rs = oneR !== null && oneR > 0 ? counted.map((t) => t.retNotional / oneR) : [];
    const sdR = sampleStd(rs);
    // Longest streaks in exit order; a breakeven trip ends both streaks.
    const ordered = [...counted].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
    let w = 0;
    let l = 0;
    let maxW = 0;
    let maxL = 0;
    for (const t of ordered) {
        const o = tripOutcome(t);
        if (o === 'win') {
            w++;
            l = 0;
        }
        else if (o === 'loss') {
            l++;
            w = 0;
        }
        else {
            w = 0;
            l = 0;
        }
        maxW = Math.max(maxW, w);
        maxL = Math.max(maxL, l);
    }
    const { expW, expL } = expectedStreaks(winRate ?? 0, n);
    const holdOf = (xs) => xs.map((t) => t.holdMin).filter((h) => h !== null);
    const holds = holdOf(counted);
    const holdHist = HOLD_EDGES.map((upTo) => ({ upTo, n: 0, net: 0 }));
    for (const t of counted) {
        if (t.holdMin === null)
            continue;
        const h = t.holdMin;
        const bin = holdHist[HOLD_EDGES.findIndex((e) => e === null || h <= e)];
        if (bin) {
            bin.n++;
            bin.net += t.net;
        }
    }
    const sizes = counted.map((t) => t.sizeX).filter((s) => s !== null);
    return {
        n,
        truncated: all.filter((t) => t.truncated && (t.exitTime ?? now) >= tradesFromMs && (t.exitTime ?? now) <= now).length,
        open: all.filter((t) => t.status === 'open').length,
        wins,
        losses,
        breakeven: n - wins - losses,
        winRate,
        wilson: wilson(wins, n),
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        avgWin,
        avgLoss,
        payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
        expectancy: n ? mean(nets) : null,
        expectancyR: rs.length ? mean(rs) : null,
        oneR,
        sqn: rs.length >= 2 && sdR > 0 ? (Math.sqrt(rs.length) * mean(rs)) / sdR : null,
        largestWin: wins ? Math.max(...winNets) : null,
        largestLoss: losses ? Math.min(...lossNets) : null,
        streaks: { w: maxW, l: maxL, expW, expL, pLoss6in100: n ? pRunAtLeast(6, 100, losses / n) : null },
        hold: holds.length
            ? {
                median: median(holds),
                p10: quantile(holds, 0.1),
                p90: quantile(holds, 0.9),
                winners: median(holdOf(counted.filter((t) => tripOutcome(t) === 'win'))),
                losers: median(holdOf(counted.filter((t) => tripOutcome(t) === 'loss'))),
            }
            : null,
        holdHist,
        sizeX: sizes.length ? median(sizes) : null,
        basis: 'trip-net',
    };
}
/** commissionRates[symbol] → else the most frequent (maker, taker) pair → else VIP 0 (spec A2). */
function pickRates(rates) {
    const bySymbol = new Map(rates.map((r) => [r.symbol, { maker: r.maker, taker: r.taker }]));
    const freq = new Map();
    for (const r of rates) {
        const k = `${r.maker}|${r.taker}`;
        const e = freq.get(k) ?? { maker: r.maker, taker: r.taker, n: 0 };
        e.n++;
        freq.set(k, e);
    }
    let common = VIP0;
    let best = 0;
    for (const e of freq.values()) {
        if (e.n > best) {
            best = e.n;
            common = { maker: e.maker, taker: e.taker };
        }
    }
    return (symbol) => bySymbol.get(symbol) ?? common;
}
/** fee rows + A2: income-side ratios, fills-side rate, per trip, weekly maker share, what-ifs. */
function feesBlock(counted, fills, pnl, rates, rate) {
    const income = feesIncomeSide(pnl);
    let feesFills = 0;
    let volume = 0;
    let makerVolume = 0;
    const weeks = new Map();
    for (const f of fills) {
        const q = num(f.quoteQty);
        const k = rate(f.commissionAsset, dayKey(f.time));
        feesFills -= num(f.commission) * (k ?? 0); // Binance sign: fees ≤ 0; unpriced asset → 0
        volume += q;
        if (f.maker)
            makerVolume += q;
        const wk = isoWeekKey(dayKey(f.time));
        const wv = weeks.get(wk) ?? { volume: 0, maker: 0 };
        wv.volume += q;
        if (f.maker)
            wv.maker += q;
        weeks.set(wk, wv);
    }
    const pick = pickRates(rates);
    let allMakerEntries = 0;
    for (const t of counted) {
        const r = pick(t.symbol);
        allMakerEntries += t.entryTakerNotional * (r.taker - r.maker);
    }
    return {
        total: income.total,
        shareOfGross: income.shareOfGross,
        shareOfNet: income.shareOfNet,
        feesFills,
        volume,
        makerVolume,
        takerVolume: volume - makerVolume,
        bps: volume > 0 ? Math.abs(feesFills) / volume : null,
        perTrip: counted.length ? -sum(counted.map((t) => t.fees)) / counted.length : null,
        makerShare: volume > 0 ? makerVolume / volume : null,
        makerWeekly: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, wv]) => ({ week, makerShare: wv.volume > 0 ? wv.maker / wv.volume : null })),
        whatIf: { allMakerEntries, bnbDiscount: income.bnbDiscount, ratesAssumed: rates.length === 0 },
    };
}
/** A1: one row per symbol seen in the window's trips or fills; sorted by net desc. */
function symbolRows(counted, fills, now) {
    const acc = new Map();
    const get = (symbol) => {
        let a = acc.get(symbol);
        if (!a) {
            a = {
                row: { symbol, net: 0, realized: 0, fees: 0, funding: 0, trips: 0, wins: 0, losses: 0, breakeven: 0, winRate: null, profitFactor: null, volume: 0, makerShare: null, lastActive: null, dormant: true, lowN: true, long: { trips: 0, net: 0 }, short: { trips: 0, net: 0 } },
                makerVolume: 0,
                grossWin: 0,
                grossLoss: 0,
            };
            acc.set(symbol, a);
        }
        return a;
    };
    for (const t of counted) {
        const a = get(t.symbol);
        const r = a.row;
        r.trips++;
        r.net += t.net;
        r.realized += t.gross;
        r.fees -= t.fees;
        r.funding += t.funding;
        const o = tripOutcome(t);
        if (o === 'win') {
            r.wins++;
            a.grossWin += t.net;
        }
        else if (o === 'loss') {
            r.losses++;
            a.grossLoss -= t.net;
        }
        else
            r.breakeven++;
        r[t.direction].trips++;
        r[t.direction].net += t.net;
        r.lastActive = Math.max(r.lastActive ?? 0, t.exitTime ?? 0);
    }
    for (const f of fills) {
        const a = get(f.symbol);
        const q = num(f.quoteQty);
        a.row.volume += q;
        if (f.maker)
            a.makerVolume += q;
        a.row.lastActive = Math.max(a.row.lastActive ?? 0, f.time);
    }
    return [...acc.values()]
        .map(({ row, makerVolume, grossWin, grossLoss }) => ({
        ...row,
        winRate: row.trips ? row.wins / row.trips : null,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        makerShare: row.volume > 0 ? makerVolume / row.volume : null,
        dormant: row.lastActive === null || now - row.lastActive > DORMANT_MS,
        lowN: row.trips < 5,
    }))
        .sort((a, b) => b.net - a.net || a.symbol.localeCompare(b.symbol));
}
/** §2.7.2 Long vs short: share = realized_dir / Σ realized of both sides (null when Σ ≤ 0). */
function directionRows(counted) {
    const realizedTotal = sum(counted.map((t) => t.gross));
    return ['long', 'short'].map((direction) => {
        const xs = counted.filter((t) => t.direction === direction);
        const nets = xs.map((t) => t.net);
        const winNets = xs.filter((t) => tripOutcome(t) === 'win').map((t) => t.net);
        const lossNets = xs.filter((t) => tripOutcome(t) === 'loss').map((t) => t.net);
        const holds = xs.map((t) => t.holdMin).filter((h) => h !== null);
        const realized = sum(xs.map((t) => t.gross));
        return {
            direction,
            n: xs.length,
            wins: winNets.length,
            losses: lossNets.length,
            winRate: xs.length ? winNets.length / xs.length : null,
            net: sum(nets),
            realized,
            share: realizedTotal > 0 ? realized / realizedTotal : null,
            avgWin: winNets.length ? mean(winNets) : null,
            avgLoss: lossNets.length ? mean(lossNets) : null,
            expectancy: xs.length ? mean(nets) : null,
            medianHold: holds.length ? median(holds) : null,
        };
    });
}
/** A3: buckets by ENTRY time (UTC); lowN = n < 10. */
function bucketRows(counted, count, keyOf, labelOf) {
    const rows = Array.from({ length: count }, (_, key) => ({ key, label: labelOf(key), n: 0, net: 0, winRate: null, lowN: true }));
    const wins = new Array(count).fill(0);
    for (const t of counted) {
        const k = keyOf(t);
        const b = rows[k];
        if (!b)
            continue;
        b.n++;
        b.net += t.net;
        if (tripOutcome(t) === 'win')
            wins[k] = wins[k] + 1;
    }
    for (const b of rows) {
        b.winRate = b.n ? wins[b.key] / b.n : null;
        b.lowN = b.n < 10;
    }
    return rows;
}
/** A1 concentration line: top-2 / Σ winners; HHI = Σ(net_i / Σwinners)²; effective N = 1 / HHI; net without top-2. */
function concentrationBlock(rows) {
    const nets = rows.map((r) => r.net);
    const winners = nets.filter((v) => v > 0).sort((a, b) => b - a);
    const winSum = sum(winners);
    const top2 = sum(winners.slice(0, 2));
    const hhi = winSum > 0 ? sum(winners.map((v) => (v / winSum) ** 2)) : null;
    return {
        symbols: rows.length,
        top2Share: winSum > 0 ? top2 / winSum : null,
        netWithoutTop2: sum(nets) - top2,
        negativeSymbols: nets.filter((v) => v < 0).length,
        hhi,
        effectiveN: hhi !== null && hhi > 0 ? 1 / hhi : null,
    };
}
const tailOf = (i) => (i === 0 ? 'low' : i === HIST_BINS - 1 ? 'high' : null);
/** A4.1: 20 bins of 0.2 % from −2 % to +2 % of notional (net), tails collapsed into the end bins. */
function histogramBlock(counted) {
    const n = counted.length;
    if (n === 0)
        return null;
    const bins = Array.from({ length: HIST_BINS }, (_, i) => ({
        from: round6(HIST_MIN + i * HIST_STEP),
        to: round6(HIST_MIN + (i + 1) * HIST_STEP),
        n: 0,
        net: 0,
        winRate: null,
        tail: tailOf(i),
    }));
    const wins = new Array(HIST_BINS).fill(0);
    for (const t of counted) {
        const i = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((t.retNotional - HIST_MIN) / HIST_STEP + 1e-9)));
        const b = bins[i];
        b.n++;
        b.net += t.net;
        if (tripOutcome(t) === 'win')
            wins[i] = wins[i] + 1;
    }
    bins.forEach((b, i) => {
        b.winRate = b.n ? wins[i] / b.n : null;
    });
    const modeOf = (side) => {
        let best = null;
        for (const b of side)
            if (b.n > 0 && (best === null || b.n > best.n))
                best = b;
        return best ? (best.from + best.to) / 2 : null;
    };
    const loss = modeOf(bins.slice(0, HIST_BINS / 2));
    const win = modeOf(bins.slice(HIST_BINS / 2));
    return {
        unit: '%',
        step: HIST_STEP,
        bins,
        mean: mean(counted.map((t) => t.retNotional)),
        modes: n >= 50 && loss !== null && win !== null ? { loss, win } : null,
    };
}
function activityBlock(rows, fills, tradesWindowDays) {
    const orders = new Set(fills.map((f) => `${f.symbol}:${f.orderId}`)).size;
    return {
        symbols: rows.length,
        active7d: rows.filter((r) => !r.dormant).length,
        dormant: rows.filter((r) => r.dormant).length,
        fills: fills.length,
        orders,
        ordersPerDay: orders / Math.max(1, tradesWindowDays),
    };
}
/** Everything derived from trips and fills. Counted = closed, untruncated, exited inside the fills window. */
function tradeBlocks(input, ctx) {
    const { now } = input;
    const inWindow = (t) => t >= ctx.tradesFromMs && t <= now;
    const counted = input.trips.filter((t) => isCounted(t) && t.exitTime !== null && inWindow(t.exitTime));
    const fills = input.trades.filter((f) => inWindow(f.time));
    const bySymbol = symbolRows(counted, fills, now);
    return {
        trades: tradesBlock(input.trips, counted, now, ctx.tradesFromMs),
        fees: feesBlock(counted, fills, ctx.pnl, input.commissionRates, input.rate),
        bySymbol,
        byDirection: directionRows(counted),
        byHour: bucketRows(counted, 24, hourOf, (k) => pad2(k)),
        byHour4: bucketRows(counted, 6, (t) => Math.floor(hourOf(t) / 4), (k) => `${pad2(k * 4)}–${pad2(k * 4 + 4)}`),
        byWeekday: bucketRows(counted, 7, (t) => (new Date(t.entryTime).getUTCDay() + 6) % 7, (k) => WEEKDAYS[k]),
        concentration: concentrationBlock(bySymbol),
        histogram: histogramBlock(counted),
        activity: activityBlock(bySymbol, fills, ctx.tradesWindowDays),
    };
}
// ───────────────────────────── composition ─────────────────────────────
export function computeWindow(input, key) {
    const { daily, now } = input;
    const span = WINDOW_DAYS[key];
    const startIdx = key === 'ytd' ? ytdStart(daily, now) : span === null ? 0 : Math.max(0, daily.length - span);
    const slice = daily.slice(startIdx);
    const today = dayKey(now);
    const from = slice[0]?.date ?? today;
    const to = slice[slice.length - 1]?.date ?? today;
    const days = slice.length;
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const tradesFrom = dayKey(Math.max(fromMs, now - input.tradesLookbackDays * DAY));
    const tradesFromMs = Date.parse(`${tradesFrom}T00:00:00Z`);
    const tradesWindowDays = Math.min(days, input.tradesLookbackDays);
    const v0 = startIdx > 0 ? daily[startIdx - 1].balance : (input.openingBalance ?? 0);
    const series = buildSeries(slice);
    const pnl = sumBreakdown(slice);
    const mwr = days ? modifiedDietz(slice, v0) : null;
    const tw = days ? subPeriodTwr(input.incomeRaw, input.rate, { from: fromMs, to: now, startBalance: v0 }) : { twr: null, subPeriods: 0, skipped: 0 };
    const dailyStats = dailyBlock(slice);
    return {
        key,
        days,
        from,
        to,
        tradesFrom,
        tradesWindowDays,
        series,
        pnl,
        mwr,
        twr: tw.twr,
        twrSubPeriods: { n: tw.subPeriods, skipped: tw.skipped },
        sinceStep: computeSinceStep(daily, startIdx),
        drawdown: drawdownStats(series.map((p) => ({ date: p.date, cum: p.cum, net: p.net, balance: p.balance }))),
        daily: dailyStats,
        ratios: ratiosBlock(slice, dailyStats.active),
        ...tradeBlocks(input, { fromMs, tradesFromMs, tradesFrom, tradesWindowDays, pnl }),
    };
}
export function computeWindows(input) {
    return { all: computeWindow(input, 'all'), ytd: computeWindow(input, 'ytd'), '60d': computeWindow(input, '60d'), '30d': computeWindow(input, '30d') };
}
