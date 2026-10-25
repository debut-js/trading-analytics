import { dayKey } from './analytics.js';
export { dayKey };
/** U+2212 — a real minus sign, never the hyphen. */
export declare const MINUS = "\u2212";
/** Signed money: '+$25.35', '−$31.05', '+$1,234.5', '+$115.4k'; zero → '0.00' (never '+$0.00'). */
export declare function money(v: number): string;
/** Signed integer money for axes/markers: '+$25', '−$31'; rounds to zero → '$0'. */
export declare function money0(v: number): string;
/** Unsigned money with the money thresholds: '$473.94', '$1,234.5', '$115.4k'; zero → '0.00'. */
export declare function usd(v: number): string;
/** Unsigned integer money: '$474'. */
export declare function usd0(v: number): string;
/**
 * Fraction in (0.165 → '+16.5%'). 1 dp, 2 dp below 1 % — judged on the value
 * rounded to 2 dp, so 0.999 % prints '1.0%', never '1.00%'. Signed by default;
 * { sign: false } drops the '+' only — negatives always carry '−'. Zero → '0.0%'.
 */
export declare function pct(v: number, opts?: {
    sign?: boolean;
}): string;
/** 5 significant digits: '1.8944', '0.0022560', '275.45'. Large prices avoid exponent form. */
export declare function price(v: number): string;
/** '1,385'. Rounds the magnitude (half away from zero), then signs it; rounds to zero → '0'. */
export declare function int(n: number): string;
/** '1.6×'; negatives use '−' (U+2212); rounds to zero → '0.0×'. */
export declare function mult(v: number): string;
/** Fraction in → '4.1 bps'; negatives use '−' (U+2212); rounds to zero → '0.0 bps'. */
export declare function bps(v: number): string;
/** '2026-10-09' → '9 Oct'. */
export declare function dShort(day: string): string;
/** '2026-10-08' → 'Thu 8 Oct'. */
export declare function dLong(day: string): string;
/** '2026-10-09' → '9 Oct 2026'. */
export declare function dFull(day: string): string;
/** ms → '9 Oct 23:30' (UTC). */
export declare function dTime(ms: number): string;
/** '9–13 Sep' | '28 Sep–4 Oct' (en dash, no spaces); same day → '9 Sep'; different years → '28 Dec 2025–4 Jan 2026'. */
export declare function dRange(from: string, to: string): string;
/** '2026-09' → 'Sep 2026'. */
export declare function monthLabel(key: string): string;
/** Minutes → '42 m' | '3 h 00 m' | '2 d 03 h'. */
export declare function hold(min: number): string;
/** 'just now' (< 45 s) | '2 min ago' | '5 h ago' | '3 d ago'. Minutes are rounded first, so 59.5+ min is '1 h ago', never '60 min ago'. */
export declare function ago(ms: number, now: number): string;
