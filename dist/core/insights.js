// Insight sentences: ordered rules with a neutral fallback.
// Pure and total: for every key the result is a non-empty string that never
// contains NaN / undefined / null / Infinity — a final guard swaps any
// defective sentence for the fallback.
//
// Numbers are formatted by format.ts. Three tiny helpers live here because
// the spec's prose needs them and format.ts does not provide them:
//   pct0   — whole-percent shares (`67%`, `90%`, `76%` in §2.7 / A2),
//   rFmt   — `+0.08` R multiples (A4),
//   MONTHS — full month names for PERIODS_MONTH (`September`).
import { MINUS, bps, dShort, int, money, pct, usd } from './format.js';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const pct0 = (v) => `${Math.round(v * 100)}%`;
const rFmt = (v) => (v > 0 ? `+${v.toFixed(2)}` : v < 0 ? `${MINUS}${Math.abs(v).toFixed(2)}` : '0.00');
const plural = (n, word) => `${int(n)} ${n === 1 ? word : `${word}s`}`;
const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
const symName = (s) => (s.endsWith('USDT') ? s.slice(0, -4) : s);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const upDown = (net) => (Math.abs(net) < 0.005 ? 'Flat' : net > 0 ? 'Up' : 'Down');
/** `Up $24.85 after 32 days` / `Down $5.00 after 2 days` / `Flat after 3 days`: the word carries the direction, so the amount is unsigned; a flat window prints none. */
const lead = (net, days) => {
    const dir = upDown(net);
    return dir === 'Flat' ? `Flat after ${days}` : `${dir} ${usd(Math.abs(net))} after ${days}`;
};
/** `30 d of fills` when the fills window is shorter than the window, else `32 d`. */
export function windowChip(ws) {
    return ws.tradesWindowDays < ws.days ? `${int(ws.tradesWindowDays)} d of fills` : `${int(ws.days)} d`;
}
/** Neutral caption: `Since 9 Sep · 32 days · 236 trades` / `Last 30 days · 236 trades`. */
export function fallbackInsight(ws, ctx) {
    const tail = `${plural(ws.days, 'day')} · ${plural(ws.trades.n, 'trade')}`;
    if (ws.key === 'all' && !ctx.historyCapped)
        return `Since ${dShort(ctx.inceptionDate)} · ${tail}`;
    return `Last ${tail}`;
}
// ───────────────────────────── rules ─────────────────────────────
/** HERO_REGIME → HERO_HIGH → HERO_DD. */
function hero(ws) {
    const net = ws.pnl.net;
    if (!fin(net))
        return null;
    const days = plural(ws.days, 'day');
    const s = ws.sinceStep;
    if (s && s.days >= 3 && fin(s.net) && fin(s.preNet)) {
        // `Up {|net|} after {days} days: {preNet} before the {stepDate} capital step, {postNet} in the {n} days since.`
        return `${lead(net, days)}: ${money(s.preNet)} before the ${dShort(s.date)} capital step, ${money(s.net)} in the ${plural(s.days, 'day')} since.`;
    }
    const dd = ws.drawdown.current;
    if (!fin(dd))
        return null;
    if (dd === 0) {
        // `Up {|net|} after {days} days, at a new equity high.`
        if (upDown(net) === 'Flat')
            return `Flat after ${days}: no net PnL yet.`;
        return `${lead(net, days)}, at a new equity high.`;
    }
    // `{Up/Down} {|net|} after {days} days, {dd} below the {peakDate} peak.` (Flat: `Flat after {days}, …`)
    return `${lead(net, days)}, ${usd(dd)} below the ${dShort(ws.drawdown.highDate)} peak.`;
}
/** PERIODS_MONTH: ≥ 2 monthly rows and |fees_m1| > |realized_m1|. */
function periods(monthly) {
    if (monthly.length < 2)
        return null;
    const m1 = monthly[monthly.length - 2];
    const m2 = monthly[monthly.length - 1];
    if (!(Math.abs(m1.fees) > Math.abs(m1.realized)))
        return null;
    // `{Month1} was lost to commissions ({fees} fees on {realized} realized); {Month2} is {net} on {d} days.`
    return `${monthName(m1.key)} was lost to commissions (${money(m1.fees)} fees on ${money(m1.realized)} realized); ${monthName(m2.key)} ${m2.toDate ? 'is' : 'was'} ${money(m2.net)} on ${plural(m2.days, 'day')}.`;
}
/** DD_RECOVERED → open-episode sentence. Episodes are sorted by depth desc, so [0] is the deepest. */
function drawdown(ws) {
    const ep = ws.drawdown.episodes[0];
    if (!ep || !fin(ep.depth) || ep.depth <= 0 || !fin(ep.depthPct) || !fin(ep.equityAtPeak))
        return null;
    const head = `${usd(ep.depth)} — ${pct(ep.depthPct, { sign: false })} of the ${usd(ep.equityAtPeak)} equity at its ${dShort(ep.peak)} peak`;
    if (ep.recovered !== null && fin(ep.recoveryDays)) {
        // `The deepest drawdown was {depth} — {pct} of the {eq} equity at its {peakDate} peak. It bottomed on {troughDate} and was recovered on {recDate}, {n} days after the trough.`
        return `The deepest drawdown was ${head}. It bottomed on ${dShort(ep.trough)} and was recovered on ${dShort(ep.recovered)}, ${plural(ep.recoveryDays, 'day')} after the trough.`;
    }
    return `The deepest drawdown is ${head}, not yet recovered.`;
}
/** FEES_SHARE (fees / gross ≥ 0.4) joined with DIRECTION (one side ≥ 75 % of realized, both n ≥ 20). */
function structure(ws) {
    const parts = [];
    const f = ws.fees;
    if (fin(f.shareOfGross) && f.shareOfGross >= 0.4 && fin(f.total) && fin(ws.pnl.realized)) {
        // `Fees ate {pct} of gross trading profit ({fees} of {gross}).`
        parts.push(`Fees ate ${pct0(f.shareOfGross)} of gross trading profit (${usd(Math.abs(f.total))} of ${usd(ws.pnl.realized)}).`);
    }
    const bothBig = ws.byDirection.length === 2 && ws.byDirection.every((d) => d.n >= 20);
    const lead = bothBig ? ws.byDirection.find((d) => fin(d.share) && d.share >= 0.75 && fin(d.winRate)) : undefined;
    if (lead && fin(lead.share) && fin(lead.winRate)) {
        // `{Side}s earned {share} of realized PnL on a {wr} win rate ({window chip}).`
        parts.push(`${cap(lead.direction)}s earned ${pct0(lead.share)} of realized PnL on a ${pct(lead.winRate, { sign: false })} win rate (${windowChip(ws)}).`);
    }
    return parts.length ? parts.join(' ') : null;
}
/** SYMBOL_TAILS: ≥ 4 symbols with ≥ 5 trips; two best (net > 0) and two worst (net < 0, worst first). */
function symbolTails(ws) {
    const rows = ws.bySymbol.filter((r) => r.trips >= 5 && fin(r.net)).sort((a, b) => b.net - a.net);
    if (rows.length < 4)
        return null;
    const a = rows[0];
    const b = rows[1];
    const c = rows[rows.length - 1];
    const d = rows[rows.length - 2];
    if (!(a.net > 0 && b.net > 0 && c.net < 0 && d.net < 0))
        return null;
    // `{A} and {B} made {x}; {C} and {D} gave {y} back.`
    return `${symName(a.symbol)} and ${symName(b.symbol)} made ${usd(a.net + b.net)}; ${symName(c.symbol)} and ${symName(d.symbol)} gave ${usd(-(c.net + d.net))} back.`;
}
/** FEE_RATE: `Fees ran at {bps} of volume ({chip}); {takerShare} of volume paid the taker rate.` */
function feeRate(ws) {
    const f = ws.fees;
    if (!fin(f.bps) || !fin(f.volume) || f.volume <= 0 || !fin(f.takerVolume))
        return null;
    return `Fees ran at ${bps(f.bps)} of volume (${windowChip(ws)}); ${pct0(f.takerVolume / f.volume)} of volume paid the taker rate.`;
}
/** TIMING (trips ≥ 100): `Most active {band} UTC; {bestBand} earned {x}, {worstBand} lost {y}.` */
function timing(ws) {
    if (ws.trades.n < 100 || ws.byHour4.length === 0)
        return null;
    const pick = (better) => ws.byHour4.reduce((acc, b) => (better(b, acc) ? b : acc));
    const busiest = pick((a, b) => a.n > b.n);
    const best = pick((a, b) => a.net > b.net);
    const worst = pick((a, b) => a.net < b.net);
    if (busiest.n <= 0 || !(best.net > 0) || !(worst.net < 0) || best.key === worst.key)
        return null;
    return `Most active ${busiest.label} UTC; ${best.label} earned ${usd(best.net)}, ${worst.label} lost ${usd(-worst.net)}.`;
}
/** RULE_SIGNATURE (trips ≥ 50, two modes each ≥ 25 % of their side's mass). */
function ruleSignature(ws) {
    const h = ws.histogram;
    const r = ws.trades.expectancyR;
    if (ws.trades.n < 50 || !h || !h.modes || !fin(r))
        return null;
    const lossBins = h.bins.filter((b) => b.to <= 0);
    const winBins = h.bins.filter((b) => b.from >= 0);
    const mass = (bins) => bins.reduce((s, b) => s + b.n, 0);
    const at = (bins, center) => bins.find((b) => Math.abs((b.from + b.to) / 2 - center) < 1e-9);
    const lossMass = mass(lossBins);
    const winMass = mass(winBins);
    const lossBin = at(lossBins, h.modes.loss);
    const winBin = at(winBins, h.modes.win);
    if (!lossBin || !winBin || lossMass <= 0 || winMass <= 0)
        return null;
    if (lossBin.n / lossMass < 0.25 || winBin.n / winMass < 0.25)
        return null;
    // `Two tight spikes at {lossMode}% and {winMode}% of notional: a fixed stop/target system with {R} R expectancy per trade.`
    return `Two tight spikes at ${pct(h.modes.loss)} and ${pct(h.modes.win)} of notional: a fixed stop/target system with ${rFmt(r)} R expectancy per trade.`;
}
// ───────────────────────────── assembly ─────────────────────────────
const DEFECT = /NaN|undefined|null|Infinity/;
function guard(candidate, fallback) {
    if (typeof candidate === 'string' && candidate.length > 0 && !DEFECT.test(candidate))
        return candidate;
    return fallback;
}
export function buildInsights(input) {
    const { window: ws, appendix: aws, monthly } = input;
    const ctx = { inceptionDate: input.inceptionDate, historyCapped: input.historyCapped };
    const fbW = guard(fallbackInsight(ws, ctx), 'No data');
    const fbA = guard(fallbackInsight(aws, ctx), 'No data');
    const safe = (fn, fallback) => {
        try {
            return guard(fn(), fallback);
        }
        catch {
            return fallback;
        }
    };
    return {
        hero: safe(() => hero(ws), fbW),
        periods: safe(() => periods(monthly), fbW),
        drawdown: safe(() => drawdown(ws), fbW),
        structure: safe(() => structure(ws), fbW),
        a1: safe(() => symbolTails(aws), fbA),
        a2: safe(() => feeRate(aws), fbA),
        a3: safe(() => timing(aws), fbA),
        a4: safe(() => ruleSignature(aws), fbA),
    };
}
