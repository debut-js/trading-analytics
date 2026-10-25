// WindowStats for the three page windows. The
// server computes everything; the client only picks `windows[w]` and draws.
//
// A window is a trailing slice of the daily series: `all` = since inception,
// `ytd` = since 1 Jan (UTC) of the current year, `60d` / `30d` = the last 60 / 30
// calendar days (today included) — the public set of 2026-10-18; the data's own
// start (report.ts DATA_START) stays the cut under every one of them. The fills
// window inside it starts at tradesFrom = max(window start, now − lookback).
// Pure: no clock, no I/O; `now` and `rate` are injected.

import { dayKey, type DailyPoint, type IncomeRecord, type PnlBreakdown, type RateFn, type UserTrade } from './analytics.js';
import { drawdownStats, type DrawdownStats } from './drawdown.js';
import { exKurt, expectedStreaks, mean, median, pRunAtLeast, quantile, sampleStd, skew, sum, wilson } from './math.js';
import { detectCapitalStep, modifiedDietz, subPeriodTwr } from './returns.js';
import { isCounted, oneROf, tripOutcome, type Trip } from './trips.js';

const DAY = 86_400_000;

export type WindowKey = 'all' | 'ytd' | '60d' | '30d';
export const WINDOW_KEYS: WindowKey[] = ['all', 'ytd', '60d', '30d'];
/** Trailing day counts; `all` and `ytd` are cut by date instead. */
const WINDOW_DAYS: Record<WindowKey, number | null> = { all: null, ytd: null, '60d': 60, '30d': 30 };

/** Index of the first daily row of the current UTC year (`ytd`); the row count — an empty window — while the year has no row yet. */
function ytdStart(daily: DailyPoint[], now: number): number {
  const jan1 = `${new Date(now).getUTCFullYear()}-01-01`;
  const i = daily.findIndex((d) => d.date >= jan1);
  return i < 0 ? daily.length : i;
}

export interface SeriesPoint {
  date: string;
  net: number;
  /** cumulative net, restarting at 0 on the first day of the window */
  cum: number;
  /** cum − running peak, ≤ 0 */
  dd: number;
  balance: number;
  transfers: number;
  ret: number | null;
  realized: number;
  /** = commission (≤ 0) */
  fees: number;
  funding: number;
  active: boolean;
}

export interface DayRef {
  date: string;
  net: number;
}

/** byHour key 0..23 label '00'; byHour4 key 0..5 label '00–04'; byWeekday key 0..6 (Mon = 0) label 'Mon'; lowN = n < 10 */
export interface Bucket {
  key: number;
  label: string;
  n: number;
  net: number;
  winRate: number | null;
  lowN: boolean;
}

/** Symbols = trips in the window ∪ fills in the fills window; fees/funding carry Binance's sign (fees ≤ 0); sorted by net desc. */
export interface SymbolRow {
  symbol: string;
  net: number;
  realized: number;
  fees: number;
  funding: number;
  trips: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  profitFactor: number | null;
  volume: number;
  makerShare: number | null;
  lastActive: number | null;
  /** now − lastActive > 7 d (or never active) */
  dormant: boolean;
  /** trips < 5 */
  lowN: boolean;
  long: { trips: number; net: number };
  short: { trips: number; net: number };
}

/** share = realized_dir / Σ realized of both directions (null when Σ ≤ 0) */
export interface DirectionRow {
  direction: 'long' | 'short';
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  realized: number;
  share: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  medianHold: number | null;
}

/** 20 bins of 0.2 % from −2 % to +2 % (fractions); tails collapse into the end bins; modes = bin centres (null when n < 50 or a side is empty). */
export interface Histogram {
  unit: '%';
  step: number;
  bins: { from: number; to: number; n: number; net: number; winRate: number | null; tail: 'low' | 'high' | null }[];
  mean: number;
  modes: { loss: number; win: number } | null;
}

export interface WindowStats {
  key: WindowKey;
  days: number;
  from: string;
  to: string;
  /** dayKey(max(fromMs, now − tradesLookbackDays·DAY)) */
  tradesFrom: string;
  /** min(days, tradesLookbackDays) */
  tradesWindowDays: number;
  series: SeriesPoint[];
  pnl: PnlBreakdown;
  mwr: number | null;
  twr: number | null;
  twrSubPeriods: { n: number; skipped: number };
  /** Only when the capital step lies inside the window. net/ret/days cover the days AFTER the step day; preNet = Σnet of the window up to and including the step day. */
  sinceStep: { date: string; amount: number; net: number; ret: number | null; days: number; preNet: number } | null;
  drawdown: DrawdownStats;
  daily: {
    active: number;
    green: number;
    red: number;
    idle: number;
    mean: number;
    median: number;
    std: number;
    best: DayRef | null;
    worst: DayRef | null;
    p10: number;
    p90: number;
    skew: number;
    exKurt: number;
    gainToPain: number | null;
    streakGreen: number;
    streakRed: number;
  };
  /** active < 60 → hidden (sharpe, sortino and calmar are all null); < 90 → provisional; values as today's performance(); calmar null while CAGR < 0 */
  ratios: { sharpe: number | null; sortino: number | null; calmar: number | null; maturity: 'hidden' | 'provisional' | 'full' };
  trades: {
    n: number;
    truncated: number;
    open: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRate: number | null;
    wilson: [number, number] | null;
    profitFactor: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    payoff: number | null;
    expectancy: number | null;
    expectancyR: number | null;
    oneR: number | null;
    sqn: number | null;
    largestWin: number | null;
    largestLoss: number | null;
    /** breakeven ends both streaks */
    streaks: { w: number; l: number; expW: number; expL: number; pLoss6in100: number | null };
    /** minutes; winners/losers = medians */
    hold: { median: number; p10: number; p90: number; winners: number; losers: number } | null;
    /** edges 5,15,30,60,120,240,480,null — bin k collects holdMin ≤ upTo_k */
    holdHist: { upTo: number | null; n: number; net: number }[];
    sizeX: number | null;
    /** server always emits 'trip-net' */
    basis: 'trip-net' | 'order-gross';
  };
  fees: {
    /** = pnl.commission (≤ 0) */
    total: number;
    /** |total| / realized (null if realized ≤ 0) */
    shareOfGross: number | null;
    /** |total| / net (null if net ≤ 0) */
    shareOfNet: number | null;
    /** fills-window quantities; feesFills ≤ 0; bps = |feesFills| / volume */
    feesFills: number;
    volume: number;
    makerVolume: number;
    takerVolume: number;
    bps: number | null;
    /** −Σ trip.fees / n (≤ 0) */
    perTrip: number | null;
    makerShare: number | null;
    /** ISO weeks inside the fills window */
    makerWeekly: { week: string; makerShare: number | null }[];
    /** Σ entryTakerNotional × (taker − maker) per symbol rates; 0.10 × |total| */
    whatIf: { allMakerEntries: number; bnbDiscount: number; ratesAssumed: boolean };
  };
  bySymbol: SymbolRow[];
  byDirection: DirectionRow[];
  byHour: Bucket[];
  byHour4: Bucket[];
  byWeekday: Bucket[];
  concentration: { symbols: number; top2Share: number | null; netWithoutTop2: number; negativeSymbols: number; hhi: number | null; effectiveN: number | null };
  /** null when trades.n = 0 */
  histogram: Histogram | null;
  activity: { symbols: number; active7d: number; dormant: number; fills: number; orders: number; ordersPerDay: number };
}

export interface WindowsInput {
  daily: DailyPoint[];
  incomeRaw: IncomeRecord[];
  trades: UserTrade[];
  trips: Trip[];
  rate: RateFn;
  now: number;
  tradesLookbackDays: number;
  commissionRates: { symbol: string; maker: number; taker: number }[];
  /**
   * Wallet balance at the start of `daily[0]`. 0 (the default) when the series begins with the account itself;
   * report.ts passes the reconstructed balance when the 89-day income lookback cut the history, so the account
   * already held money on day 0. It is the V₀ of the window that starts at day 0 (`all`); `30d`/`7d` start from
   * the closing balance of the day before their first row instead.
   */
  openingBalance?: number;
}

// ───────────────────────────── income side ─────────────────────────────

function sumBreakdown(rows: PnlBreakdown[]): PnlBreakdown {
  const out: PnlBreakdown = { realized: 0, commission: 0, funding: 0, other: 0, nonTrading: 0, net: 0, transfers: 0 };
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

function buildSeries(slice: DailyPoint[]): SeriesPoint[] {
  let cum = 0;
  let peak = 0;
  return slice.map((d) => {
    cum += d.net;
    peak = Math.max(peak, cum);
    return { date: d.date, net: d.net, cum, dd: cum - peak, balance: d.balance, transfers: d.transfers, ret: d.ret, realized: d.realized, fees: d.commission, funding: d.funding, active: d.net !== 0 };
  });
}

/** the step is a property of the whole account; it is reported when its day lies inside the window. */
function computeSinceStep(daily: DailyPoint[], startIdx: number): WindowStats['sinceStep'] {
  const step = detectCapitalStep(daily);
  if (!step || step.index < startIdx) return null;
  const after = daily.slice(step.index + 1);
  const stepDay = daily[step.index] as DailyPoint;
  return {
    date: step.date,
    amount: step.amount,
    net: sum(after.map((d) => d.net)),
    ret: after.length ? modifiedDietz(after, stepDay.balance) : null,
    days: after.length,
    preNet: sum(daily.slice(startIdx, step.index + 1).map((d) => d.net)),
  };
}

function dailyBlock(slice: DailyPoint[]): WindowStats['daily'] {
  const active = slice.filter((d) => d.net !== 0);
  const nets = active.map((d) => d.net);
  let best: DayRef | null = null;
  let worst: DayRef | null = null;
  let green = 0;
  let red = 0;
  let maxGreen = 0;
  let maxRed = 0;
  for (const d of active) {
    if (!best || d.net > best.net) best = { date: d.date, net: d.net };
    if (!worst || d.net < worst.net) worst = { date: d.date, net: d.net };
    if (d.net > 0) {
      green++;
      red = 0;
    } else {
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
function ratiosBlock(slice: DailyPoint[], activeDays: number): WindowStats['ratios'] {
  const maturity = activeDays < 60 ? 'hidden' : activeDays < 90 ? 'provisional' : 'full';
  if (maturity === 'hidden') return { sharpe: null, sortino: null, calmar: null, maturity };
  const rets = slice.map((d) => d.ret).filter((r): r is number => r !== null);
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
function feesIncomeSide(pnl: PnlBreakdown): Pick<WindowStats['fees'], 'total' | 'shareOfGross' | 'shareOfNet'> & { bnbDiscount: number } {
  const total = pnl.commission;
  return {
    total,
    shareOfGross: pnl.realized > 0 ? Math.abs(total) / pnl.realized : null,
    shareOfNet: pnl.net > 0 ? Math.abs(total) / pnl.net : null,
    bnbDiscount: 0.1 * Math.abs(total),
  };
}

// ───────────────────────────── trade side ─────────────────────────────

type TradeBlocks = Pick<WindowStats, 'trades' | 'fees' | 'bySymbol' | 'byDirection' | 'byHour' | 'byHour4' | 'byWeekday' | 'concentration' | 'histogram' | 'activity'>;

interface TradeCtx {
  /** start of the window day, ms */
  fromMs: number;
  /** start of the tradesFrom day, ms — fills and trips are counted from here */
  tradesFromMs: number;
  tradesFrom: string;
  tradesWindowDays: number;
  pnl: PnlBreakdown;
}

const HOLD_EDGES: (number | null)[] = [5, 15, 30, 60, 120, 240, 480, null];
const HIST_MIN = -0.02;
const HIST_STEP = 0.002;
const HIST_BINS = 20;
/** VIP 0 (spec A2): used for every symbol when no rates are known → ratesAssumed */
const VIP0 = { maker: 0.0002, taker: 0.0005 };
const DORMANT_MS = 7 * DAY;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const num = (s: string | number): number => {
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : 0;
};
const pad2 = (n: number): string => String(n).padStart(2, '0');
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const hourOf = (t: Trip): number => new Date(t.entryTime).getUTCHours();

/** 00:00 UTC of the Thursday in the ISO week containing `ms`. */
function thursdayOf(ms: number): number {
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Mon = 0
  return ms - dow * DAY + 3 * DAY;
}

/** ISO week key 'YYYY-Www' (Mon–Sun, UTC) of a 'YYYY-MM-DD' day — '2026-09-09' → '2026-W37'. */
function isoWeekKey(day: string): string {
  const thu = thursdayOf(Date.parse(`${day}T00:00:00Z`));
  const year = new Date(thu).getUTCFullYear();
  const week = 1 + Math.round((thu - thursdayOf(Date.UTC(year, 0, 4))) / (7 * DAY));
  return `${year}-W${pad2(week)}`;
}

/** trade rows + A4: statistics over the counted trips of the window. */
function tradesBlock(all: Trip[], counted: Trip[], now: number, tradesFromMs: number): WindowStats['trades'] {
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
  const ordered = [...counted].sort((a, b) => (a.exitTime as number) - (b.exitTime as number) || a.entryTime - b.entryTime);
  let w = 0;
  let l = 0;
  let maxW = 0;
  let maxL = 0;
  for (const t of ordered) {
    const o = tripOutcome(t);
    if (o === 'win') {
      w++;
      l = 0;
    } else if (o === 'loss') {
      l++;
      w = 0;
    } else {
      w = 0;
      l = 0;
    }
    maxW = Math.max(maxW, w);
    maxL = Math.max(maxL, l);
  }
  const { expW, expL } = expectedStreaks(winRate ?? 0, n);

  const holdOf = (xs: Trip[]): number[] => xs.map((t) => t.holdMin).filter((h): h is number => h !== null);
  const holds = holdOf(counted);
  const holdHist = HOLD_EDGES.map((upTo) => ({ upTo, n: 0, net: 0 }));
  for (const t of counted) {
    if (t.holdMin === null) continue;
    const h = t.holdMin;
    const bin = holdHist[HOLD_EDGES.findIndex((e) => e === null || h <= e)];
    if (bin) {
      bin.n++;
      bin.net += t.net;
    }
  }
  const sizes = counted.map((t) => t.sizeX).filter((s): s is number => s !== null);

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
function pickRates(rates: WindowsInput['commissionRates']): (symbol: string) => { maker: number; taker: number } {
  const bySymbol = new Map(rates.map((r) => [r.symbol, { maker: r.maker, taker: r.taker }]));
  const freq = new Map<string, { maker: number; taker: number; n: number }>();
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
function feesBlock(counted: Trip[], fills: UserTrade[], pnl: PnlBreakdown, rates: WindowsInput['commissionRates'], rate: RateFn): WindowStats['fees'] {
  const income = feesIncomeSide(pnl);
  let feesFills = 0;
  let volume = 0;
  let makerVolume = 0;
  const weeks = new Map<string, { volume: number; maker: number }>();
  for (const f of fills) {
    const q = num(f.quoteQty);
    const k = rate(f.commissionAsset, dayKey(f.time));
    feesFills -= num(f.commission) * (k ?? 0); // Binance sign: fees ≤ 0; unpriced asset → 0
    volume += q;
    if (f.maker) makerVolume += q;
    const wk = isoWeekKey(dayKey(f.time));
    const wv = weeks.get(wk) ?? { volume: 0, maker: 0 };
    wv.volume += q;
    if (f.maker) wv.maker += q;
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

interface SymbolAcc {
  row: SymbolRow;
  makerVolume: number;
  grossWin: number;
  grossLoss: number;
}

/** A1: one row per symbol seen in the window's trips or fills; sorted by net desc. */
function symbolRows(counted: Trip[], fills: UserTrade[], now: number): SymbolRow[] {
  const acc = new Map<string, SymbolAcc>();
  const get = (symbol: string): SymbolAcc => {
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
    } else if (o === 'loss') {
      r.losses++;
      a.grossLoss -= t.net;
    } else r.breakeven++;
    r[t.direction].trips++;
    r[t.direction].net += t.net;
    r.lastActive = Math.max(r.lastActive ?? 0, t.exitTime ?? 0);
  }
  for (const f of fills) {
    const a = get(f.symbol);
    const q = num(f.quoteQty);
    a.row.volume += q;
    if (f.maker) a.makerVolume += q;
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
function directionRows(counted: Trip[]): DirectionRow[] {
  const realizedTotal = sum(counted.map((t) => t.gross));
  return (['long', 'short'] as const).map((direction) => {
    const xs = counted.filter((t) => t.direction === direction);
    const nets = xs.map((t) => t.net);
    const winNets = xs.filter((t) => tripOutcome(t) === 'win').map((t) => t.net);
    const lossNets = xs.filter((t) => tripOutcome(t) === 'loss').map((t) => t.net);
    const holds = xs.map((t) => t.holdMin).filter((h): h is number => h !== null);
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
function bucketRows(counted: Trip[], count: number, keyOf: (t: Trip) => number, labelOf: (k: number) => string): Bucket[] {
  const rows: Bucket[] = Array.from({ length: count }, (_, key) => ({ key, label: labelOf(key), n: 0, net: 0, winRate: null, lowN: true }));
  const wins = new Array<number>(count).fill(0);
  for (const t of counted) {
    const k = keyOf(t);
    const b = rows[k];
    if (!b) continue;
    b.n++;
    b.net += t.net;
    if (tripOutcome(t) === 'win') wins[k] = (wins[k] as number) + 1;
  }
  for (const b of rows) {
    b.winRate = b.n ? (wins[b.key] as number) / b.n : null;
    b.lowN = b.n < 10;
  }
  return rows;
}

/** A1 concentration line: top-2 / Σ winners; HHI = Σ(net_i / Σwinners)²; effective N = 1 / HHI; net without top-2. */
function concentrationBlock(rows: SymbolRow[]): WindowStats['concentration'] {
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

type HistBin = Histogram['bins'][number];

const tailOf = (i: number): HistBin['tail'] => (i === 0 ? 'low' : i === HIST_BINS - 1 ? 'high' : null);

/** A4.1: 20 bins of 0.2 % from −2 % to +2 % of notional (net), tails collapsed into the end bins. */
function histogramBlock(counted: Trip[]): Histogram | null {
  const n = counted.length;
  if (n === 0) return null;
  const bins: HistBin[] = Array.from({ length: HIST_BINS }, (_, i) => ({
    from: round6(HIST_MIN + i * HIST_STEP),
    to: round6(HIST_MIN + (i + 1) * HIST_STEP),
    n: 0,
    net: 0,
    winRate: null,
    tail: tailOf(i),
  }));
  const wins = new Array<number>(HIST_BINS).fill(0);
  for (const t of counted) {
    const i = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((t.retNotional - HIST_MIN) / HIST_STEP + 1e-9)));
    const b = bins[i] as HistBin;
    b.n++;
    b.net += t.net;
    if (tripOutcome(t) === 'win') wins[i] = (wins[i] as number) + 1;
  }
  bins.forEach((b, i) => {
    b.winRate = b.n ? (wins[i] as number) / b.n : null;
  });
  const modeOf = (side: HistBin[]): number | null => {
    let best: HistBin | null = null;
    for (const b of side) if (b.n > 0 && (best === null || b.n > best.n)) best = b;
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

function activityBlock(rows: SymbolRow[], fills: UserTrade[], tradesWindowDays: number): WindowStats['activity'] {
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
function tradeBlocks(input: WindowsInput, ctx: TradeCtx): TradeBlocks {
  const { now } = input;
  const inWindow = (t: number): boolean => t >= ctx.tradesFromMs && t <= now;
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
    byWeekday: bucketRows(counted, 7, (t) => (new Date(t.entryTime).getUTCDay() + 6) % 7, (k) => WEEKDAYS[k] as string),
    concentration: concentrationBlock(bySymbol),
    histogram: histogramBlock(counted),
    activity: activityBlock(bySymbol, fills, ctx.tradesWindowDays),
  };
}

// ───────────────────────────── composition ─────────────────────────────

export function computeWindow(input: WindowsInput, key: WindowKey): WindowStats {
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
  const v0 = startIdx > 0 ? (daily[startIdx - 1] as DailyPoint).balance : (input.openingBalance ?? 0);

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

export function computeWindows(input: WindowsInput): Record<WindowKey, WindowStats> {
  return { all: computeWindow(input, 'all'), ytd: computeWindow(input, 'ytd'), '60d': computeWindow(input, '60d'), '30d': computeWindow(input, '30d') };
}
