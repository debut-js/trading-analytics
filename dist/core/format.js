// Server-side number/date formatter.
// The client file format.js (window.BDFormat) mirrors this module function by
// function, keep the two in step. Keep this
// file free of Node-only APIs so the mirror stays a straight port.
import { dayKey } from './analytics.js';
export { dayKey };
/** U+2212 — a real minus sign, never the hyphen. */
export const MINUS = '−';
const EN_DASH = '–';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** '1234567' → '1,234,567'. */
function group(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** `a` rounded to `dp` decimals exactly as toFixed would print it (so tier checks agree with the output). */
const roundTo = (a, dp) => Number(a.toFixed(dp));
/** Fixed-dp text of |v| with a U+2212 for negatives; a value that rounds to zero carries no sign. */
function fixed(v, dp) {
    const body = Math.abs(v).toFixed(dp);
    return `${v < 0 && Number(body) !== 0 ? MINUS : ''}${body}`;
}
/**
 * Unsigned magnitude with the §5.2 thresholds:
 * |x| < 1 000 → 2 dp; 1 000 ≤ |x| < 10 000 → 1 dp with thousands separator;
 * ≥ 10 000 → k with 1 dp; ≥ 1 000 000 → M with 1 dp.
 * The tier is chosen AFTER rounding to that tier's precision, so a value that
 * rounds up across a boundary is promoted ('999.996' → '1,000.0', '9999.96' → '10.0k',
 * '999999.96' → '1.0M') instead of printing at the lower tier's precision.
 */
function magnitude(a) {
    if (roundTo(a, 2) < 1000)
        return a.toFixed(2);
    if (roundTo(a, 1) < 10_000) {
        const [i, f] = a.toFixed(1).split('.');
        return `${group(i ?? '0')}.${f ?? '0'}`;
    }
    if (roundTo(a / 1000, 1) < 1000)
        return `${(a / 1000).toFixed(1)}k`;
    return `${(a / 1_000_000).toFixed(1)}M`;
}
const signOf = (v) => (v < 0 ? MINUS : '+');
/** Signed money: '+$25.35', '−$31.05', '+$1,234.5', '+$115.4k'; zero → '0.00' (never '+$0.00'). */
export function money(v) {
    const a = Math.abs(v);
    if (a < 0.005)
        return '0.00';
    return `${signOf(v)}$${magnitude(a)}`;
}
/** Signed integer money for axes/markers: '+$25', '−$31'; rounds to zero → '$0'. */
export function money0(v) {
    const r = Math.round(Math.abs(v));
    if (r === 0)
        return '$0';
    return `${signOf(v)}$${group(String(r))}`;
}
/** Unsigned money with the money thresholds: '$473.94', '$1,234.5', '$115.4k'; zero → '0.00'. */
export function usd(v) {
    const a = Math.abs(v);
    if (a < 0.005)
        return '0.00';
    return `$${magnitude(a)}`;
}
/** Unsigned integer money: '$474'. */
export function usd0(v) {
    return `$${group(String(Math.round(Math.abs(v))))}`;
}
/**
 * Fraction in (0.165 → '+16.5%'). 1 dp, 2 dp below 1 % — judged on the value
 * rounded to 2 dp, so 0.999 % prints '1.0%', never '1.00%'. Signed by default;
 * { sign: false } drops the '+' only — negatives always carry '−'. Zero → '0.0%'.
 */
export function pct(v, opts = {}) {
    const p = Math.abs(v) * 100;
    const r2 = roundTo(p, 2);
    if (r2 === 0)
        return '0.0%';
    const body = `${r2 < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
    if (v < 0)
        return MINUS + body;
    return opts.sign === false ? body : `+${body}`;
}
/** 5 significant digits: '1.8944', '0.0022560', '275.45'. Large prices avoid exponent form. */
export function price(v) {
    if (v === 0)
        return '0';
    const s = v.toPrecision(5);
    return s.includes('e') ? String(Number(s)) : s;
}
/** '1,385'. Rounds the magnitude (half away from zero), then signs it; rounds to zero → '0'. */
export function int(n) {
    const r = Math.round(Math.abs(n));
    return `${n < 0 && r !== 0 ? MINUS : ''}${group(String(r))}`;
}
/** '1.6×'; negatives use '−' (U+2212); rounds to zero → '0.0×'. */
export function mult(v) {
    return `${fixed(v, 1)}×`;
}
/** Fraction in → '4.1 bps'; negatives use '−' (U+2212); rounds to zero → '0.0 bps'. */
export function bps(v) {
    return `${fixed(v * 10_000, 1)} bps`;
}
const parseDay = (day) => new Date(`${day}T00:00:00Z`);
/** '2026-10-09' → '9 Oct'. */
export function dShort(day) {
    const d = parseDay(day);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
/** '2026-10-08' → 'Thu 8 Oct'. */
export function dLong(day) {
    const d = parseDay(day);
    return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
/** '2026-10-09' → '9 Oct 2026'. */
export function dFull(day) {
    const d = parseDay(day);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** ms → '9 Oct 23:30' (UTC). */
export function dTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${hh}:${mm}`;
}
/** '9–13 Sep' | '28 Sep–4 Oct' (en dash, no spaces); same day → '9 Sep'; different years → '28 Dec 2025–4 Jan 2026'. */
export function dRange(from, to) {
    if (from === to)
        return dShort(from);
    const a = parseDay(from);
    const b = parseDay(to);
    if (a.getUTCFullYear() !== b.getUTCFullYear())
        return `${dFull(from)}${EN_DASH}${dFull(to)}`;
    if (a.getUTCMonth() === b.getUTCMonth())
        return `${a.getUTCDate()}${EN_DASH}${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
    return `${dShort(from)}${EN_DASH}${dShort(to)}`;
}
/** '2026-09' → 'Sep 2026'. */
export function monthLabel(key) {
    const [y, m] = key.split('-');
    return `${MON[Number(m) - 1]} ${y}`;
}
/** Minutes → '42 m' | '3 h 00 m' | '2 d 03 h'. */
export function hold(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60)
        return `${m} m`;
    if (m < 1440)
        return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return `${d} d ${String(h).padStart(2, '0')} h`;
}
/** 'just now' (< 45 s) | '2 min ago' | '5 h ago' | '3 d ago'. Minutes are rounded first, so 59.5+ min is '1 h ago', never '60 min ago'. */
export function ago(ms, now) {
    const s = Math.max(0, now - ms) / 1000;
    if (s < 45)
        return 'just now';
    const m = s / 60;
    const rm = Math.round(m);
    if (rm < 60)
        return `${Math.max(1, rm)} min ago`;
    const h = m / 60;
    if (h < 24)
        return `${Math.max(1, Math.floor(h))} h ago`;
    return `${Math.floor(h / 24)} d ago`;
}
