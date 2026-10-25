// Drawdown episodes over a window's cumulative net-PnL curve. Pure; the caller builds the series (cum restarts at 0 on the
// first day of the window — see windows.ts).
//
// Percentages use the balance at the END of the peak day ("how much of the
// peak capital was lost"); a deposit inside an episode (5 Oct) therefore
// overstates depth % relative to the equity at the trough — deliberately
//.
import { sum } from './math.js';
const DAY = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const EMPTY = { maxAbs: 0, maxPct: 0, episodes: [], current: 0, currentPct: 0, daysSinceHigh: 0, highDate: '', underwaterDays: 0, ulcer: 0, recoveryFactor: null };
export function drawdownStats(series) {
    const n = series.length;
    if (n === 0)
        return { ...EMPTY, episodes: [] };
    const first = series[0];
    const last = n - 1;
    // Running peak starts at cum = 0 "before" the first point: dated series[0].date,
    // with the equity of that moment = balance at the end of day 0 minus the day's net.
    let peak = 0;
    let peakDate = first.date;
    let equityAtPeak = first.balance - first.net;
    // The last point is the day in progress; highDate only moves on completed days.
    let highDate = first.date;
    const episodes = [];
    let open = null;
    let underwater = 0;
    let sumSq = 0;
    let dd = 0;
    for (let i = 0; i < n; i++) {
        const p = series[i];
        if (p.cum >= peak) {
            if (open !== null) {
                open.recovered = p.date;
                open.recoveryDays = daysBetween(open.trough, p.date);
                episodes.push(open);
                open = null;
            }
            peak = p.cum;
            peakDate = p.date;
            equityAtPeak = p.balance;
            if (i < last)
                highDate = p.date;
            dd = 0;
            continue;
        }
        dd = peak - p.cum;
        underwater++;
        const pct = equityAtPeak > 0 ? dd / equityAtPeak : 0;
        sumSq += pct * pct;
        if (open === null) {
            open = { peak: peakDate, trough: p.date, recovered: null, depth: dd, depthPct: pct, equityAtPeak, lengthDays: daysBetween(peakDate, p.date), recoveryDays: null };
        }
        else if (dd > open.depth) {
            open.trough = p.date;
            open.depth = dd;
            open.depthPct = pct;
            open.lengthDays = daysBetween(open.peak, p.date);
        }
    }
    if (open !== null)
        episodes.push(open);
    episodes.sort((a, b) => b.depth - a.depth);
    const deepest = episodes[0];
    const maxAbs = deepest ? deepest.depth : 0;
    const net = sum(series.map((p) => p.net));
    return {
        maxAbs,
        maxPct: deepest ? deepest.depthPct : 0,
        episodes,
        current: dd,
        currentPct: equityAtPeak > 0 ? dd / equityAtPeak : 0,
        daysSinceHigh: daysBetween(highDate, series[last].date),
        highDate,
        underwaterDays: underwater,
        ulcer: Math.sqrt(sumSq / n),
        recoveryFactor: maxAbs > 0 ? net / maxAbs : null,
    };
}
