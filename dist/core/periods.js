// ISO-week and monthly period rows for the Periods section.
// Pure: input is the contiguous daily series from analyzeIncome, the trips
// from reconstructTrips, the start of the fills window and `now`.
// Returns are Modified Dietz via returns.ts — including the
// V₀ = 0 rule for the inception period (V₀ = `openingBalance` instead when the
// income lookback cut the history, so the account already held money).
import { dayKey } from './analytics.js';
import { monthLabel } from './format.js';
import { modifiedDietz } from './returns.js';
import { isCounted, tripOutcome } from './trips.js';
const DAY = 86_400_000;
const ms = (day) => Date.parse(`${day}T00:00:00Z`);
/** Mon = 0 … Sun = 6 (UTC). */
const weekday = (t) => (new Date(t).getUTCDay() + 6) % 7;
/** ISO-8601 week: weeks run Mon–Sun, week 1 is the one containing 4 January (equivalently, the first Thursday). */
export function isoWeek(day) {
    const d = new Date(ms(day));
    // Move to the Thursday of this week — it always lies in the ISO year of the week.
    d.setUTCDate(d.getUTCDate() - weekday(d.getTime()) + 3);
    const year = d.getUTCFullYear();
    const jan4 = Date.UTC(year, 0, 4);
    const week = 1 + Math.round(((d.getTime() - jan4) / DAY - 3 + weekday(jan4)) / 7);
    return { year, week };
}
/** Monday..Sunday (UTC) of the ISO week containing `day`. */
export function weekOf(day) {
    const { year, week } = isoWeek(day);
    const t = ms(day);
    const monday = t - weekday(t) * DAY;
    return {
        key: `${year}-W${String(week).padStart(2, '0')}`,
        label: `W${week}`,
        from: dayKey(monday),
        to: dayKey(monday + 6 * DAY),
    };
}
/** 1st..last day (UTC) of the calendar month containing `day`. */
export function monthOf(day) {
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(5, 7)); // 1..12
    const key = day.slice(0, 7);
    return {
        key,
        label: monthLabel(key),
        from: `${key}-01`,
        to: dayKey(Date.UTC(year, month, 0)), // day 0 of the next month = last day of this one
    };
}
function makeRow(kind, range, rows, v0, ctx) {
    const from = range.from > ctx.inception ? range.from : ctx.inception;
    const to = range.to < ctx.today ? range.to : ctx.today;
    let net = 0;
    let fees = 0;
    let funding = 0;
    let realized = 0;
    let greenDays = 0;
    let activeDays = 0;
    let cum = 0;
    let peak = 0;
    let maxDD = 0;
    let bestDay = null;
    let worstDay = null;
    for (const d of rows) {
        net += d.net;
        fees += d.commission;
        funding += d.funding;
        realized += d.realized;
        if (d.net !== 0) {
            activeDays += 1;
            if (d.net > 0)
                greenDays += 1;
            if (bestDay === null || d.net > bestDay.net)
                bestDay = { date: d.date, net: d.net };
            if (worstDay === null || d.net < worstDay.net)
                worstDay = { date: d.date, net: d.net };
        }
        cum += d.net;
        if (cum > peak)
            peak = cum;
        if (peak - cum > maxDD)
            maxDD = peak - cum;
    }
    let trades = null;
    let winRate = null;
    if (from >= ctx.tradesFrom) {
        const lo = ms(from);
        const hi = ms(to) + DAY - 1;
        const inPeriod = ctx.counted.filter((t) => t.exitTime !== null && t.exitTime >= lo && t.exitTime <= hi);
        trades = inPeriod.length;
        if (trades > 0) {
            const wins = inPeriod.filter((t) => tripOutcome(t) === 'win').length;
            winRate = wins / trades;
        }
    }
    return {
        kind,
        key: range.key,
        label: range.label,
        from,
        to,
        days: rows.length,
        toDate: range.to > ctx.today,
        net,
        ret: modifiedDietz(rows, v0),
        fees,
        funding,
        realized,
        trades,
        winRate,
        greenDays,
        activeDays,
        maxDD,
        bestDay,
        worstDay,
    };
}
/**
 * Group the contiguous daily series into consecutive periods. `v0` of a period is the
 * balance at the end of the day before its first row; for the inception period it is
 * `ctx.openingBalance` — 0 for an account that starts inside the series (the zero rule
 * inside modifiedDietz then decides whether a return is printable).
 */
function collect(kind, rangeOf, daily, ctx) {
    const rows = [];
    let i = 0;
    while (i < daily.length) {
        const range = rangeOf(daily[i].date);
        let j = i;
        while (j < daily.length && daily[j].date <= range.to)
            j += 1;
        const prev = i > 0 ? daily[i - 1] : undefined;
        rows.push(makeRow(kind, range, daily.slice(i, j), prev ? prev.balance : ctx.openingBalance, ctx));
        i = j;
    }
    return rows;
}
export function buildPeriods(input) {
    const { daily, trips, tradesFrom, now } = input;
    const first = daily[0];
    if (!first)
        return { weekly: [], monthly: [] };
    const ctx = {
        inception: first.date,
        today: dayKey(now),
        tradesFrom,
        counted: trips.filter((t) => isCounted(t) && t.exitTime !== null),
        openingBalance: input.openingBalance ?? 0,
    };
    return {
        weekly: collect('week', weekOf, daily, ctx),
        monthly: collect('month', monthOf, daily, ctx),
    };
}
