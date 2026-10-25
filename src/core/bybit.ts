// Minimal signed client for Bybit V5 REST (read-only endpoints) and the raw collection the Bybit half of a report needs.
// Keys never leave this process (they sign requests server-side); the browser only receives the computed report.
// Mapping the raw payloads into the Binance-shaped records the analytics run on is bybit-map.ts (pure), so the fixtures
// can be dumped as the raw lists and replayed.

import { createHmac } from 'node:crypto';

export const BYBIT_HOST = 'https://api.bybit.com';
/** Bybit's documented alternate mainnet host: the client moves to it after an HTTP 403 from the first (an edge block of the
    server's IP, 2026-10-23: `/v5/market/time` answered 403 to a cloud host for a while) and stays there for the process. */
export const BYBIT_FALLBACK_HOST = 'https://api.bytick.com';
/** A request that gets no answer for this long is abandoned; the Bybit half then fails and the report says so. */
export const REQUEST_TIMEOUT_MS = 15_000;
const RECV_WINDOW_MS = 10_000;
const DAY = 86_400_000;
/** The history endpoints take at most 7 days per request. */
const WINDOW_MS = 7 * DAY - 1;
const MAX_PAGES = 200;

export class BybitError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when no response arrived at all (the request timed out). */
    readonly status: number,
    /** Bybit's `retCode` (e.g. 10006 too many visits, 10003 invalid key). */
    readonly retCode?: number,
  ) {
    super(message);
  }
}

/** Bybit asks us to back off: retCode 10006 (endpoint limit) or HTTP 403 (the 600-per-5-s IP limit; the ban lifts after ~10 min). */
export function isBybitRateLimit(e: unknown): e is BybitError {
  return e instanceof BybitError && (e.retCode === 10006 || e.status === 403);
}

const isAbort = (e: unknown): boolean => {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
};

type Params = Record<string, string | number | undefined>;

export interface BybitClient {
  /** `GET` of a V5 endpoint; private paths are signed. Returns `result` of the envelope, throws `BybitError` on `retCode ≠ 0`. */
  get<T>(path: string, params?: Params): Promise<T>;
}

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

function toQuery(params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.append(k, String(v));
  }
  return qs.toString();
}

export function createBybitClient(apiKey: string, apiSecret: string, opts: { host?: string; fallbackHost?: string | null; timeoutMs?: number } = {}): BybitClient {
  const hosts = [(opts.host ?? BYBIT_HOST).replace(/\/$/, '')];
  const fallback = opts.fallbackHost === undefined ? BYBIT_FALLBACK_HOST : opts.fallbackHost;
  if (fallback && fallback.replace(/\/$/, '') !== hosts[0]) hosts.push(fallback.replace(/\/$/, ''));
  let hostIndex = 0;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timeOffset = 0;
  let offsetSyncedAt = 0;

  async function request<T>(path: string, query: string, signed: boolean): Promise<T> {
    try {
      return await requestOn(hosts[hostIndex] as string, path, query, signed);
    } catch (e) {
      // 403 = the edge refused this IP outright (a rate-limit ban or a block), not the request: the alternate host, once, then for good.
      if (e instanceof BybitError && e.status === 403 && hostIndex < hosts.length - 1) {
        hostIndex++;
        return requestOn(hosts[hostIndex] as string, path, query, signed);
      }
      throw e;
    }
  }

  async function requestOn<T>(host: string, path: string, query: string, signed: boolean): Promise<T> {
    const headers: Record<string, string> = {};
    if (signed) {
      // Signature (docs/v5/guide): HMAC-SHA256 over timestamp + key + recvWindow + queryString, lower-case hex.
      const ts = String(Date.now() + timeOffset);
      headers['X-BAPI-API-KEY'] = apiKey;
      headers['X-BAPI-TIMESTAMP'] = ts;
      headers['X-BAPI-RECV-WINDOW'] = String(RECV_WINDOW_MS);
      headers['X-BAPI-SIGN'] = createHmac('sha256', apiSecret).update(`${ts}${apiKey}${RECV_WINDOW_MS}${query}`).digest('hex');
    }
    let res: Response;
    let text: string;
    try {
      // One signal for the whole exchange, body included: a socket that stalls mid-response must not hang the build either.
      res = await fetch(`${host}${path}${query ? `?${query}` : ''}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      if (isAbort(e)) throw new BybitError(`Bybit ${path}: no response within ${timeoutMs / 1000} s`, 0);
      throw e;
    }
    let body: Envelope<T>;
    try {
      body = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new BybitError(`Bybit ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new BybitError(`Bybit ${path}: HTTP ${res.status} ${body.retMsg ?? ''}`.trim(), res.status, body.retCode);
    if (body.retCode !== 0) throw new BybitError(`Bybit ${path}: ${body.retMsg} (${body.retCode})`, res.status, body.retCode);
    return body.result;
  }

  async function syncTime(): Promise<void> {
    // Signed requests are rejected (10002) when our clock sits outside the recv window of the server's.
    if (Date.now() - offsetSyncedAt < 10 * 60_000) return;
    const t = await request<{ timeSecond: string; timeNano: string }>('/v5/market/time', '', false);
    const serverMs = Number(t.timeSecond) * 1000 + Math.floor((Number(t.timeNano) % 1e9) / 1e6);
    if (Number.isFinite(serverMs) && serverMs > 0) timeOffset = serverMs - Date.now();
    offsetSyncedAt = Date.now();
  }

  return {
    async get(path, params = {}) {
      const signed = !path.startsWith('/v5/market/');
      if (signed) await syncTime();
      return request(path, toQuery(params), signed);
    },
  };
}

// ───────────────────────────── raw payloads ─────────────────────────────
// Field names as Bybit returns them (strings for every number). Only the fields bybit-map.ts reads are typed.

export interface BybitAccountInfo {
  unifiedMarginStatus: number;
  marginMode: 'REGULAR_MARGIN' | 'PORTFOLIO_MARGIN' | 'ISOLATED_MARGIN' | string;
  isMasterTrader: boolean;
  updatedTime?: string;
}

export interface BybitCoin {
  coin: string;
  equity: string;
  usdValue: string;
  walletBalance: string;
  unrealisedPnl: string;
  cumRealisedPnl: string;
  totalOrderIM: string;
  totalPositionIM: string;
  totalPositionMM: string;
  bonus?: string;
}

export interface BybitWallet {
  accountType: string;
  totalEquity: string;
  totalWalletBalance: string;
  totalMarginBalance: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  totalInitialMargin: string;
  totalMaintenanceMargin: string;
  coin: BybitCoin[];
}

export interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | '';
  size: string;
  avgPrice: string;
  positionValue: string;
  leverage: string;
  markPrice: string;
  liqPrice: string;
  positionIM: string;
  positionMM: string;
  takeProfit: string;
  stopLoss: string;
  trailingStop: string;
  unrealisedPnl: string;
  curRealisedPnl: string;
  cumRealisedPnl: string;
  adlRankIndicator: number;
  /** 0 one-way, 1 the buy side of hedge mode, 2 the sell side. */
  positionIdx: number;
  positionStatus: string;
  createdTime: string;
  updatedTime: string;
}

/** One row of /v5/account/transaction-log (Unified account). */
export interface BybitLogRow {
  id: string;
  symbol: string;
  category: string;
  side: string;
  transactionTime: string;
  type: string;
  qty: string;
  size: string;
  currency: string;
  tradePrice: string;
  /** Funding received (+) or paid (−). */
  funding: string;
  /** Trading fee charged (+ = expense, − = rebate). */
  fee: string;
  /** Realised PnL of the execution, a transfer's amount, a settlement's session PnL; excludes fee and funding. */
  cashFlow: string;
  /** = cashFlow + funding − fee. */
  change: string;
  cashBalance: string;
  feeRate: string;
  bonusChange: string;
  tradeId: string;
  orderId: string;
  orderLinkId: string;
}

/** One fill of /v5/execution/list. */
export interface BybitExecution {
  symbol: string;
  orderId: string;
  orderLinkId: string;
  side: 'Buy' | 'Sell';
  orderPrice: string;
  orderQty: string;
  leavesQty: string;
  createType?: string;
  orderType: string;
  stopOrderType: string;
  execFee: string;
  execId: string;
  execPrice: string;
  execQty: string;
  /** Trade, AdlTrade, BustTrade, Delivery, Funding, Settle, … */
  execType: string;
  execValue: string;
  execTime: string;
  feeCurrency?: string;
  isMaker: boolean;
  feeRate: string;
  markPrice: string;
  closedSize: string;
}

/** One order of /v5/order/realtime (resting and untriggered conditional ones). */
export interface BybitOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit' | string;
  price: string;
  qty: string;
  cumExecQty: string;
  leavesQty: string;
  orderStatus: string;
  /** '' for a plain order; TakeProfit, StopLoss, PartialTakeProfit, PartialStopLoss, Stop, TrailingStop, … */
  stopOrderType: string;
  triggerPrice: string;
  takeProfit: string;
  stopLoss: string;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  positionIdx: number;
  timeInForce: string;
  createdTime: string;
  updatedTime: string;
}

export interface BybitRaw {
  /** Clock of the collection. */
  now: number;
  info: BybitAccountInfo | null;
  wallet: BybitWallet;
  positions: BybitPosition[];
  /** Every row since `from` (all categories: transfers carry none). */
  log: BybitLogRow[];
  /** Every fill since `tradesFrom`. */
  executions: BybitExecution[];
  orders: BybitOrder[];
  warnings: string[];
}

interface Page<T> {
  list?: T[];
  nextPageCursor?: string;
}

/** Walks the cursor of one request until the last page. */
async function pages<T>(client: BybitClient, path: string, params: Params): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.get<Page<T>>(path, { ...params, cursor });
    out.push(...(res.list ?? []));
    cursor = res.nextPageCursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** The history endpoints: 7-day windows from `from` to `to`, oldest first, every window paged; rows deduplicated by `keyOf`. */
async function windows<T>(client: BybitClient, path: string, params: Params, from: number, to: number, keyOf: (row: T) => string): Promise<T[]> {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let start = from; start <= to; start += WINDOW_MS + 1) {
    const rows = await pages<T>(client, path, { ...params, startTime: start, endTime: Math.min(to, start + WINDOW_MS) });
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

export interface CollectBybitOptions {
  /** Transaction log from here (the income look-back, clamped at the data cut-off by the caller). */
  from: number;
  /** Fills from here (the trades look-back). */
  tradesFrom: number;
  now: number;
  /** Settlement coin of the linear contracts; USDT. */
  settleCoin?: string;
}

/**
 * All Bybit I/O for one report. The wallet and the positions are required (like Binance's account and positionRisk);
 * the account info and the open orders are optional and only leave a warning when they fail.
 */
export async function collectBybitRaw(client: BybitClient, opts: CollectBybitOptions): Promise<BybitRaw> {
  const settleCoin = opts.settleCoin ?? 'USDT';
  const warnings: string[] = [];
  const optional = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      warnings.push(`bybit ${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const [info, wallets, positions, orders] = await Promise.all([
    optional('accountInfo', client.get<BybitAccountInfo>('/v5/account/info'), null),
    client.get<Page<BybitWallet>>('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
    pages<BybitPosition>(client, '/v5/position/list', { category: 'linear', settleCoin, limit: 200 }),
    optional('openOrders', pages<BybitOrder>(client, '/v5/order/realtime', { category: 'linear', settleCoin, openOnly: 0, limit: 50 }), []),
  ]);
  const wallet = wallets.list?.[0];
  if (!wallet) throw new BybitError('Bybit /v5/account/wallet-balance: no UNIFIED wallet in the answer', 200);
  // No `category` filter on the log: the transfer rows carry none, and a deposit filtered out would read as profit.
  const log = await windows<BybitLogRow>(client, '/v5/account/transaction-log', { accountType: 'UNIFIED', limit: 50 }, opts.from, opts.now, (r) => r.id);
  const executions = await windows<BybitExecution>(client, '/v5/execution/list', { category: 'linear', limit: 100 }, opts.tradesFrom, opts.now, (e) => e.execId);
  return { now: opts.now, info, wallet, positions, log, executions, orders, warnings };
}
