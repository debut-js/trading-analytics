/* Browser mirror of format.ts. Served as
   /binance-dashboard/format.js and loaded before page.js; page.js reads it as
   BD.format. format-parity.test.ts asserts byte-equality with format.ts —
   port every change of format.ts here in the same commit. */
(function (root) {
  'use strict';
  /* U+2212 — a real minus sign, never the hyphen. */
  var MINUS = '−';
  var EN_DASH = '–';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* '1234567' → '1,234,567'. */
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /* `a` rounded to `dp` decimals exactly as toFixed would print it (so tier checks agree with the output). */
  function roundTo(a, dp) { return Number(a.toFixed(dp)); }
  /* Fixed-dp text of |v| with a U+2212 for negatives; a value that rounds to zero carries no sign. */
  function fixed(v, dp) {
    var body = Math.abs(v).toFixed(dp);
    return (v < 0 && Number(body) !== 0 ? MINUS : '') + body;
  }
  /* Unsigned magnitude with the §5.2 thresholds; the tier is chosen AFTER rounding to that tier's precision
     ('999.996' → '1,000.0', '9999.96' → '10.0k', '999999.96' → '1.0M'). */
  function magnitude(a) {
    if (roundTo(a, 2) < 1000) return a.toFixed(2);
    if (roundTo(a, 1) < 10000) {
      var parts = a.toFixed(1).split('.');
      return group(parts[0] || '0') + '.' + (parts[1] || '0');
    }
    if (roundTo(a / 1000, 1) < 1000) return (a / 1000).toFixed(1) + 'k';
    return (a / 1000000).toFixed(1) + 'M';
  }
  function signOf(v) { return v < 0 ? MINUS : '+'; }

  /* Signed money: '+$25.35', '−$31.05', '+$1,234.5', '+$115.4k'; zero → '$0' (never '+$0.00'), the one zero of the page. */
  function money(v) {
    var a = Math.abs(v);
    if (a < 0.005) return '$0';
    return signOf(v) + '$' + magnitude(a);
  }
  /* Signed integer money for axes/markers: '+$25', '−$31'; rounds to zero → '$0'. */
  function money0(v) {
    var r = Math.round(Math.abs(v));
    if (r === 0) return '$0';
    return signOf(v) + '$' + group(String(r));
  }
  /* Unsigned money with the money thresholds: '$473.94', '$1,234.5', '$115.4k'; zero → '$0'. */
  function usd(v) {
    var a = Math.abs(v);
    if (a < 0.005) return '$0';
    return '$' + magnitude(a);
  }
  /* Unsigned integer money: '$474'. */
  function usd0(v) { return '$' + group(String(Math.round(Math.abs(v)))); }
  /* Fraction in (0.165 → '+16.5%'). 1 dp, 2 dp below 1 % — judged on the value rounded to 2 dp.
     Signed by default; { sign: false } drops the '+' only — negatives always carry '−'. Zero → '0.0%'. */
  function pct(v, opts) {
    var o = opts || {};
    var p = Math.abs(v) * 100;
    var r2 = roundTo(p, 2);
    if (r2 === 0) return '0.0%';
    var body = (r2 < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
    if (v < 0) return MINUS + body;
    return o.sign === false ? body : '+' + body;
  }
  /* 5 significant digits: '1.8944', '0.0022560', '275.45'. Large prices avoid exponent form. */
  function price(v) {
    if (v === 0) return '0';
    var s = v.toPrecision(5);
    return s.indexOf('e') >= 0 ? String(Number(s)) : s;
  }
  /* '1,385'. Rounds the magnitude (half away from zero), then signs it; rounds to zero → '0'. */
  function int(n) {
    var r = Math.round(Math.abs(n));
    return (n < 0 && r !== 0 ? MINUS : '') + group(String(r));
  }
  /* '1.6×'; negatives use '−' (U+2212); rounds to zero → '0.0×'. */
  function mult(v) { return fixed(v, 1) + '×'; }
  /* Fraction in → '4.1 bps'; negatives use '−' (U+2212); rounds to zero → '0.0 bps'. */
  function bps(v) { return fixed(v * 10000, 1) + ' bps'; }

  function parseDay(day) { return new Date(day + 'T00:00:00Z'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /* ms → 'YYYY-MM-DD' (UTC) — same as analytics.ts dayKey. */
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  /* '2026-10-09' → '9 Oct'. */
  function dShort(day) { var d = parseDay(day); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  /* '2026-10-08' → 'Thu 8 Oct'. */
  function dLong(day) { var d = parseDay(day); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  /* '2026-10-09' → '9 Oct 2026'. */
  function dFull(day) { var d = parseDay(day); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  /* ms → '9 Oct 23:30' (UTC). */
  function dTime(ms) {
    var d = new Date(ms);
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }
  /* '9–13 Sep' | '28 Sep–4 Oct' (en dash, no spaces); same day → '9 Sep'; different years → '28 Dec 2025–4 Jan 2026'. */
  function dRange(from, to) {
    if (from === to) return dShort(from);
    var a = parseDay(from);
    var b = parseDay(to);
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return dFull(from) + EN_DASH + dFull(to);
    if (a.getUTCMonth() === b.getUTCMonth()) return a.getUTCDate() + EN_DASH + b.getUTCDate() + ' ' + MON[b.getUTCMonth()];
    return dShort(from) + EN_DASH + dShort(to);
  }
  /* '2026-09' → 'Sep 2026'. */
  function monthLabel(key) { var p = key.split('-'); return MON[Number(p[1]) - 1] + ' ' + p[0]; }
  /* Minutes → '42 m' | '3 h 00 m' | '2 d 03 h'. */
  function hold(min) {
    var m = Math.max(0, Math.round(min));
    if (m < 60) return m + ' m';
    if (m < 1440) return Math.floor(m / 60) + ' h ' + pad2(m % 60) + ' m';
    var d = Math.floor(m / 1440);
    var h = Math.floor((m % 1440) / 60);
    return d + ' d ' + pad2(h) + ' h';
  }
  /* 'just now' (< 45 s) | '2 min ago' | '5 h ago' | '3 d ago'. Minutes are rounded first, hours and days floored. */
  function ago(ms, now) {
    var s = Math.max(0, now - ms) / 1000;
    if (s < 45) return 'just now';
    var m = s / 60;
    var rm = Math.round(m);
    if (rm < 60) return Math.max(1, rm) + ' min ago';
    var h = m / 60;
    if (h < 24) return Math.max(1, Math.floor(h)) + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  root.BDFormat = {
    MINUS: MINUS,
    money: money, money0: money0, usd: usd, usd0: usd0, pct: pct, price: price, int: int, mult: mult, bps: bps,
    dShort: dShort, dLong: dLong, dFull: dFull, dTime: dTime, dRange: dRange, monthLabel: monthLabel,
    hold: hold, ago: ago, dayKey: dayKey,
  };
})(typeof window !== 'undefined' ? window : globalThis);
