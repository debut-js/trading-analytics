// Pure analytics over raw Binance futures payloads. No I/O here so it can be
// unit-tested with synthetic data (see analytics.test.ts).

import type { SourceKey } from './sources.js';

export interface IncomeRecord {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  tranId: number;
  tradeId?: string;
  info?: string;
  /** The exchange the record came from; absent = Binance (records predating the second source). */
  source?: SourceKey;
}

export interface UserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  maker: boolean;
  time: number;
  source?: SourceKey;
}

const DAY = 86_400_000;
export const MAIN_ASSET = 'USDT';

const num = (s: string | number | undefined): number => {
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : 0;
};

export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

// ───────────────────────────── income types ─────────────────────────────
// Explicit map of Binance income types.
// Anything not listed is 'other' and still counts towards net (INSURANCE_CLEAR, …).

export type IncomeKind = 'flow' | 'realized' | 'commission' | 'funding' | 'nonTrading' | 'other';

/** Money moving in/out of the futures wallet — never performance. */
export const INCOME_FLOWS: ReadonlySet<string> = new Set([
  'TRANSFER',
  'INTERNAL_TRANSFER',
  'CROSS_COLLATERAL_TRANSFER',
  'STRATEGY_UMFUTURES_TRANSFER',
  'AUTO_EXCHANGE',
  'COIN_SWAP_DEPOSIT',
  'COIN_SWAP_WITHDRAW',
]);
/** Rebates that hand part of a commission back → booked against commission. */
export const INCOME_FEE_OFFSETS: ReadonlySet<string> = new Set(['REFERRAL_KICKBACK', 'COMMISSION_REBATE', 'API_REBATE', 'FEE_RETURN']);
/** Gifts from Binance — in the wallet, not performance; excluded from net, own line in A6. */
export const INCOME_NON_TRADING: ReadonlySet<string> = new Set(['WELCOME_BONUS', 'CONTEST_REWARD']);

export function incomeKind(type: string): IncomeKind {
  if (type === 'REALIZED_PNL') return 'realized';
  if (type === 'COMMISSION' || INCOME_FEE_OFFSETS.has(type)) return 'commission';
  if (type === 'FUNDING_FEE') return 'funding';
  if (INCOME_FLOWS.has(type)) return 'flow';
  if (INCOME_NON_TRADING.has(type)) return 'nonTrading';
  return 'other';
}

// ───────────────────────────── rates ─────────────────────────────

/**
 * Main-asset value of one unit of `asset` on UTC day `day` ('YYYY-MM-DD').
 * `undefined` = unpriced: the record is skipped from money analytics and
 * reported in `IncomeAnalytics.unpriced`. BNB is priced at the BNBUSDT daily
 * close (klines.ts), so a fee paid in BNB on 16 Sep is worth what BNB closed
 * at on 16 Sep — not today's price.
 */
export type RateFn = (asset: string, day: string) => number | undefined;

/** USDT → 1, everything else from a flat map (tests / assets priced at one current mark). */
export function rateFromMap(rates: Record<string, number>): RateFn {
  return (asset) => (asset === MAIN_ASSET ? 1 : rates[asset]);
}

/** USDT → 1, everything else unpriced. */
export const USDT_ONLY: RateFn = (asset) => (asset === MAIN_ASSET ? 1 : undefined);

/** Futures wallet valued in the main asset on `day`; assets without a rate are skipped. */
export function walletValue(assets: { asset: string; walletBalance: string | number }[], rate: RateFn, day: string): number {
  let sum = 0;
  for (const a of assets) {
    const r = rate(a.asset, day);
    if (r !== undefined) sum += num(a.walletBalance) * r;
  }
  return sum;
}

// ───────────────────────────── income ─────────────────────────────

export interface PnlBreakdown {
  realized: number;
  /** COMMISSION plus fee offsets (rebates). Negative = paid. */
  commission: number;
  funding: number;
  /** Everything else that is a trading result: INSURANCE_CLEAR, unknown types. */
  other: number;
  /** WELCOME_BONUS / CONTEST_REWARD — lands in the wallet but is not performance. Excluded from net. */
  nonTrading: number;
  /** realized + commission + funding + other. */
  net: number;
  transfers: number;
}

const emptyBreakdown = (): PnlBreakdown => ({ realized: 0, commission: 0, funding: 0, other: 0, nonTrading: 0, net: 0, transfers: 0 });

function addIncome(b: PnlBreakdown, type: string, v: number): void {
  const kind = incomeKind(type);
  if (kind === 'flow') {
    b.transfers += v;
    return;
  }
  if (kind === 'nonTrading') {
    b.nonTrading += v;
    return;
  }
  if (kind === 'realized') b.realized += v;
  else if (kind === 'commission') b.commission += v;
  else if (kind === 'funding') b.funding += v;
  else b.other += v;
  b.net += v;
}

export interface DailyPoint extends PnlBreakdown {
  date: string;
  /** Futures wallet balance (main asset) at the end of the day, reconstructed backwards from the current balance. */
  balance: number;
  /** Daily return: net / balance at start of day. null when start balance is ~0. */
  ret: number | null;
}

export interface SymbolStats extends PnlBreakdown {
  symbol: string;
  closes: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  lastActivity: number;
}

export interface IncomeAnalytics {
  from: number;
  to: number;
  records: number;
  byType: { type: string; asset: string; total: number; count: number }[];
  periods: Record<'1d' | '7d' | '30d' | 'all', PnlBreakdown>;
  daily: DailyPoint[];
  bySymbol: SymbolStats[];
  byHour: { hour: number; realized: number; count: number }[];
  byWeekday: { weekday: number; realized: number; count: number }[];
  /** Per closing-fill stats from REALIZED_PNL records (whole income window). */
  closes: { count: number; wins: number; losses: number; winRate: number | null; profitFactor: number | null; avgWin: number | null; avgLoss: number | null };
  performance: Performance;
  /** Records skipped because `rate(asset, day)` was undefined — signed native units, sorted by count desc. */
  unpriced: { asset: string; total: number; count: number }[];
}

export interface Performance {
  /** Time-weighted return over the window (transfers neutralised). */
  twr: number | null;
  maxDrawdownPct: number | null;
  /** Largest peak-to-trough fall of cumulative net PnL, in main asset. */
  maxDrawdownAbs: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  avgDailyNet: number;
  medianDailyNet: number;
  stdDailyNet: number;
  bestDay: { date: string; net: number } | null;
  worstDay: { date: string; net: number } | null;
  greenDays: number;
  redDays: number;
  activeDays: number;
  maxWinStreakDays: number;
  maxLossStreakDays: number;
  /** Funding + commission as share of gross realized profit. */
  costRatio: number | null;
}

/**
 * @param currentBalance futures wallet value in main-asset terms (see `walletValue`).
 * @param rate main-asset value of one unit of `asset` on a given UTC day. Records
 *   without a rate stay out of the money-weighted analytics (still listed in
 *   byType and reported in `unpriced`).
 */
export function analyzeIncome(records: IncomeRecord[], currentBalance: number, now: number, rate: RateFn = USDT_ONLY): IncomeAnalytics {
  const sorted = [...records].sort((a, b) => a.time - b.time);
  const from = sorted[0]?.time ?? now;

  const typeMap = new Map<string, { type: string; asset: string; total: number; count: number }>();
  const unpricedMap = new Map<string, { asset: string; total: number; count: number }>();
  const periods = { '1d': emptyBreakdown(), '7d': emptyBreakdown(), '30d': emptyBreakdown(), all: emptyBreakdown() };
  const dayMap = new Map<string, PnlBreakdown>();
  const symMap = new Map<string, SymbolStats>();
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, realized: 0, count: 0 }));
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, realized: 0, count: 0 }));
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const r of sorted) {
    const native = num(r.income);
    const tk = `${r.incomeType}|${r.asset}`;
    const t = typeMap.get(tk) ?? { type: r.incomeType, asset: r.asset, total: 0, count: 0 };
    t.total += native;
    t.count++;
    typeMap.set(tk, t);

    const dk = dayKey(r.time);
    const rt = rate(r.asset, dk);
    if (rt === undefined) {
      const u = unpricedMap.get(r.asset) ?? { asset: r.asset, total: 0, count: 0 };
      u.total += native;
      u.count++;
      unpricedMap.set(r.asset, u);
      continue;
    }
    const v = native * rt;

    const age = now - r.time;
    if (age <= DAY) addIncome(periods['1d'], r.incomeType, v);
    if (age <= 7 * DAY) addIncome(periods['7d'], r.incomeType, v);
    if (age <= 30 * DAY) addIncome(periods['30d'], r.incomeType, v);
    addIncome(periods.all, r.incomeType, v);

    const d = dayMap.get(dk) ?? emptyBreakdown();
    addIncome(d, r.incomeType, v);
    dayMap.set(dk, d);

    if (r.symbol && incomeKind(r.incomeType) !== 'flow') {
      const s = symMap.get(r.symbol) ?? { symbol: r.symbol, ...emptyBreakdown(), closes: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, lastActivity: 0 };
      addIncome(s, r.incomeType, v);
      s.lastActivity = Math.max(s.lastActivity, r.time);
      if (r.incomeType === 'REALIZED_PNL') {
        s.closes++;
        if (v > 0) {
          s.wins++;
          s.grossProfit += v;
        } else if (v < 0) {
          s.losses++;
          s.grossLoss += v;
        }
      }
      symMap.set(r.symbol, s);
    }

    if (r.incomeType === 'REALIZED_PNL') {
      const date = new Date(r.time);
      const h = byHour[date.getUTCHours()];
      const w = byWeekday[date.getUTCDay()];
      if (h) {
        h.realized += v;
        h.count++;
      }
      if (w) {
        w.realized += v;
        w.count++;
      }
      if (v > 0) {
        wins++;
        grossProfit += v;
      } else if (v < 0) {
        losses++;
        grossLoss += v;
      }
    }
  }

  // Walk every calendar day so the charts have no gaps, then rebuild the
  // balance backwards: balance(end of day d) = current − Σ wallet movements after d.
  // Non-trading income (bonuses) moves the wallet even though it is not in net.
  const days: string[] = [];
  for (let t = Date.parse(`${dayKey(from)}T00:00:00Z`); t <= now; t += DAY) days.push(dayKey(t));
  const daily: DailyPoint[] = days.map((date) => ({ date, ...(dayMap.get(date) ?? emptyBreakdown()), balance: 0, ret: null }));
  let bal = currentBalance;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i] as DailyPoint;
    d.balance = bal;
    bal -= d.net + d.transfers + d.nonTrading;
  }
  for (const d of daily) {
    // Start-of-day capital ≈ end balance − today's PnL. Transfers and bonuses
    // are assumed to land before trading, which is conservative.
    const start = d.balance - d.net;
    d.ret = start > 1e-9 ? d.net / start : null;
  }

  const closesCount = wins + losses;
  return {
    from,
    to: now,
    records: records.length,
    byType: [...typeMap.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    periods,
    daily,
    bySymbol: [...symMap.values()].sort((a, b) => b.net - a.net),
    byHour,
    byWeekday,
    closes: {
      count: closesCount,
      wins,
      losses,
      winRate: closesCount ? wins / closesCount : null,
      profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : null,
      avgWin: wins ? grossProfit / wins : null,
      avgLoss: losses ? grossLoss / losses : null,
    },
    performance: performance(daily, periods.all, grossProfit),
    unpriced: [...unpricedMap.values()].sort((a, b) => b.count - a.count),
  };
}

function performance(daily: DailyPoint[], total: PnlBreakdown, grossProfit: number): Performance {
  const nets = daily.map((d) => d.net);
  const rets = daily.map((d) => d.ret).filter((r): r is number => r !== null);

  let index = 1;
  let peakIdx = 1;
  let maxDdPct = 0;
  for (const r of rets) {
    index *= 1 + r;
    peakIdx = Math.max(peakIdx, index);
    maxDdPct = Math.max(maxDdPct, (peakIdx - index) / peakIdx);
  }

  let cum = 0;
  let peak = 0;
  let maxDdAbs = 0;
  for (const n of nets) {
    cum += n;
    peak = Math.max(peak, cum);
    maxDdAbs = Math.max(maxDdAbs, peak - cum);
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const std = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  };
  const rMean = mean(rets);
  const rStd = std(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(r, 0) ** 2)));
  const twr = rets.length ? index - 1 : null;
  const years = daily.length / 365;
  const cagr = twr !== null && years > 0 && index > 0 ? index ** (1 / years) - 1 : null;

  const active = daily.filter((d) => d.net !== 0);
  const sortedNets = [...active.map((d) => d.net)].sort((a, b) => a - b);
  const median = sortedNets.length
    ? sortedNets.length % 2
      ? (sortedNets[(sortedNets.length - 1) / 2] as number)
      : ((sortedNets[sortedNets.length / 2 - 1] as number) + (sortedNets[sortedNets.length / 2] as number)) / 2
    : 0;

  let best: DailyPoint | null = null;
  let worst: DailyPoint | null = null;
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  for (const d of active) {
    if (!best || d.net > best.net) best = d;
    if (!worst || d.net < worst.net) worst = d;
    if (d.net > 0) {
      streakW++;
      streakL = 0;
    } else {
      streakL++;
      streakW = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }

  const costs = -(total.commission + Math.min(total.funding, 0));
  return {
    twr,
    maxDrawdownPct: rets.length ? maxDdPct : null,
    maxDrawdownAbs: maxDdAbs,
    sharpe: rStd > 0 ? (rMean / rStd) * Math.sqrt(365) : null,
    sortino: downside > 0 ? (rMean / downside) * Math.sqrt(365) : null,
    calmar: cagr !== null && maxDdPct > 0 ? cagr / maxDdPct : null,
    avgDailyNet: mean(active.map((d) => d.net)),
    medianDailyNet: median,
    stdDailyNet: std(active.map((d) => d.net)),
    bestDay: best ? { date: best.date, net: best.net } : null,
    worstDay: worst ? { date: worst.date, net: worst.net } : null,
    greenDays: active.filter((d) => d.net > 0).length,
    redDays: active.filter((d) => d.net < 0).length,
    activeDays: active.length,
    maxWinStreakDays: maxW,
    maxLossStreakDays: maxL,
    costRatio: grossProfit > 0 ? costs / grossProfit : null,
  };
}

// ───────────────────────────── trades ─────────────────────────────

export interface TradeAnalytics {
  from: number;
  to: number;
  fills: number;
  orders: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  makerShare: number | null;
  /** Native commission per asset (unconverted), e.g. [{ asset: 'USDT', total: 34.19 }, { asset: 'BNB', total: 0.0175 }]. */
  commission: { asset: string; total: number }[];
  /** Σ commission × rate(asset, day of fill), all assets; unpriced assets count as 0. */
  commissionUsdt: number;
  avgOrderNotional: number | null;
  ordersPerDay: number;
  /** Orders with non-zero realized PnL, i.e. reducing / closing a position. */
  closing: {
    count: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    payoff: number | null;
    profitFactor: number | null;
    expectancy: number | null;
    largestWin: number | null;
    largestLoss: number | null;
    maxWinStreak: number;
    maxLossStreak: number;
  };
  byDirection: { direction: 'long' | 'short'; closes: number; wins: number; realized: number; winRate: number | null }[];
  bySymbol: { symbol: string; volume: number; fills: number; makerShare: number | null; commission: number; realized: number }[];
  dailyVolume: { date: string; volume: number }[];
  recent: { time: number; symbol: string; side: string; positionSide: string; qty: number; avgPrice: number; notional: number; realized: number; commission: number; maker: boolean }[];
}

interface OrderAgg {
  key: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: string;
  time: number;
  qty: number;
  notional: number;
  realized: number;
  commission: number;
  makerNotional: number;
}

/**
 * @param rate converts every fill's commission to the main asset on the fill's
 *   UTC day, so BNB-paid fees land in per-order / per-symbol numbers instead of
 *   being dropped. Unpriced assets count as 0 here (they are still
 *   listed natively in `commission`).
 */
export function analyzeTrades(trades: UserTrade[], from: number, to: number, rate: RateFn = USDT_ONLY): TradeAnalytics {
  const orders = new Map<string, OrderAgg>();
  const comm = new Map<string, number>();
  const sym = new Map<string, { symbol: string; volume: number; fills: number; maker: number; commission: number; realized: number }>();
  const dayVol = new Map<string, number>();
  let volume = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  let makerVolume = 0;
  let commissionUsdt = 0;

  for (const t of trades) {
    const q = num(t.quoteQty);
    const c = num(t.commission);
    const day = dayKey(t.time);
    const rt = rate(t.commissionAsset, day);
    const cu = rt === undefined ? 0 : c * rt;
    volume += q;
    if (t.side === 'BUY') buyVolume += q;
    else sellVolume += q;
    if (t.maker) makerVolume += q;
    comm.set(t.commissionAsset, (comm.get(t.commissionAsset) ?? 0) + c);
    commissionUsdt += cu;
    dayVol.set(day, (dayVol.get(day) ?? 0) + q);

    const s = sym.get(t.symbol) ?? { symbol: t.symbol, volume: 0, fills: 0, maker: 0, commission: 0, realized: 0 };
    s.volume += q;
    s.fills++;
    if (t.maker) s.maker += q;
    s.commission += cu;
    s.realized += num(t.realizedPnl);
    sym.set(t.symbol, s);

    const key = `${t.symbol}:${t.orderId}`;
    const o = orders.get(key) ?? { key, symbol: t.symbol, side: t.side, positionSide: t.positionSide, time: t.time, qty: 0, notional: 0, realized: 0, commission: 0, makerNotional: 0 };
    o.qty += num(t.qty);
    o.notional += q;
    o.realized += num(t.realizedPnl);
    o.commission += cu;
    if (t.maker) o.makerNotional += q;
    o.time = Math.max(o.time, t.time);
    orders.set(key, o);
  }

  const all = [...orders.values()].sort((a, b) => a.time - b.time);
  const closing = all.filter((o) => o.realized !== 0);
  const winsArr = closing.filter((o) => o.realized > 0).map((o) => o.realized);
  const lossArr = closing.filter((o) => o.realized < 0).map((o) => o.realized);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avgWin = winsArr.length ? sum(winsArr) / winsArr.length : null;
  const avgLoss = lossArr.length ? sum(lossArr) / lossArr.length : null;

  let sw = 0;
  let sl = 0;
  let maxW = 0;
  let maxL = 0;
  for (const o of closing) {
    if (o.realized > 0) {
      sw++;
      sl = 0;
    } else {
      sl++;
      sw = 0;
    }
    maxW = Math.max(maxW, sw);
    maxL = Math.max(maxL, sl);
  }

  // A closing SELL in one-way mode reduces a long; in hedge mode positionSide says it directly.
  const direction = (o: OrderAgg): 'long' | 'short' =>
    o.positionSide === 'LONG' ? 'long' : o.positionSide === 'SHORT' ? 'short' : o.side === 'SELL' ? 'long' : 'short';
  const byDirection = (['long', 'short'] as const).map((dir) => {
    const xs = closing.filter((o) => direction(o) === dir);
    const w = xs.filter((o) => o.realized > 0).length;
    return { direction: dir, closes: xs.length, wins: w, realized: sum(xs.map((o) => o.realized)), winRate: xs.length ? w / xs.length : null };
  });

  const spanDays = Math.max(1, (to - from) / DAY);
  return {
    from,
    to,
    fills: trades.length,
    orders: all.length,
    volume,
    buyVolume,
    sellVolume,
    makerShare: volume > 0 ? makerVolume / volume : null,
    commission: [...comm.entries()].map(([asset, total]) => ({ asset, total })),
    commissionUsdt,
    avgOrderNotional: all.length ? volume / all.length : null,
    ordersPerDay: all.length / spanDays,
    closing: {
      count: closing.length,
      wins: winsArr.length,
      losses: lossArr.length,
      winRate: closing.length ? winsArr.length / closing.length : null,
      avgWin,
      avgLoss,
      payoff: avgWin !== null && avgLoss !== null ? avgWin / -avgLoss : null,
      profitFactor: lossArr.length ? sum(winsArr) / -sum(lossArr) : null,
      expectancy: closing.length ? sum(closing.map((o) => o.realized)) / closing.length : null,
      largestWin: winsArr.length ? Math.max(...winsArr) : null,
      largestLoss: lossArr.length ? Math.min(...lossArr) : null,
      maxWinStreak: maxW,
      maxLossStreak: maxL,
    },
    byDirection,
    bySymbol: [...sym.values()]
      .map((s) => ({ symbol: s.symbol, volume: s.volume, fills: s.fills, makerShare: s.volume > 0 ? s.maker / s.volume : null, commission: s.commission, realized: s.realized }))
      .sort((a, b) => b.volume - a.volume),
    dailyVolume: [...dayVol.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, volume: v })),
    recent: all
      .slice(-50)
      .reverse()
      .map((o) => ({
        time: o.time,
        symbol: o.symbol,
        side: o.side,
        positionSide: o.positionSide,
        qty: o.qty,
        avgPrice: o.qty ? o.notional / o.qty : 0,
        notional: o.notional,
        realized: o.realized,
        commission: o.commission,
        maker: o.makerNotional > o.notional / 2,
      })),
  };
}
