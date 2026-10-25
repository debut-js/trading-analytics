// Pulls every read-only USDⓈ-M Futures dataset Binance exposes for the account
// (`collectRaw` — all the I/O) and turns it into one JSON report
// (`assembleReport` — pure, so the same code runs over the committed fixtures
// in tests and in scripts/build-fixture-report.ts). `buildReport` = both.
// Nothing is persisted: plugin.ts keeps the last report and
// the 7-day fills slices in RAM only.

import {
  analyzeIncome,
  analyzeTrades,
  dayKey,
  incomeKind,
  MAIN_ASSET,
  walletValue,
  type DailyPoint,
  type IncomeAnalytics,
  type IncomeRecord,
  type RateFn,
  type TradeAnalytics,
  type UserTrade,
} from './analytics.js';
import { mapLimit, weightGuard, type BinanceClient } from './binance.js';
import { buildInsights, type CapitalStep, type Insights } from './insights.js';
import { makeRateFn, type BnbRates, type KlinesStore } from './klines.js';
import { buildPeriods, type PeriodRow } from './periods.js';
import { detectCapitalStep, modifiedDietz } from './returns.js';
import { scrubPublic } from './scrub.js';
import { fetchTradesSliced, type TradesCache } from './trades-cache.js';
import { assignR, oneROf, reconstructTrips, type Trip } from './trips.js';
import { computeWindows, WINDOW_KEYS, type WindowKey, type WindowStats } from './windows.js';
import { bybitCopyTradingLatest, fetchCopyTrading, mergeCopyTrading, type CopyTrading } from './copy-trading.js';
import { collectBybitRaw, isBybitRateLimit, type BybitClient } from './bybit.js';
import { mapBybit, type BybitMapped } from './bybit-map.js';
import { usageDaily, type DayUsage } from './usage.js';
import { SOURCE_KEYS, SOURCE_LABELS, sourceOf, type ReportSource, type SourceKey, type SourceStatus } from './sources.js';

const DAY = 86_400_000;
/** Income history is retained for 3 months; stay a day inside the edge. */
export const INCOME_LOOKBACK_DAYS = 89;
/** The data start (DATA_START, YYYY-MM-DD): nothing before it counts, for an account whose earlier history was a different setup. None by default. */
const startMsOf = (opts: { dataStart?: string | undefined }): number => (opts.dataStart && /^\d{4}-\d{2}-\d{2}$/.test(opts.dataStart) ? Date.parse(`${opts.dataStart}T00:00:00Z`) : 0);
export const DEFAULT_TITLE = 'Futures account';

const num = (s: unknown): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export interface RawAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalInitialMargin: string;
  totalMaintMargin: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  totalCrossWalletBalance: string;
  totalCrossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: {
    asset: string;
    walletBalance: string;
    unrealizedProfit: string;
    marginBalance: string;
    maintMargin: string;
    initialMargin: string;
    availableBalance: string;
    maxWithdrawAmount: string;
  }[];
}

export interface RawPosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  breakEvenPrice?: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  notional: string;
  updateTime: number;
  /** The exchange; absent = Binance. */
  source?: SourceKey;
}

export interface RawOrder {
  symbol: string;
  orderId: number;
  side: string;
  positionSide: string;
  type: string;
  origType?: string;
  price: string;
  stopPrice: string;
  origQty: string;
  executedQty: string;
  reduceOnly: boolean;
  closePosition?: boolean;
  timeInForce: string;
  time: number;
  source?: SourceKey;
}

/** One row of /fapi/v1/openAlgoOrders — the Algo Service holds every conditional order (STOP, STOP_MARKET, TAKE_PROFIT, …) since 2025-12-09. */
export interface RawAlgoOrder {
  algoId: number;
  symbol: string;
  side: string;
  positionSide: string;
  orderType: string;
  quantity: string;
  triggerPrice: string;
  price: string;
  closePosition: boolean;
  reduceOnly: boolean;
  algoStatus?: string;
  createTime: number;
  updateTime?: number;
  source?: SourceKey;
}

export interface RawForceOrder {
  symbol: string;
  side: string;
  positionSide?: string;
  origQty: string;
  avgPrice: string;
  executedQty: string;
  time: number;
  clientOrderId?: string;
  source?: SourceKey;
}

/** One source's state in the last collection and its balances — `report.sources`, what the client's source filter reads. */
export interface ReportSourceInfo extends SourceStatus {
  label: string;
  walletBalance: number;
  marginBalance: number;
  unrealizedPnl: number;
  /** Open positions of the source. */
  positions: number;
}

export interface Capital {
  deposited: number;
  withdrawn: number;
  transferDays: number;
  transfers: number;
  largest: { date: string; amount: number } | null;
  nativeByAsset: Record<string, number>;
  /** Same shape as insights.ts `CapitalStep`; netSince/daysSince/returnSince cover the days AFTER the step day, preNet the days up to and including it (= windows.*.sinceStep). */
  step: CapitalStep | null;
}

export interface Report {
  generatedAt: number;
  /** Which exchange(s) the report covers: `all` merges every configured source. */
  source: ReportSource;
  /** Every source the server knows, with its state and balances; the same list in every slice. */
  sources: ReportSourceInfo[];
  account: {
    walletBalance: number;
    unrealizedPnl: number;
    marginBalance: number;
    availableBalance: number;
    maxWithdraw: number;
    initialMargin: number;
    maintMargin: number;
    positionMargin: number;
    openOrderMargin: number;
    /** maintMargin / marginBalance — Binance liquidates the cross account at 100%. */
    marginRatio: number | null;
    /** Σ|notional| / marginBalance. */
    effectiveLeverage: number | null;
    longExposure: number;
    shortExposure: number;
    assets: { asset: string; wallet: number; unrealized: number; margin: number; available: number }[];
  };
  config: {
    feeTier: number | null;
    canTrade: boolean | null;
    canDeposit: boolean | null;
    canWithdraw: boolean | null;
    hedgeMode: boolean | null;
    multiAssetsMargin: boolean | null;
    bnbFeeBurn: boolean | null;
    commission: { symbol: string; maker: number; taker: number }[];
    tradingStatus: unknown;
    /** positionsRaw[0].marginType lower-cased; Binance's 'crossed' → 'cross'. */
    marginType: 'cross' | 'isolated' | null;
  };
  positions: {
    symbol: string;
    source: SourceKey;
    side: 'LONG' | 'SHORT';
    positionSide: string;
    size: number;
    notional: number;
    entryPrice: number;
    breakEvenPrice: number | null;
    markPrice: number;
    liquidationPrice: number | null;
    liqDistance: number | null;
    unrealizedPnl: number;
    roe: number | null;
    leverage: number;
    marginType: string;
    margin: number;
    adl: number | null;
    updateTime: number;
  }[];
  /** Resting orders (/openOrders) and conditional ones (/openAlgoOrders) in one list; `closePosition` = a close-all stop or take profit (qty 0). */
  openOrders: { symbol: string; source: SourceKey; side: string; positionSide: string; type: string; price: number; stopPrice: number; qty: number; filled: number; reduceOnly: boolean; closePosition: boolean; time: number }[];
  liquidations: { symbol: string; source: SourceKey; side: string; qty: number; avgPrice: number; time: number; kind: 'liquidation' | 'adl' }[];
  income: IncomeAnalytics;
  trades: TradeAnalytics;
  /**
   * BNB valuation used for fee records. `unpriced` = Σ|income| of
   * BNB fee/funding records that could not be converted (native BNB; 0 when
   * klines work) — the §6.4 banner "Net excludes 0.0175 BNB (~$13) of fees".
   */
  rates: { BNB: BnbRates & { unpriced: number } };
  /** §3.2 — open trips first (entryTime desc), then closed by exitTime desc; truncated ones carry the flag. */
  trips: Trip[];
  /** Capital usage per UTC day from the fills: peak and time-weighted average initial margin, with the open size at those moments. */
  usageDaily: Record<string, DayUsage>;
  lastClosedTrip: Trip | null;
  lastTradeTime: number | null;
  windows: Record<WindowKey, WindowStats>;
  periods: { weekly: PeriodRow[]; monthly: PeriodRow[] };
  capital: Capital;
  /** Count of INSURANCE_CLEAR income records (§8.2). */
  liquidations89d: number;
  /** The copy-trading figures of the slice (copiers, cap, assets under copy): the exchange's own, or the exchanges' added for `all`; null when no source answered (meta.warnings says). */
  copyTrading: CopyTrading | null;
  /** The same per exchange, in every slice: the landing's platform tiles read their own exchange's count. */
  copyTradingBySource: Partial<Record<SourceKey, CopyTrading | null>>;
  /** The leverage setting of every symbol /positionRisk lists (flat ones too): the trade feed's ROI = return on notional × leverage. */
  leverage: Record<string, number>;
  /** === insightsByWindow.all (§8.1). */
  insights: Insights;
  insightsByWindow: Record<WindowKey, Insights>;
  meta: {
    usedWeight: number;
    durationMs: number;
    incomeLookbackDays: number;
    tradesLookbackDays: number;
    warnings: string[];
    cacheAgeMs: number;
    cacheTtlMs: number;
    historyCapped: boolean;
    inceptionDate: string;
    /** `YYYY-MM-DD`: the fixed cut-off; nothing before it is in the report. */
    dataStart: string;
    title: string;
    tradesCache: { slices: number; oldestSliceStart: number | null };
  };
}

export interface RawInputs {
  now: number;
  /** The account of the slice being assembled (`filterRaw` sets it; `collectRaw` returns Binance's). */
  account: RawAccount;
  /** Every configured source's account, for `filterRaw` and the per-source summary. */
  accounts: Partial<Record<SourceKey, RawAccount>>;
  sources: SourceStatus[];
  positionsRaw: RawPosition[];
  incomeRaw: IncomeRecord[];
  tradesRaw: UserTrade[];
  config: Record<string, unknown>;
  openOrdersRaw: RawOrder[];
  openAlgoOrdersRaw: RawAlgoOrder[];
  forceOrders: RawForceOrder[];
  adl: { symbol: string; adlQuantile: Record<string, number>; source?: SourceKey }[];
  feeBurn: { feeBurn: boolean } | null;
  tradingStatus: unknown;
  /** The slice's copy-trading figures (`filterRaw` sets it; `collectRaw` returns Binance's). */
  copyTrading: CopyTrading | null;
  /** Per exchange, from the whole collection. */
  copyTradingBySource: Partial<Record<SourceKey, CopyTrading | null>>;
  commission: { symbol: string; maker: number; taker: number }[];
  bnb: BnbRates;
  otherRates: Record<string, number>;
  warnings: string[];
  usedWeight: number;
  tradesCache: { slices: number; oldestSliceStart: number | null };
}

export interface BuildOptions {
  tradesLookbackDays: number;
  /** One per process (plugin.ts) so last-good BNB closes survive a failed refresh. */
  klines: KlinesStore;
  /** One per process; closed 7-day userTrades slices are reused between reports. Null/absent = no memo. */
  tradesCache?: TradesCache | null;
  cacheTtlMs: number;
  inceptionDate?: string;
  /** Nothing before this UTC day (YYYY-MM-DD) counts; absent = the exchanges' whole retained history. */
  dataStart?: string;
  /** A lead trader's public copy-trading figures: the Binance lead portfolio id, the Bybit leader mark. Absent = none. */
  copyTrading?: { binance?: string; bybit?: string };
  title?: string;
  /**
   * What to do when the fills (userTrades) cannot be fetched completely, even after the per-slice retries.
   * false / absent: `buildReport` throws, so the caller keeps serving its last good report instead of one with 0 trips.
   * true: the report is built without fills (trips and trade statistics empty) and `meta.warnings` says why — for the very
   * first build of the process only, when there is no cached report to fall back on.
   */
  allowMissingFills?: boolean;
  /** The Bybit client when BYBIT_DASHBOARD_API_KEY / _SECRET are set; its failure never fails the report. */
  bybit?: BybitClient | null;
  /**
   * One per process: the last Bybit collection that succeeded. A failed one (a 10006 / 403 back-off, a slow edge) falls
   * back on it for up to BYBIT_LAST_GOOD_MS, so the page does not lose its Bybit half for a refresh; meta.warnings says so.
   */
  bybitMemo?: { last: { at: number; data: BybitMapped } | null; backoffUntil?: number } | null;
}

/** How long a failed Bybit collection may be covered by the last good one. */
export const BYBIT_LAST_GOOD_MS = 3 * 3600_000;
/** Bybit is collected at most this often; reports in between reuse the last collection (it pulls the whole history each time). */
export const BYBIT_REFRESH_MS = 2 * 60_000;
/**
 * After a 403 (Bybit's edge refuses this IP: its per-IP limit, which a cloud host's shared outbound addresses also count against)
 * or a 10006, Bybit is not asked again for this long, so the ban is not prolonged; the last good data covers the gap.
 */
export const BYBIT_BACKOFF_MS = 10 * 60_000;

type AssembleOptions = Pick<BuildOptions, 'tradesLookbackDays' | 'cacheTtlMs' | 'inceptionDate' | 'dataStart' | 'title'> & {
  /** The slice this report is (default `all`). */
  source?: ReportSource;
  /** The per-source summary of the whole collection (default: computed from the inputs given). */
  sources?: ReportSourceInfo[];
};

async function fetchIncome(client: BinanceClient, from: number, to: number): Promise<IncomeRecord[]> {
  const seen = new Set<string>();
  const out: IncomeRecord[] = [];
  let start = from;
  // Pages are capped at 1000 rows; advance by the last timestamp and dedupe
  // the boundary (several records can share one millisecond).
  for (let page = 0; page < 200; page++) {
    const rows = await client.signed<IncomeRecord[]>('/fapi/v1/income', { startTime: start, endTime: to, limit: 1000 });
    let added = 0;
    for (const r of rows) {
      const key = `${r.tranId}|${r.incomeType}|${r.symbol}|${r.asset}|${r.time}|${r.income}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      added++;
    }
    const last = rows[rows.length - 1];
    if (rows.length < 1000 || !last || added === 0) break;
    start = last.time;
  }
  return out;
}

/** The Algo Service answers with a bare array (the docs' example); a wrapped `{ orders: [...] }` is tolerated too. */
function algoList(res: unknown): RawAlgoOrder[] {
  if (Array.isArray(res)) return res as RawAlgoOrder[];
  if (res && typeof res === 'object' && Array.isArray((res as { orders?: unknown }).orders)) return (res as { orders: RawAlgoOrder[] }).orders;
  return [];
}

/** All Binance I/O for one report. Pure assembly happens in `assembleReport`. */
export async function collectRaw(client: BinanceClient, opts: BuildOptions): Promise<RawInputs> {
  const now = Date.now();
  const warnings: string[] = [];
  const cache = opts.tradesCache ?? null;
  // Age eviction otherwise only runs on `set()`; a warm cache that never stores a new slice would keep stale entries.
  cache?.prune(now);

  // Optional sections must not take the whole report down — record and move on.
  const optional = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      warnings.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  // The Bybit half runs alongside the Binance burst and is optional: a failure leaves a warning and a report without Bybit.
  const bybitStatus: SourceStatus = { key: 'bybit', configured: !!opts.bybit, ok: false, error: null };
  const memo = opts.bybitMemo ?? null;
  const fresh = memo?.last && now - memo.last.at < BYBIT_REFRESH_MS ? memo.last : null;
  const backingOff = !!memo?.backoffUntil && now < memo.backoffUntil;
  const bybitP = !opts.bybit
    ? null
    : fresh
      ? Promise.resolve({ ...fresh.data, warnings: [] })   // collected under two minutes ago: reused as it is
      : backingOff
        ? Promise.reject(new Error(`Bybit refused this server a moment ago; not asked again until ${new Date(memo!.backoffUntil!).toISOString()}`))
        : collectBybitRaw(opts.bybit, { from: now - INCOME_LOOKBACK_DAYS * DAY, tradesFrom: Math.max(now - opts.tradesLookbackDays * DAY, startMsOf(opts)), now }).then(mapBybit);
  bybitP?.catch(() => undefined);   // settled and handled below; no unhandled rejection while the Binance burst is still running

  // BNB daily closes (public, weight 1); on failure the store keeps last-good.
  // Settled before the signed burst so a rejection there can never leave a refresh in flight.
  const klinesWarning = await opts.klines.refresh(client, now);
  if (klinesWarning) warnings.push(klinesWarning);
  const bnb = opts.klines.get();

  const [account, positionsRaw, incomeRaw, config, openOrdersRaw, openAlgoOrdersRaw, forceOrders, adl, feeBurn, tradingStatus, copyTrading, copyTradingBybit] = await Promise.all([
    client.signed<RawAccount>('/fapi/v3/account'),
    client.signed<RawPosition[]>('/fapi/v2/positionRisk'),
    fetchIncome(client, now - INCOME_LOOKBACK_DAYS * DAY, now),
    optional('accountConfig', client.signed<Record<string, unknown>>('/fapi/v1/accountConfig'), {} as Record<string, unknown>),
    optional('openOrders', client.signed<RawOrder[]>('/fapi/v1/openOrders'), []),
    optional('openAlgoOrders', client.signed<unknown>('/fapi/v1/openAlgoOrders').then(algoList), []),   // stops and take profits live here, not in /openOrders
    optional('forceOrders', client.signed<RawForceOrder[]>('/fapi/v1/forceOrders', { limit: 100 }), []),
    optional('adlQuantile', client.signed<{ symbol: string; adlQuantile: Record<string, number> }[]>('/fapi/v1/adlQuantile'), []),
    optional('feeBurn', client.signed<{ feeBurn: boolean }>('/fapi/v1/feeBurn'), null),
    optional('apiTradingStatus', client.signed<unknown>('/fapi/v1/apiTradingStatus'), null),
    opts.copyTrading?.binance ? optional('copyTrading', fetchCopyTrading(opts.copyTrading.binance), null) : Promise.resolve<CopyTrading | null>(null),   // the lead portfolio's public page data, not the signed API
    opts.bybit && opts.copyTrading?.bybit ? optional('bybit copyTrading', bybitCopyTradingLatest(opts.copyTrading.bybit, now), null) : Promise.resolve<CopyTrading | null>(null),   // the Bybit leader page's figures, refreshed in the background (a slow edge)
  ]);
  const bybit = bybitP
    ? await bybitP
        .then((m) => {
          bybitStatus.ok = true;
          if (memo && !fresh) { memo.last = { at: now, data: m }; memo.backoffUntil = 0; }
          return m;
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          // with nothing to show yet (a fresh process) the pause is short, so Bybit comes back soon; with last good data, the full one
          if (memo && !backingOff && isBybitRateLimit(e)) memo.backoffUntil = now + (memo.last ? BYBIT_BACKOFF_MS : 2 * 60_000);
          const last = memo?.last;
          if (last && now - last.at <= BYBIT_LAST_GOOD_MS) {
            bybitStatus.ok = true;   // served from the last good collection, not dropped
            warnings.push(`bybit: ${message}; using the Bybit data collected at ${new Date(last.at).toISOString()}`);
            return last.data;
          }
          bybitStatus.error = message;
          warnings.push(`bybit: ${message}`);
          return null;
        })
    : null;
  if (bybit) warnings.push(...bybit.warnings);
  const tag = <T extends object>(rows: T[], source: SourceKey): (T & { source: SourceKey })[] => rows.map((r) => ({ ...r, source }));
  const positionsAll: RawPosition[] = [...tag(positionsRaw, 'binance'), ...(bybit?.positions ?? [])];
  const incomeAll: IncomeRecord[] = [...tag(incomeRaw, 'binance'), ...(bybit?.income ?? [])];
  const openOrdersAll: RawOrder[] = [...tag(openOrdersRaw, 'binance'), ...(bybit?.orders ?? [])];
  const adlAll: RawInputs['adl'] = [...tag(adl, 'binance'), ...(bybit?.adl ?? [])];
  const accounts: RawInputs['accounts'] = { binance: account, ...(bybit ? { bybit: bybit.account } : {}) };

  // Other non-USDT assets (USDC collateral, …) at the current mark; BNB is priced by klines.
  const otherAssets = new Set<string>([
    ...incomeAll.map((r) => r.asset),
    ...Object.values(accounts).flatMap((a) => (a ? a.assets : [])).filter((a) => num(a.walletBalance) !== 0).map((a) => a.asset),
  ]);
  otherAssets.delete(MAIN_ASSET);
  otherAssets.delete('BNB');
  const otherRates: Record<string, number> = {};
  await optional(
    'asset prices',
    mapLimit([...otherAssets], 5, async (asset) => {
      const p = await client.public<{ markPrice: string }>('/fapi/v1/premiumIndex', { symbol: `${asset}${MAIN_ASSET}` });
      if (num(p.markPrice) > 0) otherRates[asset] = num(p.markPrice);
    }),
    [],
  );
  for (const a of otherAssets) if (otherRates[a] === undefined) warnings.push(`no ${a}/${MAIN_ASSET} rate: ${a} records are left out of PnL`);

  // Fills only for symbols that moved during the lookback (open positions + income), and never from before the cut-off.
  const tradesFrom = Math.max(now - opts.tradesLookbackDays * DAY, startMsOf(opts));
  const activeSymbols = new Set<string>(positionsRaw.filter((p) => num(p.positionAmt) !== 0).map((p) => p.symbol));
  for (const r of incomeRaw) {
    if (r.symbol && r.time >= tradesFrom && (r.incomeType === 'COMMISSION' || r.incomeType === 'REALIZED_PNL')) activeSymbols.add(r.symbol);
  }
  await weightGuard(client);
  const fetchFills = (): Promise<UserTrade[]> => fetchTradesSliced(client, cache, [...activeSymbols], tradesFrom, now, now);
  const tradesRaw = tag(opts.allowMissingFills ? await optional('userTrades', fetchFills(), []) : await fetchFills(), 'binance');
  const tradesAll: UserTrade[] = [...tradesRaw, ...(bybit?.trades ?? [])];

  // Commission rates for the five busiest Binance symbols (Σ quoteQty) of the fills window.
  const volume = new Map<string, number>();
  for (const t of tradesRaw) volume.set(t.symbol, (volume.get(t.symbol) ?? 0) + num(t.quoteQty));
  const topSymbols = [...volume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([symbol]) => symbol);
  const commission = await optional(
    'commissionRate',
    mapLimit(topSymbols, 5, async (symbol) => {
      const r = await client.signed<{ makerCommissionRate: string; takerCommissionRate: string }>('/fapi/v1/commissionRate', { symbol });
      return { symbol, maker: num(r.makerCommissionRate), taker: num(r.takerCommissionRate) };
    }),
    [],
  );

  const stats = cache ? cache.stats() : null;
  return {
    now,
    account,
    accounts,
    sources: [{ key: 'binance', configured: true, ok: true, error: null }, bybitStatus],
    positionsRaw: positionsAll,
    incomeRaw: incomeAll,
    tradesRaw: tradesAll,
    config,
    openOrdersRaw: openOrdersAll,
    openAlgoOrdersRaw: tag(openAlgoOrdersRaw, 'binance'),
    forceOrders: tag(forceOrders, 'binance'),
    adl: adlAll,
    feeBurn,
    tradingStatus,
    copyTrading,
    copyTradingBySource: { binance: copyTrading, ...(opts.bybit ? { bybit: copyTradingBybit } : {}) },
    commission,
    bnb,
    otherRates,
    warnings,
    usedWeight: client.usedWeight(),
    tradesCache: stats ? { slices: stats.slices, oldestSliceStart: stats.oldestSliceStart } : { slices: 0, oldestSliceStart: null },
  };
}

function mapPositions(positionsRaw: RawPosition[], adl: RawInputs['adl']): Report['positions'] {
  return positionsRaw
    .filter((p) => num(p.positionAmt) !== 0)
    .map((p) => {
      const amt = num(p.positionAmt);
      const mark = num(p.markPrice);
      const liq = num(p.liquidationPrice);
      const notional = Math.abs(num(p.notional) || amt * mark);
      const leverage = num(p.leverage) || 1;
      const margin = p.marginType === 'isolated' ? num(p.isolatedMargin) : notional / leverage;
      const adlEntry = adl.find((a) => a.symbol === p.symbol && sourceOf(a) === sourceOf(p))?.adlQuantile;
      const adlRank = adlEntry ? (adlEntry[p.positionSide] ?? adlEntry[amt > 0 ? 'LONG' : 'SHORT'] ?? adlEntry['BOTH']) : undefined;
      return {
        symbol: p.symbol,
        source: sourceOf(p),
        side: (amt > 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
        positionSide: p.positionSide,
        size: Math.abs(amt),
        notional,
        entryPrice: num(p.entryPrice),
        breakEvenPrice: p.breakEvenPrice ? num(p.breakEvenPrice) : null,
        markPrice: mark,
        liquidationPrice: liq > 0 ? liq : null,
        liqDistance: liq > 0 && mark > 0 ? Math.abs(mark - liq) / mark : null,
        unrealizedPnl: num(p.unRealizedProfit),
        roe: margin > 0 ? num(p.unRealizedProfit) / margin : null,
        leverage,
        marginType: p.marginType,
        margin,
        adl: adlRank ?? null,
        updateTime: p.updateTime,
      };
    })
    .sort((a, b) => b.notional - a.notional);
}

/** §8.2: first element of the UNFILTERED positionRisk (Binance returns every symbol). */
function marginTypeOf(positionsRaw: RawPosition[]): 'cross' | 'isolated' | null {
  const mt = positionsRaw[0]?.marginType?.toLowerCase();
  if (mt === 'cross' || mt === 'crossed') return 'cross';
  if (mt === 'isolated') return 'isolated';
  return null;
}

/** Capital flows (§2.6) + the capital step (§3.3 since-step Modified Dietz). */
function buildCapital(daily: DailyPoint[], incomeRaw: IncomeRecord[], rate: RateFn): Capital {
  let deposited = 0;
  let withdrawn = 0;
  let transfers = 0;
  const nativeByAsset: Record<string, number> = {};
  for (const r of incomeRaw) {
    if (incomeKind(r.incomeType) !== 'flow') continue;
    transfers += 1;
    const amount = num(r.income);
    nativeByAsset[r.asset] = (nativeByAsset[r.asset] ?? 0) + amount;
    const k = rate(r.asset, dayKey(r.time));
    if (k === undefined) continue;
    if (amount > 0) deposited += amount * k;
    else withdrawn += -amount * k;
  }
  let largest: Capital['largest'] = null;
  for (const d of daily) {
    if (d.transfers !== 0 && (largest === null || Math.abs(d.transfers) > Math.abs(largest.amount))) largest = { date: d.date, amount: d.transfers };
  }
  const found = detectCapitalStep(daily);
  let step: Capital['step'] = null;
  if (found) {
    // S-C `sinceStep` semantics (windows.ts): the step day belongs to "before"; "since" = the days after it,
    // Dietz from the balance at the end of the step day. +$48.86 · +12.5% · 5 d; −$23.51 before.
    const since = daily.slice(found.index + 1);
    const before = daily.slice(0, found.index + 1);
    const v0 = (daily[found.index] as DailyPoint).balance;
    step = {
      date: found.date,
      amount: found.amount,
      netSince: since.reduce((a, d) => a + d.net, 0),
      returnSince: since.length ? modifiedDietz(since, v0) : null,
      daysSince: since.length,
      preNet: before.reduce((a, d) => a + d.net, 0),
    };
  }
  return { deposited, withdrawn, transferDays: daily.filter((d) => d.transfers !== 0).length, transfers, largest, nativeByAsset, step };
}

/** Pure: no clock, no I/O. `meta.cacheAgeMs` and `meta.durationMs` are 0; the route patches cacheAgeMs, `buildReport` patches durationMs. */
export function assembleReport(input: RawInputs, opts: AssembleOptions): Report {
  // The cut-off: income before DATA_START is still fetched (a page at most) only to tell an account that existed then from a new
  // one; nothing before it reaches the analytics. Fills before it never arrive (collectRaw clamps) — the filter here covers fixtures.
  const startMs = startMsOf(opts);
  const hadHistoryBefore = startMs > 0 && input.incomeRaw.some((r) => r.time < startMs);
  const raw: RawInputs = { ...input, incomeRaw: input.incomeRaw.filter((r) => r.time >= startMs), tradesRaw: input.tradesRaw.filter((t) => t.time >= startMs) };
  const { now } = raw;
  const today = dayKey(now);
  const warnings = [...raw.warnings];
  const rate = makeRateFn(raw.bnb, raw.otherRates);

  // 1. Income → daily balance series; wallet assets valued at today's rate.
  const income = analyzeIncome(raw.incomeRaw, walletValue(raw.account.assets, rate, today), now, rate);
  for (const u of income.unpriced) warnings.push(`no ${u.asset}/${MAIN_ASSET} rate for ${u.count} income records (${u.total} ${u.asset}); left out of PnL`);
  // §6.4 banner "Net excludes 0.0175 BNB (~$13) of fees": native BNB of fee/funding records that could not be valued (S-A.5 definition, asserted by report.rates.test.ts).
  const bnbUnpriced = raw.incomeRaw
    .filter((r) => r.asset === 'BNB' && incomeKind(r.incomeType) !== 'flow' && rate('BNB', dayKey(r.time)) === undefined)
    .reduce((s, r) => s + Math.abs(num(r.income)), 0);

  // 2. Fills window (never before the cut-off).
  const tradesFrom = Math.max(now - opts.tradesLookbackDays * DAY, startMsOf(opts));
  const trades = analyzeTrades(raw.tradesRaw, tradesFrom, now, rate);
  // A commission asset that never showed up in income or the wallet had no rate fetched by collectRaw;
  // its fills count as 0 in commissionUsdt. (BNB is covered by the klines warning.)
  const seenAssets = new Set<string>([...raw.incomeRaw.map((r) => r.asset), ...raw.account.assets.filter((a) => num(a.walletBalance) !== 0).map((a) => a.asset)]);
  const unpricedFees = new Set<string>();
  for (const t of raw.tradesRaw) {
    if (num(t.commission) !== 0 && t.commissionAsset !== 'BNB' && rate(t.commissionAsset, dayKey(t.time)) === undefined) unpricedFees.add(t.commissionAsset);
  }
  for (const a of unpricedFees) if (!seenAssets.has(a)) warnings.push(`no ${a}/${MAIN_ASSET} rate: ${a} commissions are excluded from fill fees`);
  const lastTradeTime = raw.tradesRaw.reduce<number | null>((m, t) => (m === null || t.time > m ? t.time : m), null);

  // 3. Round trips (§3.2) and R multiples.
  const hedgeMode = raw.config['dualSidePosition'] === true;
  const tripsResult = reconstructTrips({ trades: raw.tradesRaw, positions: raw.positionsRaw, income: raw.incomeRaw, rate, daily: income.daily, hedgeMode, now });
  warnings.push(...tripsResult.warnings);
  const trips = tripsResult.trips;
  assignR(trips, oneROf(trips));
  const lastClosedTrip = trips.find((t) => t.status === 'closed') ?? null;

  // 4. Windows, 5. periods, 6. capital.
  // Binance keeps 3 months of income, and the cut-off drops everything before DATA_START. An account with history before day 0
  // did not start at 0 there: its balance at the start of day 0 (reconstructed backwards from today, i.e. before that day's net,
  // transfers and bonuses) is the V₀ of the Modified Dietz / sub-period TWR of `all` and of the first period. An uncapped
  // history starts at the account's first record, where the balance really was 0 — the reconstructed value (≈ −0.58 on the old
  // fixture, BNB valuation noise) must not be used then.
  const historyCapped = hadHistoryBefore || now - income.from >= (INCOME_LOOKBACK_DAYS - 1) * DAY;
  const day0 = income.daily[0];
  const openingBalance = historyCapped && day0 ? day0.balance - day0.net - day0.transfers - day0.nonTrading : 0;
  const windows = computeWindows({
    daily: income.daily,
    incomeRaw: raw.incomeRaw,
    trades: raw.tradesRaw,
    trips,
    rate,
    now,
    tradesLookbackDays: opts.tradesLookbackDays,
    commissionRates: raw.commission,
    openingBalance,
  });
  const periods = buildPeriods({ daily: income.daily, trips, tradesFrom: windows.all.tradesFrom, now, openingBalance });
  const capital = buildCapital(income.daily, raw.incomeRaw, rate);

  // 7. Insights per window; the appendix uses 30d when 7d is selected.
  const inceptionDate = opts.inceptionDate ?? income.daily[0]?.date ?? today;
  const insightsByWindow = Object.fromEntries(
    WINDOW_KEYS.map((w): [WindowKey, Insights] => [
      w,
      buildInsights({
        window: windows[w],
        appendix: windows[w],
        monthly: periods.monthly,
        step: capital.step,
        inceptionDate,
        historyCapped,
        now,
      }),
    ]),
  ) as Record<WindowKey, Insights>;

  const positions = mapPositions(raw.positionsRaw, raw.adl);
  const marginBalance = num(raw.account.totalMarginBalance);
  const longExposure = positions.filter((p) => p.side === 'LONG').reduce((a, p) => a + p.notional, 0);
  const shortExposure = positions.filter((p) => p.side === 'SHORT').reduce((a, p) => a + p.notional, 0);
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const config = raw.config;

  return {
    generatedAt: now,
    source: opts.source ?? 'all',
    sources: opts.sources ?? sourcesSummary(input),
    account: {
      walletBalance: num(raw.account.totalWalletBalance),
      unrealizedPnl: num(raw.account.totalUnrealizedProfit),
      marginBalance,
      availableBalance: num(raw.account.availableBalance),
      maxWithdraw: num(raw.account.maxWithdrawAmount),
      initialMargin: num(raw.account.totalInitialMargin),
      maintMargin: num(raw.account.totalMaintMargin),
      positionMargin: num(raw.account.totalPositionInitialMargin),
      openOrderMargin: num(raw.account.totalOpenOrderInitialMargin),
      marginRatio: marginBalance > 0 ? num(raw.account.totalMaintMargin) / marginBalance : null,
      effectiveLeverage: marginBalance > 0 ? (longExposure + shortExposure) / marginBalance : null,
      longExposure,
      shortExposure,
      assets: raw.account.assets
        .filter((a) => num(a.walletBalance) !== 0 || num(a.unrealizedProfit) !== 0)
        .map((a) => ({ asset: a.asset, wallet: num(a.walletBalance), unrealized: num(a.unrealizedProfit), margin: num(a.marginBalance), available: num(a.availableBalance) })),
    },
    config: {
      feeTier: typeof config['feeTier'] === 'number' ? (config['feeTier'] as number) : null,
      canTrade: bool(config['canTrade']),
      canDeposit: bool(config['canDeposit']),
      canWithdraw: bool(config['canWithdraw']),
      hedgeMode: bool(config['dualSidePosition']),
      multiAssetsMargin: bool(config['multiAssetsMargin']),
      bnbFeeBurn: raw.feeBurn ? raw.feeBurn.feeBurn : null,
      commission: raw.commission,
      tradingStatus: raw.tradingStatus,
      marginType: marginTypeOf(raw.positionsRaw),
    },
    positions,
    openOrders: [
      ...raw.openOrdersRaw.map((o) => ({
        symbol: o.symbol,
        source: sourceOf(o),
        side: o.side,
        positionSide: o.positionSide,
        type: o.origType ?? o.type,
        price: num(o.price),
        stopPrice: num(o.stopPrice),
        qty: num(o.origQty),
        filled: num(o.executedQty),
        reduceOnly: o.reduceOnly || o.closePosition === true,
        closePosition: o.closePosition === true,
        time: o.time,
      })),
      // Conditional orders from the Algo Service: the trigger is the stop price; a close-all order has no quantity.
      ...raw.openAlgoOrdersRaw.map((a) => ({
        symbol: a.symbol,
        source: sourceOf(a),
        side: a.side,
        positionSide: a.positionSide,
        type: a.orderType,
        price: num(a.price),
        stopPrice: num(a.triggerPrice),
        qty: num(a.quantity),
        filled: 0,
        reduceOnly: a.reduceOnly === true || a.closePosition === true,
        closePosition: a.closePosition === true,
        time: a.createTime,
      })),
    ].sort((a, b) => b.time - a.time),
    liquidations: raw.forceOrders.map((f) => ({
      symbol: f.symbol,
      source: sourceOf(f),
      side: f.side,
      qty: num(f.executedQty || f.origQty),
      avgPrice: num(f.avgPrice),
      time: f.time,
      kind: f.clientOrderId?.startsWith('adl_') ? ('adl' as const) : ('liquidation' as const),
    })),
    income,
    trades,
    rates: { BNB: { ...raw.bnb, unpriced: bnbUnpriced } },
    trips,
    usageDaily: usageDaily(raw.tradesRaw, trips, tradesFrom, now),
    lastClosedTrip,
    lastTradeTime,
    windows,
    periods,
    capital,
    liquidations89d: raw.incomeRaw.filter((r) => r.incomeType === 'INSURANCE_CLEAR').length,
    copyTrading: raw.copyTrading,
    copyTradingBySource: raw.copyTradingBySource,
    leverage: Object.fromEntries(raw.positionsRaw.map((p) => [p.symbol, Number(p.leverage)] as const).filter(([, l]) => Number.isFinite(l) && l > 0)),
    insights: insightsByWindow.all,
    insightsByWindow,
    meta: {
      usedWeight: raw.usedWeight,
      durationMs: 0,
      incomeLookbackDays: INCOME_LOOKBACK_DAYS,
      tradesLookbackDays: opts.tradesLookbackDays,
      // Warnings quote upstream errors (klines, optional endpoints, fills): the JSON is public, so no IP address leaves with them.
      warnings: warnings.map(scrubPublic),
      cacheAgeMs: 0,
      cacheTtlMs: opts.cacheTtlMs,
      historyCapped,
      inceptionDate,
      dataStart: opts.dataStart ?? '',
      title: opts.title ?? DEFAULT_TITLE,
      tradesCache: raw.tradesCache,
    },
  };
}

const ZERO_ACCOUNT: RawAccount = {
  totalWalletBalance: '0',
  totalUnrealizedProfit: '0',
  totalMarginBalance: '0',
  totalInitialMargin: '0',
  totalMaintMargin: '0',
  totalPositionInitialMargin: '0',
  totalOpenOrderInitialMargin: '0',
  totalCrossWalletBalance: '0',
  totalCrossUnPnl: '0',
  availableBalance: '0',
  maxWithdrawAmount: '0',
  assets: [],
};

/** The accounts of every source as one (the `all` slice): totals added, assets concatenated (walletValue sums them per asset). */
export function mergeAccounts(list: RawAccount[]): RawAccount {
  const add = (pick: (a: RawAccount) => string): string => String(list.reduce((s, a) => s + num(pick(a)), 0));
  return {
    totalWalletBalance: add((a) => a.totalWalletBalance),
    totalUnrealizedProfit: add((a) => a.totalUnrealizedProfit),
    totalMarginBalance: add((a) => a.totalMarginBalance),
    totalInitialMargin: add((a) => a.totalInitialMargin),
    totalMaintMargin: add((a) => a.totalMaintMargin),
    totalPositionInitialMargin: add((a) => a.totalPositionInitialMargin),
    totalOpenOrderInitialMargin: add((a) => a.totalOpenOrderInitialMargin),
    totalCrossWalletBalance: add((a) => a.totalCrossWalletBalance),
    totalCrossUnPnl: add((a) => a.totalCrossUnPnl),
    availableBalance: add((a) => a.availableBalance),
    maxWithdrawAmount: add((a) => a.maxWithdrawAmount),
    assets: list.flatMap((a) => a.assets),
  };
}

/** `report.sources`: every source's state and balances, from the whole (unfiltered) collection. */
export function sourcesSummary(raw: RawInputs): ReportSourceInfo[] {
  return raw.sources.map((s) => {
    const acc = raw.accounts[s.key];
    return {
      ...s,
      label: SOURCE_LABELS[s.key],
      walletBalance: num(acc?.totalWalletBalance),
      marginBalance: num(acc?.totalMarginBalance),
      unrealizedPnl: num(acc?.totalUnrealizedProfit),
      positions: raw.positionsRaw.filter((p) => sourceOf(p) === s.key && num(p.positionAmt) !== 0).length,
    };
  });
}

/** The inputs of one slice: `all` keeps every record with the accounts summed; a key keeps that exchange's records and account. */
export function filterRaw(raw: RawInputs, source: ReportSource): RawInputs {
  if (source === 'all') {
    return {
      ...raw,
      account: mergeAccounts(Object.values(raw.accounts).filter((a): a is RawAccount => !!a)),
      copyTrading: mergeCopyTrading(Object.values(raw.copyTradingBySource)),
    };
  }
  const mine = <T extends { source?: SourceKey }>(rows: T[]): T[] => rows.filter((r) => sourceOf(r) === source);
  return {
    ...raw,
    account: raw.accounts[source] ?? ZERO_ACCOUNT,
    positionsRaw: mine(raw.positionsRaw),
    incomeRaw: mine(raw.incomeRaw),
    tradesRaw: mine(raw.tradesRaw),
    openOrdersRaw: mine(raw.openOrdersRaw),
    openAlgoOrdersRaw: mine(raw.openAlgoOrdersRaw),
    forceOrders: mine(raw.forceOrders),
    adl: mine(raw.adl),
    copyTrading: raw.copyTradingBySource[source] ?? null,
    // Binance's own extras (account config, fee burn, commission rates) stay with Binance and `all`.
    ...(source === 'binance' ? {} : { config: {}, feeBurn: null, tradingStatus: null, commission: [] }),
  };
}

/** The merged report plus one per configured source — `GET /binance-dashboard/report?source=`. */
export interface Reports {
  all: Report;
  binance?: Report;
  bybit?: Report;
}

/** Pure: the three slices of one collection through `assembleReport`. */
export function assembleReports(raw: RawInputs, opts: AssembleOptions): Reports {
  const sources = sourcesSummary(raw);
  const out: Reports = { all: assembleReport(filterRaw(raw, 'all'), { ...opts, source: 'all', sources }) };
  for (const key of SOURCE_KEYS) {
    if (raw.sources.some((s) => s.key === key && s.configured)) out[key] = assembleReport(filterRaw(raw, key), { ...opts, source: key, sources });
  }
  return out;
}

export async function buildReports(client: BinanceClient, opts: BuildOptions): Promise<Reports> {
  const started = Date.now();
  const raw = await collectRaw(client, opts);
  const reports = assembleReports(raw, opts);
  const durationMs = Date.now() - started;
  for (const r of Object.values(reports)) if (r) r.meta.durationMs = durationMs;
  return reports;
}

/** The merged report alone (the trade feed, scripts). */
export async function buildReport(client: BinanceClient, opts: BuildOptions): Promise<Report> {
  return (await buildReports(client, opts)).all;
}
