// BNBUSDT daily closes from the public klines endpoint. Fees paid in BNB (the fee-discount asset) are
// valued at the close of the day they were charged, not at today's price:
// ~$13 of the fixture's +$25.35 hero figure is BNB, so this matters.
//
// One KlinesStore lives per process (plugin.ts). A failed
// refresh keeps the last good closes ('last-good') so the hero does not jump
// by half its value when Binance hiccups; 'none' only before the first success.

import { MAIN_ASSET, dayKey, type RateFn } from './analytics.js';
import type { BinanceClient } from './binance.js';

export interface BnbRates {
  /** Close of the latest known day (0 when nothing is known). */
  current: number;
  /** 'YYYY-MM-DD' (UTC open time) → close. */
  daily: Record<string, number>;
  source: 'klines' | 'last-good' | 'none';
  fetchedAt: number | null;
}

/** Binance kline row: [openTime, open, high, low, close, volume, closeTime, …]. */
type KlineRow = unknown[];

/** GET /fapi/v1/klines?symbol=BNBUSDT&interval=1d&limit=<limit> (public, weight 1) → { 'YYYY-MM-DD': close }. */
export async function fetchBnbDailyCloses(client: BinanceClient, limit = 90): Promise<Record<string, number>> {
  const rows = await client.public<KlineRow[]>('/fapi/v1/klines', { symbol: 'BNBUSDT', interval: '1d', limit });
  const out: Record<string, number> = {};
  for (const k of rows) {
    const openTime = Number(k[0]);
    const close = Number(k[4]);
    if (!Number.isFinite(openTime) || !Number.isFinite(close) || close <= 0) continue;
    out[dayKey(openTime)] = close;
  }
  return out;
}

/** `current` = close of the max key; source 'klines'. */
export function bnbRatesFromCloses(daily: Record<string, number>, now: number): BnbRates {
  const keys = Object.keys(daily).sort();
  const last = keys[keys.length - 1];
  const sorted: Record<string, number> = {};
  for (const k of keys) sorted[k] = daily[k] as number;
  return { current: last === undefined ? 0 : (daily[last] as number), daily: sorted, source: 'klines', fetchedAt: now };
}

export interface KlinesStore {
  /**
   * Fetch; on success source = 'klines' and null is returned. On failure the
   * previous closes are kept (source 'last-good') or, before any success,
   * source = 'none'. Returns a warning string prefixed `klines: ` or null. Never throws.
   */
  refresh(client: BinanceClient, now: number): Promise<string | null>;
  get(): BnbRates;
}

const EMPTY: BnbRates = { current: 0, daily: {}, source: 'none', fetchedAt: null };

export function createKlinesStore(): KlinesStore {
  let state: BnbRates = EMPTY;
  return {
    async refresh(client, now) {
      try {
        const daily = await fetchBnbDailyCloses(client);
        if (Object.keys(daily).length === 0) throw new Error('empty klines response');
        state = bnbRatesFromCloses(daily, now);
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (state.fetchedAt !== null) {
          const fetchedAtIso = new Date(state.fetchedAt).toISOString();
          state = { ...state, source: 'last-good' };
          return `klines: ${message}; using BNBUSDT closes fetched at ${fetchedAtIso}`;
        }
        state = EMPTY;
        return `klines: ${message}; BNB rate unavailable`;
      }
    },
    get: () => ({ ...state, daily: { ...state.daily } }),
  };
}

/**
 * Resolution: 'USDT' → 1; 'BNB' → bnb.daily[day] ?? close of the latest daily
 * key ≤ day ?? (bnb.current > 0 ? bnb.current : undefined); anything else → others[asset].
 */
export function makeRateFn(bnb: BnbRates, others: Record<string, number> = {}): RateFn {
  const keys = Object.keys(bnb.daily).sort();
  return (asset, day) => {
    if (asset === MAIN_ASSET) return 1;
    if (asset === 'BNB') {
      const exact = bnb.daily[day];
      if (exact !== undefined) return exact;
      let best: string | undefined;
      for (const k of keys) {
        if (k <= day) best = k;
        else break;
      }
      if (best !== undefined) return bnb.daily[best];
      return bnb.current > 0 ? bnb.current : undefined;
    }
    return others[asset];
  };
}
