// Round-trip ("trip") reconstruction from userTrades —, verbatim.
// Pure: no I/O, `now` is injected. Anchored on positionRisk.positionAmt, walks
// fills backwards to learn the position before every fill, then forwards to
// classify each fill as opening / reducing / flipping.

import { dayKey, type DailyPoint, type IncomeRecord, type RateFn, type UserTrade } from './analytics.js';
import { sourceOf, type SourceKey } from './sources.js';

export interface Trip {
  symbol: string;
  /** The exchange: trips never span sources, a symbol traded on both gives two trips. */
  source: SourceKey;
  /** The symbol's leverage setting on the anchor row; null when the row is missing (flat symbol on Bybit) or unset. */
  leverage: number | null;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  direction: 'long' | 'short';
  entryTime: number;
  exitTime: number | null;
  holdMin: number | null;
  entryVwap: number;
  exitVwap: number | null;
  /** max |pos| during the trip */
  qty: number;
  /** Σ quoteQty of opening legs / closing legs / opening legs filled as taker */
  entryNotional: number;
  exitNotional: number;
  entryTakerNotional: number;
  /** Σ realizedPnl; a flip fill's realizedPnl goes entirely to the trip it closes (Binance books it on the reduced part only, §3.2 step 3) */
  gross: number;
  /** POSITIVE magnitude: Σ commission × rate(commissionAsset, dayKey(fill.time)) */
  fees: number;
  /** Σ FUNDING_FEE of the symbol with time ∈ [entryTime, exitTime ?? now], signed as Binance gives it */
  funding: number;
  /** gross − fees + funding */
  net: number;
  /** net / entryNotional (fraction); 0 when entryNotional = 0 (truncated trip with no in-window entry legs) */
  retNotional: number;
  equityAtEntry: number;
  /** entryNotional / equityAtEntry; null when equityAtEntry ≤ 0 */
  sizeX: number | null;
  legs: { entry: 'M' | 'T' | 'mixed'; exit: 'M' | 'T' | 'mixed' | null };
  fills: number;
  truncated: boolean;
  status: 'closed' | 'open';
  r: number | null;
}

export interface TripsInput {
  trades: UserTrade[];
  /** UNFILTERED positionRisk (anchor); Bybit rows carry `source: 'bybit'` and list open positions only */
  positions: { symbol: string; positionSide: string; positionAmt: string; source?: SourceKey; leverage?: string }[];
  /** any records; the module picks FUNDING_FEE */
  income: IncomeRecord[];
  rate: RateFn;
  daily: DailyPoint[];
  hedgeMode: boolean;
  now: number;
}

export interface TripsResult {
  trips: Trip[];
  warnings: string[];
}

const MINUTE = 60_000;

const num = (s: string | number | undefined): number => {
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : 0;
};
/** Quantities are decimal strings with ≤ 8 places; re-round after every add so a flat position is exactly 0. */
const q8 = (x: number): number => Math.round(x * 1e8) / 1e8;
const sign = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const round1 = (x: number): number => Math.round(x * 10) / 10;
const fillCount = (n: number): string => `${n} ${n === 1 ? 'fill' : 'fills'}`;

const legStyle = (maker: number, taker: number): 'M' | 'T' | 'mixed' | null => (maker + taker === 0 ? null : taker === 0 ? 'M' : maker === 0 ? 'T' : 'mixed');

/** Mutable accumulator for the trip being built. */
interface Acc {
  symbol: string;
  source: SourceKey;
  leverage: number | null;
  positionSide: Trip['positionSide'];
  direction: Trip['direction'];
  entryTime: number;
  lastTime: number;
  qty: number;
  fills: number;
  truncated: boolean;
  gross: number;
  fees: number;
  entryQty: number;
  entryNotional: number;
  entryTakerNotional: number;
  entryMaker: number;
  entryTaker: number;
  exitQty: number;
  exitNotional: number;
  exitMaker: number;
  exitTaker: number;
}

interface Anchor {
  posEnd: number;
  leverage: number | null;
}

const openAcc = (symbol: string, src: SourceKey, leverage: number | null, positionSide: Trip['positionSide'], direction: Trip['direction'], entryTime: number, qty0: number, truncated: boolean): Acc => ({
  symbol,
  source: src,
  leverage,
  positionSide,
  direction,
  entryTime,
  lastTime: entryTime,
  qty: qty0,
  fills: 0,
  truncated,
  gross: 0,
  fees: 0,
  entryQty: 0,
  entryNotional: 0,
  entryTakerNotional: 0,
  entryMaker: 0,
  entryTaker: 0,
  exitQty: 0,
  exitNotional: 0,
  exitMaker: 0,
  exitTaker: 0,
});

/**
 * Apply `part` (0 < part ≤ 1, fraction of the fill's qty) of a fill to the trip as an entry or exit leg.
 * Commission and the quantity fields are prorated by `part`; realizedPnl never is: it goes whole to the leg
 * that carries it (`withPnl`). On a flip Binance books it on the reducing part only, so the flip's opening leg passes false.
 */
function addLeg(a: Acc, kind: 'entry' | 'exit', f: UserTrade, fee: number, part: number, withPnl = true): void {
  const qty = num(f.qty) * part;
  const quote = num(f.quoteQty) * part;
  a.fills++;
  a.lastTime = Math.max(a.lastTime, f.time);
  if (withPnl) a.gross += num(f.realizedPnl);
  a.fees += fee * part;
  if (kind === 'entry') {
    a.entryQty += qty;
    a.entryNotional += quote;
    if (f.maker) a.entryMaker++;
    else {
      a.entryTaker++;
      a.entryTakerNotional += quote;
    }
  } else {
    a.exitQty += qty;
    a.exitNotional += quote;
    if (f.maker) a.exitMaker++;
    else a.exitTaker++;
  }
}

function finish(a: Acc, status: Trip['status']): Trip {
  const exitTime = status === 'closed' ? a.lastTime : null;
  const net = a.gross - a.fees; // funding is added in the second pass
  return {
    symbol: a.symbol,
    source: a.source,
    leverage: a.leverage,
    positionSide: a.positionSide,
    direction: a.direction,
    entryTime: a.entryTime,
    exitTime,
    holdMin: exitTime === null ? null : round1((exitTime - a.entryTime) / MINUTE),
    entryVwap: a.entryQty > 0 ? a.entryNotional / a.entryQty : 0,
    exitVwap: a.exitQty > 0 ? a.exitNotional / a.exitQty : null,
    qty: a.qty,
    entryNotional: a.entryNotional,
    exitNotional: a.exitNotional,
    entryTakerNotional: a.entryTakerNotional,
    gross: a.gross,
    fees: a.fees,
    funding: 0,
    net,
    retNotional: a.entryNotional > 0 ? net / a.entryNotional : 0,
    equityAtEntry: 0,
    sizeX: null,
    // A truncated trip may have no in-window entry legs: 'mixed' = unknown.
    legs: { entry: legStyle(a.entryMaker, a.entryTaker) ?? 'mixed', exit: legStyle(a.exitMaker, a.exitTaker) },
    fills: a.fills,
    truncated: a.truncated,
    status,
    r: null,
  };
}

/** Balance at the end of the previous day + transfers of the entry day; 0 when the day is not in `daily`. */
export function equityAtEntry(daily: DailyPoint[], entryTime: number): number {
  const day = dayKey(entryTime);
  const idx = daily.findIndex((d) => d.date === day);
  if (idx < 0) return 0;
  const prev = idx > 0 ? (daily[idx - 1] as DailyPoint).balance : 0;
  return prev + (daily[idx] as DailyPoint).transfers;
}

/** §3.2. Key = `${source}|${symbol}`, plus `|${positionSide}` in hedge mode (or for a fill with a side, Bybit's hedge mode). Output: open trips first (entryTime desc), then closed by exitTime desc. */
export function reconstructTrips(input: TripsInput): TripsResult {
  const { trades, positions, hedgeMode, rate, now, daily } = input;
  const warnings: string[] = [];
  const unpriced = new Map<string, number>();
  const priced = (asset: string, time: number, native: number): number => {
    const r = rate(asset, dayKey(time));
    if (r === undefined) {
      unpriced.set(asset, (unpriced.get(asset) ?? 0) + 1);
      return 0;
    }
    return native * r;
  };

  // Step 1: group by key, sort by (time, id). Zero-quantity fills change no position (and would open phantom trips): skipped and counted.
  const groups = new Map<string, UserTrade[]>();
  const zeroQty = new Map<string, number>();
  const sided = (positionSide: string): boolean => hedgeMode || positionSide !== 'BOTH';
  for (const t of trades) {
    const key = sided(t.positionSide) ? `${sourceOf(t)}|${t.symbol}|${t.positionSide}` : `${sourceOf(t)}|${t.symbol}`;
    if (num(t.qty) === 0) {
      zeroQty.set(key, (zeroQty.get(key) ?? 0) + 1);
      continue;
    }
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(t);
  }
  for (const [key, n] of zeroQty) warnings.push(`trips: ${key}: skipped ${fillCount(n)} with zero quantity`);

  const anchor = (key: string, src: SourceKey, symbol: string, side: string): Anchor => {
    const want = sided(side) ? side : 'BOTH';
    const p = positions.find((x) => sourceOf(x) === src && x.symbol === symbol && x.positionSide === want);
    if (p) {
      const lev = Number(p.leverage);
      return { posEnd: q8(num(p.positionAmt)), leverage: Number.isFinite(lev) && lev > 0 ? lev : null };
    }
    // Binance's positionRisk is unfiltered, so a traded key missing from a non-empty list has no known end state: assume flat,
    // but say so. Bybit lists open positions only: a missing row there is flat by definition.
    if (src === 'binance' && positions.some((x) => sourceOf(x) === 'binance')) warnings.push(`trips: ${key}: no positionRisk row; assuming flat`);
    return { posEnd: 0, leverage: null };
  };

  const out: Trip[] = [];
  for (const [key, fills] of groups) {
    fills.sort((a, b) => a.time - b.time || a.id - b.id);
    const first = fills[0];
    if (!first) continue;
    const { symbol, positionSide } = first;
    const src = sourceOf(first);
    const { posEnd, leverage } = anchor(key, src, symbol, positionSide);
    // The walk ends at posEnd by construction, so this heuristic is the mismatch signal: Binance writes realizedPnl only
    // on reducing fills, so PnL on a position increase means fills and positionRisk disagree (missing fills, stale anchor).
    let pnlOnIncrease = 0;
    const checkIncrease = (f: UserTrade): void => {
      if (num(f.realizedPnl) !== 0) pnlOnIncrease++;
    };

    // Step 2: anchor on the known end state and walk backwards → position before every fill.
    const before = new Array<number>(fills.length);
    let after = posEnd;
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i] as UserTrade;
      const s = f.side === 'BUY' ? num(f.qty) : -num(f.qty);
      const b = q8(after - s);
      before[i] = b;
      after = b;
    }

    // Steps 3–4: forward classification from pos_0.
    let pos = before[0] ?? 0;
    let acc: Acc | null = pos !== 0 ? openAcc(symbol, src, leverage, positionSide, pos > 0 ? 'long' : 'short', first.time, Math.abs(pos), true) : null;
    for (const f of fills) {
      const qty = num(f.qty);
      const s = f.side === 'BUY' ? qty : -qty;
      const next = q8(pos + s);
      const fee = priced(f.commissionAsset, f.time, num(f.commission));
      if (pos === 0) {
        // 0 → ≠0: a trip starts.
        checkIncrease(f);
        acc = openAcc(symbol, src, leverage, positionSide, next > 0 ? 'long' : 'short', f.time, 0, false);
        addLeg(acc, 'entry', f, fee, 1);
      } else if (next === 0 || sign(next) === sign(pos)) {
        if (!acc) throw new Error(`trips: ${key}: position without a trip`);
        if (Math.abs(next) > Math.abs(pos)) {
          checkIncrease(f);
          addLeg(acc, 'entry', f, fee, 1);
        } else {
          addLeg(acc, 'exit', f, fee, 1);
        }
        if (next === 0) {
          out.push(finish(acc, 'closed'));
          acc = null;
        }
      } else {
        // Flip: close |pos|, open |next|. Commission and quantities are prorated by qty (§3.2 step 3); realizedPnl goes
        // whole to the closing leg, because Binance books it on the reduced part only (the opening leg carries 0).
        if (!acc) throw new Error(`trips: ${key}: position without a trip`);
        const closing = Math.abs(pos) / qty;
        addLeg(acc, 'exit', f, fee, closing);
        out.push(finish(acc, 'closed'));
        acc = openAcc(symbol, src, leverage, positionSide, next > 0 ? 'long' : 'short', f.time, 0, false);
        addLeg(acc, 'entry', f, fee, 1 - closing, false);
      }
      if (acc) acc.qty = Math.max(acc.qty, Math.abs(next));
      pos = next;
    }
    if (acc) out.push(finish(acc, 'open'));
    if (pnlOnIncrease > 0) warnings.push(`trips: ${key}: ${fillCount(pnlOnIncrease)} with realizedPnl on a position increase — anchor may be stale`);
  }

  // Second pass: funding, equity at entry, net (§3.2 step 5). Funding of one exchange never lands on the other's trip.
  const bySymbol = new Map<string, Trip[]>();
  for (const t of out) {
    const k = `${t.source}|${t.symbol}`;
    let g = bySymbol.get(k);
    if (!g) {
      g = [];
      bySymbol.set(k, g);
    }
    g.push(t);
  }
  for (const r of input.income) {
    if (r.incomeType !== 'FUNDING_FEE') continue;
    const trips = bySymbol.get(`${sourceOf(r)}|${r.symbol}`);
    if (!trips) continue;
    // Every trip whose life covers the record shares it equally: both sides in hedge
    // mode, or the two trips of a flip when funding lands on the flip's own millisecond.
    const covering = trips.filter((t) => t.entryTime <= r.time && r.time <= (t.exitTime ?? now));
    if (covering.length === 0) continue;
    const v = priced(r.asset, r.time, num(r.income)) / covering.length;
    for (const t of covering) t.funding += v;
  }
  for (const t of out) {
    t.net = t.gross - t.fees + t.funding;
    t.retNotional = t.entryNotional > 0 ? t.net / t.entryNotional : 0;
    t.equityAtEntry = equityAtEntry(daily, t.entryTime);
    t.sizeX = t.equityAtEntry > 0 ? t.entryNotional / t.equityAtEntry : null;
  }

  for (const [asset, n] of unpriced) warnings.push(`trips: no rate for ${asset} on ${n} records; counted as 0`);

  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.status === 'open') return b.entryTime - a.entryTime;
    return (b.exitTime ?? 0) - (a.exitTime ?? 0) || b.entryTime - a.entryTime;
  });
  return { trips: out, warnings };
}

/** Breakeven = net rounds to 0 cents (§3.2 step 7): not a win, not a loss, still in the win-rate denominator. */
export function tripOutcome(t: Trip): 'win' | 'loss' | 'breakeven' {
  if (Math.round(t.net * 100) === 0) return 'breakeven';
  return t.net > 0 ? 'win' : 'loss';
}

/** Statistics run only over closed, untruncated trips (§3.2 step 6). */
export function isCounted(t: Trip): boolean {
  return t.status === 'closed' && !t.truncated;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
};

/** 1R = median |retNotional| over counted losers (§3.1 "1R"); null when there are none. */
export function oneROf(trips: Trip[]): number | null {
  const losers = trips.filter((t) => isCounted(t) && tripOutcome(t) === 'loss').map((t) => Math.abs(t.retNotional));
  return losers.length ? median(losers) : null;
}

/** t.r = retNotional / oneR for counted trips, null otherwise (mutates). */
export function assignR(trips: Trip[], oneR: number | null): void {
  for (const t of trips) t.r = isCounted(t) && oneR ? t.retNotional / oneR : null;
}
