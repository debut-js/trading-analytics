// Turns the raw Bybit payloads (bybit.ts) into the Binance-shaped records the analytics run on, every one tagged
// `source: 'bybit'`. Pure: no I/O, no clock beyond `raw.now`. The mapping was checked against the live account on
// 2026-10-23 (docs/superpowers/specs/2026-10-23-bybit-source-design.md): a TRADE row of the transaction log carries
// the realised PnL of exactly one execution in `cashFlow` (its `tradeId` = the execution's `execId`), the fee in `fee`
// (positive = expense); SETTLEMENT rows carry the funding; TRANSFER_IN / TRANSFER_OUT rows have no category.
const num = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
};
const str = (n) => String(Math.round(n * 1e8) / 1e8);
/** Stable 53-bit integer of a string (two FNV-1a passes): Bybit ids are UUID-like strings, the record types want numbers. */
export function hash53(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
    }
    return (h1 % 0x200000) * 0x100000000 + h2; // < 2^53
}
/** Executions that move a position; Funding / Settle rows of the list are booked through the transaction log instead. */
const FILL_TYPES = new Set(['Trade', 'AdlTrade', 'BustTrade', 'Delivery']);
/** Log rows of a derivatives execution: realised PnL in cashFlow, the fee in fee. */
const TRADE_TYPES = new Set(['TRADE', 'LIQUIDATION', 'ADL', 'DELIVERY']);
const TRANSFER_TYPES = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'BONUS_TRANSFER_IN', 'BONUS_TRANSFER_OUT']);
const CONVERT_TYPES = new Set(['CURRENCY_BUY', 'CURRENCY_SELL', 'CONVERT', 'SPOT_REPAYMENT_BUY', 'SPOT_REPAYMENT_SELL']);
const DERIVATIVES = new Set(['linear', 'inverse', 'option']);
const TP_STOP_TYPES = new Set(['TakeProfit', 'PartialTakeProfit']);
const positionSideOf = (idx) => (idx === 1 ? 'LONG' : idx === 2 ? 'SHORT' : 'BOTH');
/** The transaction log as Binance income records. */
export function mapBybitIncome(log) {
    const out = [];
    const push = (r, incomeType, income) => {
        if (income === 0)
            return;
        out.push({
            symbol: r.symbol ?? '',
            incomeType,
            income: str(income),
            asset: r.currency,
            time: Number(r.transactionTime),
            tranId: hash53(`${r.id}|${incomeType}`),
            ...(r.tradeId ? { tradeId: r.tradeId } : {}),
            source: 'bybit',
        });
    };
    for (const r of log) {
        const t = r.type;
        if (TRADE_TYPES.has(t) || t === 'SETTLEMENT') {
            if (DERIVATIVES.has(r.category) || t === 'SETTLEMENT') {
                push(r, 'REALIZED_PNL', num(r.cashFlow));
                push(r, 'COMMISSION', -num(r.fee));
                push(r, 'FUNDING_FEE', num(r.funding));
            }
            else {
                push(r, 'AUTO_EXCHANGE', num(r.change)); // a spot fill is a swap between assets, not performance (a flow per asset)
            }
        }
        else if (TRANSFER_TYPES.has(t))
            push(r, 'TRANSFER', num(r.change));
        else if (t === 'BONUS' || t === 'AIRDROP' || t === 'BONUS_RECOLLECT')
            push(r, 'WELCOME_BONUS', num(r.change) || num(r.bonusChange));
        else if (t === 'FEE_REFUND')
            push(r, 'COMMISSION_REBATE', num(r.change));
        else if (CONVERT_TYPES.has(t))
            push(r, 'AUTO_EXCHANGE', num(r.change));
        else
            push(r, t, num(r.change)); // INTEREST and the rest: analytics' `other`, counted towards net like Binance's unknown types
    }
    return out;
}
/** The fills, with the realised PnL joined from the log by `tradeId`; `id` = rank in time order (the trips sort by it). */
export function mapBybitFills(executions, log, warnings) {
    const pnl = new Map();
    for (const r of log) {
        if (TRADE_TYPES.has(r.type) && r.tradeId)
            pnl.set(r.tradeId, (pnl.get(r.tradeId) ?? 0) + num(r.cashFlow));
    }
    const fills = executions.filter((e) => FILL_TYPES.has(e.execType)).sort((a, b) => Number(a.execTime) - Number(b.execTime) || a.execId.localeCompare(b.execId));
    let unmatched = 0;
    const out = fills.map((e, i) => {
        const realized = pnl.get(e.execId);
        if (realized === undefined && num(e.closedSize) > 0)
            unmatched++;
        return {
            symbol: e.symbol,
            id: i + 1,
            orderId: hash53(e.orderId),
            side: e.side === 'Buy' ? 'BUY' : 'SELL',
            positionSide: 'BOTH', // positionIdx is not on a fill; the account trades one-way
            price: e.execPrice,
            qty: e.execQty,
            quoteQty: e.execValue,
            realizedPnl: str(realized ?? 0),
            commission: e.execFee,
            commissionAsset: e.feeCurrency || 'USDT',
            maker: e.isMaker,
            time: Number(e.execTime),
            source: 'bybit',
        };
    });
    if (unmatched > 0)
        warnings.push(`bybit fills: ${unmatched} closing fill${unmatched === 1 ? '' : 's'} without a transaction-log row; realised PnL counted as 0`);
    return out;
}
export function mapBybitPositions(positions, marginType) {
    return positions
        .filter((p) => num(p.size) !== 0)
        .map((p) => ({
        symbol: p.symbol,
        positionSide: positionSideOf(p.positionIdx),
        positionAmt: str(p.side === 'Sell' ? -num(p.size) : num(p.size)),
        entryPrice: p.avgPrice,
        markPrice: p.markPrice,
        unRealizedProfit: p.unrealisedPnl,
        liquidationPrice: num(p.liqPrice) > 0 ? p.liqPrice : '0',
        leverage: num(p.leverage) > 0 ? p.leverage : '1',
        marginType,
        isolatedMargin: p.positionIM || '0',
        notional: num(p.positionValue) > 0 ? p.positionValue : str(num(p.size) * num(p.markPrice)),
        updateTime: Number(p.updatedTime) || Number(p.createdTime) || 0,
        source: 'bybit',
    }));
}
const conditionalType = (o) => {
    const market = o.orderType === 'Market' ? '_MARKET' : '';
    if (TP_STOP_TYPES.has(o.stopOrderType))
        return `TAKE_PROFIT${market}`;
    if (o.stopOrderType === 'TrailingStop')
        return 'TRAILING_STOP_MARKET';
    return `STOP${market}`;
};
/**
 * Open orders as /openOrders rows: a conditional one carries its trigger as the stop price and `closePosition` when it
 * closes on trigger. A position's own take profit / stop loss that has no conditional order of its kind resting becomes a
 * synthetic close-all order, so the positions table shows it like Binance's close-all stops.
 */
export function mapBybitOrders(orders, positions) {
    const out = orders.map((o) => ({
        symbol: o.symbol,
        orderId: hash53(o.orderId),
        side: o.side === 'Buy' ? 'BUY' : 'SELL',
        positionSide: positionSideOf(o.positionIdx),
        type: o.stopOrderType ? conditionalType(o) : o.orderType.toUpperCase(),
        price: o.price || '0',
        stopPrice: o.triggerPrice || '0',
        origQty: o.qty || '0',
        executedQty: o.cumExecQty || '0',
        reduceOnly: o.reduceOnly || o.closeOnTrigger,
        closePosition: !!o.stopOrderType && o.closeOnTrigger,
        timeInForce: o.timeInForce,
        time: Number(o.createdTime) || 0,
        source: 'bybit',
    }));
    for (const p of positions) {
        if (num(p.size) === 0)
            continue;
        const mine = orders.filter((o) => o.symbol === p.symbol && o.stopOrderType);
        const side = p.side === 'Sell' ? 'BUY' : 'SELL';
        const synthetic = (kind, price) => ({
            symbol: p.symbol,
            orderId: hash53(`${p.symbol}|${kind}|${price}`),
            side,
            positionSide: positionSideOf(p.positionIdx),
            type: kind === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            price: '0',
            stopPrice: price,
            origQty: '0',
            executedQty: '0',
            reduceOnly: true,
            closePosition: true,
            timeInForce: 'GTC',
            time: Number(p.updatedTime) || 0,
            source: 'bybit',
        });
        if (num(p.takeProfit) > 0 && !mine.some((o) => TP_STOP_TYPES.has(o.stopOrderType)))
            out.push(synthetic('tp', p.takeProfit));
        if (num(p.stopLoss) > 0 && !mine.some((o) => !TP_STOP_TYPES.has(o.stopOrderType) && o.stopOrderType !== 'TrailingStop'))
            out.push(synthetic('sl', p.stopLoss));
    }
    return out;
}
/** The Unified wallet as a Binance futures account: USD totals, the coins as assets. */
export function mapBybitAccount(raw) {
    const w = raw.wallet;
    const coins = w.coin ?? [];
    const sum = (pick) => str(coins.reduce((s, c) => s + num(pick(c)), 0));
    const available = w.totalAvailableBalance || '0';
    return {
        totalWalletBalance: w.totalWalletBalance || '0',
        totalUnrealizedProfit: w.totalPerpUPL || '0',
        totalMarginBalance: w.totalMarginBalance || '0',
        totalInitialMargin: w.totalInitialMargin || '0',
        totalMaintMargin: w.totalMaintenanceMargin || '0',
        totalPositionInitialMargin: sum((c) => c.totalPositionIM),
        totalOpenOrderInitialMargin: sum((c) => c.totalOrderIM),
        totalCrossWalletBalance: w.totalWalletBalance || '0',
        totalCrossUnPnl: w.totalPerpUPL || '0',
        availableBalance: available,
        maxWithdrawAmount: available,
        assets: coins.map((c) => ({
            asset: c.coin,
            walletBalance: c.walletBalance || '0',
            unrealizedProfit: c.unrealisedPnl || '0',
            marginBalance: c.equity || '0',
            maintMargin: c.totalPositionMM || '0',
            initialMargin: c.totalPositionIM || '0',
            availableBalance: coins.length === 1 ? available : '0',
            maxWithdrawAmount: coins.length === 1 ? available : '0',
        })),
    };
}
/** Bybit contracts named differently from Binance's for the same coin. */
export const BYBIT_SYMBOL_ALIAS = { PUMPFUNUSDT: 'PUMPUSDT', SHIB1000USDT: '1000SHIBUSDT' };
const sameName = (rows) => rows.map((r) => (r.symbol && BYBIT_SYMBOL_ALIAS[r.symbol] ? { ...r, symbol: BYBIT_SYMBOL_ALIAS[r.symbol] } : r));
export function mapBybit(input) {
    // one name per coin across the exchanges, so a market, a position and a trip read the same on both
    const raw = { ...input, positions: sameName(input.positions), log: sameName(input.log), executions: sameName(input.executions), orders: sameName(input.orders) };
    const warnings = [...raw.warnings];
    const marginType = raw.info?.marginMode === 'ISOLATED_MARGIN' ? 'isolated' : 'cross';
    const positions = mapBybitPositions(raw.positions, marginType);
    // Bybit's ADL indicator has five lights, Binance's quantile four; the top light maps onto the top quantile.
    const adl = raw.positions
        .filter((p) => num(p.size) !== 0)
        .map((p) => ({ symbol: p.symbol, adlQuantile: { [positionSideOf(p.positionIdx)]: Math.min(4, Math.max(0, Math.round(num(p.adlRankIndicator)))) } }));
    return {
        account: mapBybitAccount(raw),
        positions,
        income: mapBybitIncome(raw.log),
        trades: mapBybitFills(raw.executions, raw.log, warnings),
        orders: mapBybitOrders(raw.orders, raw.positions),
        adl,
        marginType,
        isMasterTrader: raw.info ? raw.info.isMasterTrader : null,
        warnings,
    };
}
