// Return arithmetic for the dashboard:
//   • Modified Dietz over a run of days — money-weighted return
//     with transfers weighted by the fraction of the period they were present.
//   • Sub-period time-weighted return cut at every flow record.
//   • Capital-step detection.
// Pure: no clock, no I/O; `now` and `rate` are injected.
import { dayKey, incomeKind } from './analytics.js';
import { sum } from './math.js';
/** zero rule: with V₀ = 0 the weighted flows must reach max($10, 2·|Σnet|). */
export const ZERO_RULE_MIN = 10;
/** guard: a sub-period opening below $10 is skipped (counted in `skipped`). */
export const TWR_MIN_BALANCE = 10;
const num = (s) => {
    const n = typeof s === 'number' ? s : Number(s);
    return Number.isFinite(n) ? n : 0;
};
/**
 * Modified Dietz: R = Σnet / (V₀ + Σ wᵢ·Fᵢ) with wᵢ = (T − i)/T,
 * i = 0-based day index, T = days.length (transfers land at the start of their day).
 * V₀ = 0 is allowed only when Σwᵢ·Fᵢ ≥ max($10, 2·|Σnet|); any denominator ≤ 0 → null.
 */
export function modifiedDietz(days, v0) {
    const T = days.length;
    if (T === 0)
        return null;
    const net = sum(days.map((d) => d.net));
    let weighted = 0;
    for (let i = 0; i < T; i++)
        weighted += ((T - i) / T) * days[i].transfers;
    if (Math.abs(v0) < 1e-9 && weighted < Math.max(ZERO_RULE_MIN, 2 * Math.abs(net)))
        return null;
    const denom = v0 + weighted;
    if (!(denom > 0))
        return null;
    return net / denom;
}
/**
 * Sub-period TWR: records inside [from, to] in (time, tranId) order;
 * every flow (and non-trading bonus — capital, not performance) closes the
 * running sub-period: r_k = Σnet_k / balanceAtStart_k. Sub-periods with
 * balanceAtStart < $10 and net ≠ 0 are skipped (counted); empty ones (net = 0)
 * are dropped silently. twr = Π(1 + r_k) − 1, null when no sub-period survived.
 */
export function subPeriodTwr(records, rate, opts) {
    const rows = records.filter((r) => r.time >= opts.from && r.time <= opts.to).sort((a, b) => a.time - b.time || a.tranId - b.tranId);
    let balance = opts.startBalance; // balance at the start of the running sub-period
    let segNet = 0; // Σnet inside the running sub-period
    let product = 1;
    let subPeriods = 0;
    let skipped = 0;
    const close = () => {
        if (segNet === 0)
            return; // empty sub-period: dropped silently
        if (balance < TWR_MIN_BALANCE)
            skipped++;
        else {
            product *= 1 + segNet / balance;
            subPeriods++;
        }
    };
    for (const r of rows) {
        const k = rate(r.asset, dayKey(r.time));
        if (k === undefined)
            continue; // unpriced asset: not in money analytics
        const v = num(r.income) * k;
        const kind = incomeKind(r.incomeType);
        if (kind === 'flow' || kind === 'nonTrading') {
            close();
            balance += segNet + v;
            segNet = 0;
        }
        else {
            segNet += v;
        }
    }
    close();
    return { twr: subPeriods ? product - 1 : null, subPeriods, skipped };
}
/** Last day i ≥ 1 whose deposit is ≥ 20 % of the previous day's closing balance. */
export function detectCapitalStep(daily) {
    for (let i = daily.length - 1; i >= 1; i--) {
        const d = daily[i];
        const prev = daily[i - 1];
        if (d.transfers > 0 && d.transfers >= 0.2 * prev.balance)
            return { index: i, date: d.date, amount: d.transfers };
    }
    return null;
}
