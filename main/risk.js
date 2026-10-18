'use strict';
// Protective trading layer: positions and P&L from the app's own trade log,
// stop-loss / take-profit / trailing-stop exits, a maximum daily loss (in USD),
// a cap on open positions, sell-only mode, order reconciliation and close-all.
// Exits run as 'system' orders: they only ever reduce a position, so they keep
// working even when the user has pressed STOP.
const path = require('path');
const { readJson, writeJson, readJsonl, newId } = require('./store');
const { localDay } = require('./activity');

// Quote currencies treated as US dollars for the loss limit. EUR and others are converted.
const STABLE = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'PYUSD']);
const EPS = 1e-12;
const isFutureSymbol = s => String(s).includes(':');
const quoteOf = s => String(s).split('/')[1]?.split(':')[0] || '';
const DONE = new Set(['closed', 'canceled', 'cancelled', 'expired', 'rejected']);

// How much of a trade-log record actually changed the position.
function countedQty(t) {
  if (t.status === 'filled') return Number(t.amount) || 0;
  return Number(t.filled) > 0 ? Number(t.filled) : 0;
}

class Risk {
  constructor({ ws, trading, notify }) {
    this.ws = ws;
    this.trading = trading;
    this.notify = notify;
    this.file = path.join(ws.root, 'brackets.json');
    this.brackets = readJson(this.file, []);
    // Live orders whose final fill isn't known yet (partial fills, open limits).
    this.watchFile = path.join(ws.root, 'order-watch.json');
    this.watch = readJson(this.watchFile, []);
    this.lossWarnedDay = null;
    this.timer = setInterval(() => this.check().catch(() => {}), 15000);
    this.timer.unref?.();
  }

  dispose() { clearInterval(this.timer); }
  save() { writeJson(this.file, this.brackets); writeJson(this.watchFile, this.watch); }

  // ---------- positions ----------
  // Spot positions are long only; futures positions are signed (negative = short).
  positions() {
    const map = new Map();
    const today = localDay();
    for (const t of readJsonl(this.ws.tradesFile)) {
      const amt = countedQty(t), px = Number(t.price);
      if (!(amt > 0) || !(px > 0)) continue;
      const key = `${t.account}|${t.symbol}`;
      const fut = isFutureSymbol(t.symbol);
      const p = map.get(key) || { account: t.account, accountLabel: t.accountLabel, symbol: t.symbol, future: fut, qty: 0, avg: 0, realized: 0, realizedToday: 0 };
      const signed = t.side === 'buy' ? amt : -amt;
      if (Math.abs(p.qty) < EPS || Math.sign(p.qty) === Math.sign(signed)) {
        if (!fut && signed < 0) continue; // a spot sell with nothing tracked (e.g. coins bought elsewhere)
        p.avg = (p.avg * Math.abs(p.qty) + px * amt) / (Math.abs(p.qty) + amt);
        p.qty += signed;
      } else {
        const closing = Math.min(amt, Math.abs(p.qty));
        const pnl = (px - p.avg) * closing * Math.sign(p.qty);
        p.realized += pnl;
        if (localDay(t.time) === today) p.realizedToday += pnl;
        const rest = amt - closing;
        p.qty += Math.sign(signed) * closing;
        if (Math.abs(p.qty) < EPS) { p.qty = 0; p.avg = 0; }
        if (rest > EPS && fut) { p.qty = Math.sign(signed) * rest; p.avg = px; } // flipped from long to short or back
      }
      map.set(key, p);
    }
    return [...map.values()];
  }

  held(account, symbol) {
    return this.positions().find(p => p.account === account && p.symbol === symbol)?.qty || 0;
  }

  // 1 unit of `quote` in USD, using the account's own prices.
  async usdRate(account, quote, cache = new Map()) {
    if (STABLE.has(quote)) return 1;
    const key = `${account}|${quote}`;
    if (cache.has(key)) return cache.get(key);
    for (const s of [`${quote}/USDT`, `${quote}/USD`, `${quote}/USDC`]) {
      try {
        const t = await this.trading.ticker(account, s);
        if (t.last > 0) { cache.set(key, t.last); return t.last; }
      } catch { /* try next */ }
    }
    cache.set(key, null);
    return null;
  }

  async positionsWithPrices() {
    const out = [];
    const rates = new Map();
    for (const p of this.positions()) {
      const row = { ...p, last: null, unrealized: 0, value: 0, quote: quoteOf(p.symbol), usdRate: await this.usdRate(p.account, quoteOf(p.symbol), rates) };
      if (Math.abs(p.qty) > EPS) {
        try {
          const t = await this.trading.ticker(p.account, p.symbol);
          row.last = t.last;
          row.unrealized = (t.last - p.avg) * p.qty;
          row.value = t.last * Math.abs(p.qty);
        } catch { /* price unavailable */ }
      }
      row.unrealizedUsd = row.usdRate ? row.unrealized * row.usdRate : null;
      row.realizedTodayUsd = row.usdRate ? row.realizedToday * row.usdRate : null;
      row.brackets = this.brackets.filter(b => (b.active || b.pending) && b.account === p.account && b.symbol === p.symbol);
      out.push(row);
    }
    return out;
  }

  // Today's realized + open P&L in USD. Positions whose currency can't be
  // converted are listed in `unknown`, so callers can fail safe.
  async todayPnlDetail(accounts) {
    const rows = (await this.positionsWithPrices()).filter(p => !accounts || accounts.includes(p.account));
    let usd = 0;
    const unknown = [];
    for (const p of rows) {
      const local = p.realizedToday + (Math.abs(p.qty) > EPS ? p.unrealized : 0);
      if (Math.abs(local) < EPS) continue;
      if (p.usdRate) usd += local * p.usdRate; else unknown.push(`${p.symbol} (${p.quote})`);
    }
    return { usd, unknown };
  }

  async todayPnl(accounts) {
    return (await this.todayPnlDetail(accounts)).usd;
  }

  // ---------- checks before an agent order ----------
  // "Opening" = a buy, or a futures sell that starts or grows a short.
  async guard({ accountId, symbol, side, stopLoss, amount }) {
    const m = this.trading.mandate;
    const fut = isFutureSymbol(symbol);
    const held = this.held(accountId, symbol);
    const opensShort = fut && side === 'sell' && Number(amount) > Math.max(0, held) + EPS;
    const opening = side === 'buy' ? held >= -EPS : opensShort; // a buy that covers a short is closing
    if (!opening) return;
    if (m.sellOnly) throw new Error(opensShort ? 'Sell-only mode is on: the agent may only close positions, not open shorts.' : 'Sell-only mode is on: the agent may only sell or close positions.');
    if (m.requireStopLoss) {
      if (opensShort) throw new Error('Your limits require a stop-loss, and protective exits for short positions are not supported, so the agent may not open shorts.');
      if (!(Number(stopLoss) > 0)) throw new Error('Your limits require a stop-loss on every agent buy. Add stopLoss (a price).');
    }
    if (m.maxOpenPositions > 0) {
      const open = this.positions().filter(p => Math.abs(p.qty) > EPS && m.accounts.includes(p.account));
      if (!open.some(p => p.account === accountId && p.symbol === symbol) && open.length >= m.maxOpenPositions) {
        throw new Error(`Limit reached: at most ${m.maxOpenPositions} open positions at once.`);
      }
    }
    if (m.maxDailyLossUsd > 0) {
      const { usd, unknown } = await this.todayPnlDetail(m.accounts);
      if (unknown.length) throw new Error(`Can't convert today's result of ${unknown.join(', ')} to USD to check your daily loss limit, so new positions are blocked.`);
      if (usd <= -m.maxDailyLossUsd) throw new Error(`Daily loss limit reached (today ${usd.toFixed(2)} USD, limit -${m.maxDailyLossUsd}). New positions are blocked until tomorrow.`);
    }
  }

  // ---------- reconciliation of live orders ----------
  // Called for every live order the app places that isn't fully settled yet.
  watchOrder(rec) {
    if (!rec.orderId || rec.account === 'paper' || this.watch.some(w => w.orderId === rec.orderId && w.account === rec.account)) return;
    this.watch.push({ account: rec.account, accountLabel: rec.accountLabel, symbol: rec.symbol, side: rec.side, orderId: rec.orderId, counted: countedQty(rec), since: new Date().toISOString() });
    this.save();
  }

  async reconcile() {
    let changed = false;
    for (const w of [...this.watch]) {
      let st;
      try { st = await this.trading.orderStatus(w.account, w.orderId, w.symbol); } catch { continue; }
      const filled = Number(st.filled) || 0;
      if (filled > w.counted + EPS) {
        this.trading._record({ account: w.account, accountLabel: w.accountLabel, actor: 'system', side: w.side, symbol: w.symbol, amount: filled - w.counted, type: 'fill-update', price: st.average, status: 'filled', orderId: w.orderId, reason: 'fill confirmed by the exchange' }, { reconciled: true });
        w.counted = filled;
        changed = true;
      }
      if (DONE.has(st.status)) { this.watch = this.watch.filter(x => x !== w); changed = true; }
    }
    if (changed) this.save();
    return changed;
  }

  // ---------- protective exits ----------
  // pendingOrderId: the buy hasn't filled yet; the exit arms itself once it does.
  addBracket({ account, symbol, qty, entry, stopLoss, takeProfit, trailPct, actor, pendingOrderId, future }) {
    if (!(stopLoss > 0) && !(takeProfit > 0) && !(trailPct > 0)) return null;
    const b = { id: newId('br'), account, symbol, qty, entry, stopLoss: stopLoss > 0 ? stopLoss : null, takeProfit: takeProfit > 0 ? takeProfit : null, trailPct: trailPct > 0 ? trailPct : null, high: entry, actor, future: !!future, active: !pendingOrderId, pending: !!pendingOrderId, pendingOrderId: pendingOrderId || null, createdAt: new Date().toISOString() };
    if (b.trailPct) b.stopLoss = Math.max(b.stopLoss || 0, entry * (1 - b.trailPct / 100));
    this.brackets.push(b);
    this.save();
    return b;
  }

  cancelBracket(id) {
    const b = this.brackets.find(x => x.id === id);
    if (b) { b.active = false; this.save(); }
    return !!b;
  }

  async check() {
    if (this.checking) return;
    this.checking = true;
    try { return await this._check(); } finally { this.checking = false; }
  }

  async _check() {
    // Record fills the exchange reports first, so positions are current below.
    let changed = await this.reconcile();
    // Arm protection for buys that have (partly) filled since they were placed.
    for (const b of this.brackets.filter(x => x.pending)) {
      let st;
      try { st = await this.trading.orderStatus(b.account, b.pendingOrderId, b.symbol); } catch { continue; }
      const filled = Number(st.filled) || 0;
      if (DONE.has(st.status) && filled > 0) {
        Object.assign(b, { pending: false, active: true, qty: filled, entry: st.average || b.entry, high: st.average || b.entry, armedAt: new Date().toISOString(), partial: st.status !== 'closed' });
        if (b.trailPct) b.stopLoss = Math.max(b.stopLoss || 0, b.high * (1 - b.trailPct / 100));
        if (b.account !== 'paper') { try { await this.trading.placeNativeExits(await this.trading.exchange(b.account), b); } catch { /* app keeps watching */ } }
        changed = true;
        this.notify?.('trades', 'Protection armed', `${b.symbol}: ${filled} filled, stop-loss/take-profit is now active.`);
      } else if (DONE.has(st.status)) {
        Object.assign(b, { pending: false, active: false, closedAt: new Date().toISOString(), note: 'buy order was not filled' });
        changed = true;
      }
    }
    // Exchange-side exits that filled (possibly while the app was closed).
    for (const b of this.brackets.filter(x => x.active && x.native && (x.native.stop || x.native.take))) {
      for (const key of ['stop', 'take']) {
        if (!b.native[key] || !b.active) continue;
        let st;
        try { st = await this.trading.orderStatus(b.account, b.native[key], b.symbol); } catch { continue; }
        if (DONE.has(st.status) && st.filled > 0) {
          this.trading._record({ account: b.account, accountLabel: this.trading.accountLabel(b.account), actor: 'system', side: 'sell', symbol: b.symbol, amount: st.filled, type: key === 'stop' ? 'stop-loss (exchange)' : 'take-profit (exchange)', price: st.average, status: 'filled', orderId: b.native[key], reason: 'exit order filled on the exchange' }, { reconciled: true });
          await this.trading.cancelNativeExits(b.account, b, key);
          Object.assign(b, { active: false, closedAt: new Date().toISOString() });
          changed = true;
          this.notify?.('trades', key === 'stop' ? 'stop-loss triggered' : 'take-profit triggered', `Sold ${st.filled} ${b.symbol} on the exchange.`);
        }
      }
    }
    // App-watched exits.
    for (const b of this.brackets.filter(x => x.active)) {
      let last;
      try { last = (await this.trading.ticker(b.account, b.symbol)).last; } catch { continue; }
      if (b.trailPct && last > b.high) {
        b.high = last;
        b.stopLoss = Math.max(b.stopLoss || 0, last * (1 - b.trailPct / 100));
        changed = true;
      }
      const hitStop = b.stopLoss && last <= b.stopLoss;
      const hitTake = b.takeProfit && last >= b.takeProfit;
      if (!hitStop && !hitTake) continue;
      changed = true;
      const qty = Math.min(b.qty, Math.max(0, this.held(b.account, b.symbol)));
      if (qty <= 0) { b.active = false; continue; }
      const why = hitTake ? 'take-profit' : (b.trailPct ? 'trailing stop' : 'stop-loss');
      try {
        await this.trading.cancelNativeExits(b.account, b);
        await this.trading.placeOrder({ accountId: b.account, symbol: b.symbol, side: 'sell', type: 'market', amount: qty, actor: 'system', reason: `${why} at ${last}` });
        b.active = false;
        b.closedAt = new Date().toISOString();
        this.notify?.('trades', `${why} triggered`, `Sold ${qty} ${b.symbol} at about ${last}.`);
      } catch (e) {
        this.notify?.('attention', `${why} could not sell`, `${b.symbol}: ${e.message}`);
      }
    }
    if (changed) { this.save(); this.trading.emit('changed'); }
    // Warn once a day when the daily loss limit is hit.
    const m = this.trading.mandate;
    if (m.maxDailyLossUsd > 0 && this.lossWarnedDay !== localDay()) {
      const { usd } = await this.todayPnlDetail(m.accounts);
      if (usd <= -m.maxDailyLossUsd) {
        this.lossWarnedDay = localDay();
        this.notify?.('trades', 'Daily loss limit reached', `Today ${usd.toFixed(2)} USD. The agent can't open positions until tomorrow.`);
      }
    }
  }

  // ---------- emergency ----------
  // Cancel every open order that could add to a position (buys, and futures
  // sells that aren't reduce-only), on one account or on all of them.
  async cancelPending(accountId = null) {
    const results = [];
    const exitIds = new Set(this.brackets.flatMap(b => [b.native?.stop, b.native?.take]).filter(Boolean));
    const accounts = accountId ? [accountId] : this.trading.accounts().map(a => a.id);
    for (const acc of accounts) {
      let open;
      try { open = await this.trading.openOrders(acc); } catch (e) { if (accountId) results.push({ account: acc, ok: false, error: e.message }); continue; }
      for (const o of open) {
        const adds = o.side === 'buy' || (isFutureSymbol(o.symbol) && !o.reduceOnly);
        if (!adds || exitIds.has(o.id)) continue;
        try {
          await this.trading.cancelOrder({ accountId: acc, orderId: o.id, symbol: o.symbol, actor: 'user' });
          results.push({ account: acc, symbol: o.symbol, orderId: o.id, ok: true, action: 'cancelled pending order' });
        } catch (e) {
          results.push({ account: acc, symbol: o.symbol, orderId: o.id, ok: false, error: e.message });
        }
      }
    }
    for (const b of this.brackets.filter(x => x.pending && (!accountId || x.account === accountId))) Object.assign(b, { pending: false, active: false, closedAt: new Date().toISOString(), note: 'cancelled by the user' });
    this.save();
    this.trading.emit('changed');
    return results;
  }

  // Panic button: sell-only mode, cancel pending orders, then close every tracked position.
  async closeAll(accountId = null) {
    this.trading.setMandate({ sellOnly: true });
    const results = await this.cancelPending(accountId);
    for (const b of this.brackets.filter(x => x.active && x.native && (!accountId || x.account === accountId))) await this.trading.cancelNativeExits(b.account, b);
    for (const p of this.positions().filter(x => Math.abs(x.qty) > EPS && (!accountId || x.account === accountId))) {
      const side = p.qty > 0 ? 'sell' : 'buy';
      try {
        const r = await this.trading.placeOrder({ accountId: p.account, symbol: p.symbol, side, type: 'market', amount: Math.abs(p.qty), actor: 'system', reason: 'close all' });
        results.push({ account: p.account, symbol: p.symbol, ok: true, action: p.qty > 0 ? 'sold' : 'covered short', status: r.status });
      } catch (e) {
        results.push({ account: p.account, symbol: p.symbol, ok: false, error: e.message });
      }
    }
    const remaining = this.positions();
    for (const b of this.brackets.filter(b => b.active && (!accountId || b.account === accountId))) if (!remaining.some(p => p.account === b.account && p.symbol === b.symbol && Math.abs(p.qty) > EPS)) b.active = false;
    this.save();
    this.trading.emit('changed');
    return results;
  }
}

module.exports = { Risk, STABLE, countedQty, isFutureSymbol };
