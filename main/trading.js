'use strict';
// Trading goes through official exchange APIs (via ccxt), never by clicking
// in a browser. Agent orders are checked against the standing mandate the
// user approves once in the Trading panel; inside those limits they execute
// automatically, with no per-trade prompt.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJson, appendJsonl, readJsonl, newId } = require('./store');

const STABLES = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'PYUSD']);
const PAPER_ID = 'paper';

let _ccxt = null;
function ccxt() {
  // ccxt is large; load it only when trading is first used.
  if (!_ccxt) _ccxt = require('ccxt');
  return _ccxt;
}

const DEFAULT_MANDATE = {
  enabled: false,
  approvedAt: null,
  expiresAt: null,
  maxOrderUsd: 100,
  maxDailyUsd: 1000,
  maxOrdersPerDay: 50,
  allowedSymbols: '',
  accounts: [PAPER_ID],
  maxDailyLossUsd: 0, // 0 = off
  maxOpenPositions: 0, // 0 = off
  sellOnly: false,
  requireStopLoss: false,
  allowFutures: false, // perpetual/futures symbols like BTC/USDT:USDT
  maxLeverage: 1,
};

// A simulated account priced from a real exchange's public market data, so
// strategies can be tested end to end without risking money.
class PaperExchange {
  constructor(file) {
    this.file = file;
    this.state = readJson(file, null) || { balances: { USDT: 10000 }, openOrders: [], fills: [] };
    this.sources = ['binance', 'okx', 'kraken', 'coinbase'];
    this.source = null;
  }

  save() { writeJson(this.file, this.state); }

  async priceExchange() {
    if (this.source) return this.source;
    let lastErr;
    for (const id of this.sources) {
      try {
        const ex = new (ccxt()[id])({ enableRateLimit: true });
        await ex.loadMarkets();
        this.source = ex;
        return ex;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`No public price source reachable: ${lastErr?.message}`);
  }

  async fetchTicker(symbol) {
    const ex = await this.priceExchange();
    if (!ex.markets[symbol]) throw new Error(`Unknown symbol ${symbol} on price source ${ex.id}. Use the BASE/QUOTE format, e.g. BTC/USDT.`);
    return ex.fetchTicker(symbol);
  }

  // Funds locked by open limit orders (quote for buys incl. fee, base for sells).
  reserved() {
    const r = {};
    for (const o of this.state.openOrders) {
      const [base, quote] = o.symbol.split('/');
      if (o.side === 'buy') r[quote] = (r[quote] || 0) + o.amount * o.price * 1.001;
      else r[base] = (r[base] || 0) + o.amount;
    }
    return r;
  }

  async fetchBalance() {
    const total = {}, free = {};
    const res = this.reserved();
    for (const [c, v] of Object.entries(this.state.balances)) {
      if (Math.abs(v) <= 1e-12) continue;
      total[c] = v;
      free[c] = v - (res[c] || 0);
    }
    return { total, free };
  }

  _fill(order, price) {
    const [base, quote] = order.symbol.split('/');
    const cost = order.amount * price;
    const fee = cost * 0.001;
    const b = this.state.balances;
    const res = this.reserved();
    if (order.side === 'buy') {
      if ((b[quote] || 0) - (res[quote] || 0) < cost + fee) throw new Error(`Insufficient ${quote}: need ${(cost + fee).toFixed(4)}, have ${(b[quote] || 0).toFixed(4)}`);
      b[quote] = (b[quote] || 0) - cost - fee;
      b[base] = (b[base] || 0) + order.amount;
    } else {
      if ((b[base] || 0) - (res[base] || 0) < order.amount - 1e-12) throw new Error(`Insufficient ${base}: need ${order.amount}, have ${b[base] || 0}`);
      b[base] = (b[base] || 0) - order.amount;
      b[quote] = (b[quote] || 0) + cost - fee;
    }
    const filled = { ...order, status: 'closed', filled: order.amount, average: price, price: order.price ?? price, cost, fee: { cost: fee, currency: quote }, filledAt: new Date().toISOString() };
    this.state.fills.push(filled);
    if (this.state.fills.length > 1000) this.state.fills.splice(0, 200);
    return filled;
  }

  async createOrder(symbol, type, side, amount, price) {
    const t = await this.fetchTicker(symbol);
    const order = { id: newId('po'), symbol, type, side, amount, price: price ?? null, timestamp: Date.now(), datetime: new Date().toISOString() };
    const last = t.last ?? t.close;
    const marketPrice = side === 'buy' ? (t.ask ?? last) : (t.bid ?? last);
    let result;
    if (type === 'market') {
      result = this._fill(order, marketPrice);
    } else if ((side === 'buy' && price >= marketPrice) || (side === 'sell' && price <= marketPrice)) {
      result = this._fill(order, price);
    } else {
      const [base, quote] = symbol.split('/');
      const res = this.reserved();
      const b = this.state.balances;
      if (side === 'buy' && (b[quote] || 0) - (res[quote] || 0) < amount * price * 1.001) throw new Error(`Insufficient free ${quote} for this limit order`);
      if (side === 'sell' && (b[base] || 0) - (res[base] || 0) < amount - 1e-12) throw new Error(`Insufficient free ${base} for this limit order`);
      result = { ...order, status: 'open', filled: 0 };
      this.state.openOrders.push(result);
    }
    this.save();
    return result;
  }

  async fetchOpenOrders(symbol) {
    await this.matchOpenOrders();
    return this.state.openOrders.filter(o => !symbol || o.symbol === symbol);
  }

  async cancelOrder(id) {
    const o = this.state.openOrders.find(x => x.id === id);
    if (!o) throw new Error(`No open paper order ${id}`);
    this.state.openOrders = this.state.openOrders.filter(x => x.id !== id);
    this.save();
    return { ...o, status: 'canceled' };
  }

  async matchOpenOrders() {
    if (this.matching) return [];
    this.matching = true;
    try { return await this._matchOpenOrders(); } finally { this.matching = false; }
  }
  async _matchOpenOrders() {
    if (!this.state.openOrders.length) return [];
    const done = [];
    for (const o of [...this.state.openOrders]) {
      try {
        const t = await this.fetchTicker(o.symbol);
        const last = t.last ?? t.close;
        if ((o.side === 'buy' && last <= o.price) || (o.side === 'sell' && last >= o.price)) {
          this.state.openOrders = this.state.openOrders.filter(x => x.id !== o.id);
          done.push(this._fill(o, o.price));
        }
      } catch (e) {
        o.lastError = e.message;
      }
    }
    if (done.length) { this.save(); for (const order of done) this.onFill?.(order); }
    return done;
  }

  reset(usdt = 10000) {
    this.state = { balances: { USDT: usdt }, openOrders: [], fills: [] };
    this.save();
  }
}

class Trading extends EventEmitter {
  constructor({ ws, keys, activity }) {
    super();
    this.ws = ws;
    this.keys = keys;
    this.activity = activity;
    this.paper = new PaperExchange(path.join(ws.root, 'paper.json'));
    this.instances = new Map();
    this.halted = false;
    this.paper.onFill = o => this._record({ account: PAPER_ID, accountLabel: 'Paper', actor: 'system', side: o.side, symbol: o.symbol, amount: o.amount, type: 'limit-fill', price: o.price, notionalUsd: null, status: 'filled', orderId: o.id });
    this._timer = setInterval(() => this.paper.matchOpenOrders().catch(() => {}), 20000);
    this._timer.unref?.();
  }

  dispose() { clearInterval(this._timer); }

  // ---------- mandate ----------
  get mandate() {
    return { ...DEFAULT_MANDATE, ...(this.ws.settings.mandate || {}) };
  }

  setMandate(patch, actor = 'user') {
    if (actor !== 'user') throw new Error('Only the user can change the trading mandate.');
    const m = { ...this.mandate };
    for (const k of ['maxOrderUsd', 'maxDailyUsd', 'maxOrdersPerDay']) {
      if (patch[k] !== undefined) {
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number`);
        m[k] = n;
      }
    }
    for (const k of ['maxDailyLossUsd', 'maxOpenPositions']) {
      if (patch[k] !== undefined) {
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be 0 (off) or a positive number`);
        m[k] = n;
      }
    }
    for (const k of ['sellOnly', 'requireStopLoss', 'allowFutures']) if (patch[k] !== undefined) m[k] = !!patch[k];
    if (patch.maxLeverage !== undefined) {
      const n = Number(patch.maxLeverage);
      if (!Number.isFinite(n) || n < 1 || n > 125) throw new Error('maxLeverage must be between 1 and 125');
      m.maxLeverage = Math.floor(n);
    }
    if (patch.allowedSymbols !== undefined) m.allowedSymbols = String(patch.allowedSymbols);
    if (Array.isArray(patch.accounts)) m.accounts = patch.accounts;
    if (patch.expiresAt !== undefined) m.expiresAt = patch.expiresAt;
    if (patch.enabled !== undefined) {
      m.enabled = !!patch.enabled;
      m.approvedAt = m.enabled ? new Date().toISOString() : null;
    }
    this.ws.settings.mandate = m;
    this.ws.saveSettings();
    this.activity.log('user', m.enabled ? 'mandate.approved' : 'mandate.updated', this.describeMandate(m));
    this.emit('changed');
    return m;
  }

  describeMandate(m = this.mandate) {
    if (!m.enabled) return 'Auto-trading is OFF';
    const accs = m.accounts.map(a => this.accountLabel(a)).join(', ') || 'no accounts';
    const extra = [m.maxDailyLossUsd > 0 && `max daily loss ${m.maxDailyLossUsd}`, m.maxOpenPositions > 0 && `max ${m.maxOpenPositions} open positions`, m.requireStopLoss && 'stop-loss required on buys', m.sellOnly && 'SELL-ONLY', m.allowFutures ? `futures allowed up to ${m.maxLeverage}x` : 'no futures'].filter(Boolean).join(', ');
    return `Auto-trading ON: max ${m.maxOrderUsd}/order, ${m.maxDailyUsd}/day, ${m.maxOrdersPerDay} orders/day, symbols: ${m.allowedSymbols || 'any'}, accounts: ${accs}${extra ? ', ' + extra : ''}${m.expiresAt ? `, expires ${m.expiresAt}` : ''}`;
  }

  // ---------- accounts ----------
  accounts() {
    const list = [{ id: PAPER_ID, label: 'Paper (simulated)', exchange: 'paper', live: false, linkedBrowsers: [] }];
    for (const k of this.keys.entries.filter(e => e.kind === 'exchange')) {
      list.push({ id: k.id, label: k.label, exchange: k.exchange, live: !k.sandbox, sandbox: !!k.sandbox, linkedBrowsers: k.linkedBrowsers || [] });
    }
    return list;
  }

  accountLabel(id) {
    return this.accounts().find(a => a.id === id)?.label || id;
  }

  invalidate(id) {
    this.instances.delete(id);
  }

  async exchange(accountId) {
    if (accountId === PAPER_ID) return this.paper;
    const k = this.keys.get(accountId);
    if (!k || k.kind !== 'exchange') throw new Error(`Unknown trading account "${accountId}". Call trading_status to list accounts.`);
    const cached = this.instances.get(accountId);
    if (cached && cached.updatedAt === k.updatedAt) return cached.ex;
    const Cls = ccxt()[k.exchange];
    if (!Cls) throw new Error(`Exchange "${k.exchange}" is not supported.`);
    const ex = new Cls({ apiKey: k.apiKey, secret: k.secret, password: k.password, uid: k.uid, walletAddress: k.walletAddress, privateKey: k.privateKey, enableRateLimit: true });
    if (k.sandbox) {
      if (!ex.urls?.test) throw new Error(`${k.exchange} has no testnet in ccxt; untick "Testnet" to use it live.`);
      ex.setSandboxMode(true);
    }
    await ex.loadMarkets();
    this.instances.set(accountId, { ex, updatedAt: k.updatedAt });
    return ex;
  }

  async ticker(accountId, symbol) {
    const ex = await this.exchange(accountId);
    const t = await ex.fetchTicker(symbol);
    return { symbol, last: t.last ?? t.close, bid: t.bid, ask: t.ask, high: t.high, low: t.low, changePct: t.percentage, volume: t.baseVolume, time: t.datetime };
  }

  async balance(accountId) {
    const ex = await this.exchange(accountId);
    const b = await ex.fetchBalance();
    const out = {};
    for (const [c, v] of Object.entries(b.total || {})) if (v && Math.abs(v) > 1e-12) out[c] = { total: v, free: b.free?.[c] ?? null };
    return out;
  }

  async openOrders(accountId, symbol) {
    const ex = await this.exchange(accountId);
    const orders = await ex.fetchOpenOrders(symbol || undefined);
    return orders.map(o => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, amount: o.amount, price: o.price, filled: o.filled, status: o.status, reduceOnly: !!(o.reduceOnly ?? o.info?.reduceOnly), time: o.datetime }));
  }

  async cancelOrder({ accountId, orderId, symbol, actor = 'user' }) {
    if (actor === 'agent') this._assertAgentAllowed(accountId);
    const ex = await this.exchange(accountId);
    const r = await ex.cancelOrder(orderId, symbol);
    this.activity.log(actor, 'trade.cancel', `${this.accountLabel(accountId)} order ${orderId} ${symbol || ''}`);
    this.emit('changed');
    return { id: r?.id || orderId, status: r?.status || 'canceled' };
  }

  history(limit = 50) {
    return readJsonl(this.ws.tradesFile, limit).reverse();
  }

  todayUsage() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = readJsonl(this.ws.tradesFile).filter(t => t.actor === 'agent' && t.status !== 'rejected' && t.status !== 'error' && String(t.time).startsWith(today));
    return { orders: rows.length, notionalUsd: rows.reduce((s, t) => s + (t.notionalUsd || 0), 0) };
  }

  setHalted(halted) {
    this.halted = halted;
    this.emit('changed');
  }

  _assertAgentAllowed(accountId) {
    const m = this.mandate;
    if (this.halted) throw new Error('The user pressed STOP: agent actions are paused.');
    if (!m.enabled) throw new Error('Auto-trading is not approved. The user must approve it once in the Trading panel.');
    if (m.expiresAt && Date.now() > Date.parse(m.expiresAt)) throw new Error('The auto-trading approval has expired. Ask the user to renew it in the Trading panel.');
    if (!m.accounts.includes(accountId)) throw new Error(`Account "${this.accountLabel(accountId)}" is not included in the auto-trading approval.`);
  }

  async _usdValue(ex, accountId, symbol, amount, price) {
    const base = symbol.split('/')[0];
    const quote = (symbol.split('/')[1] || '').split(':')[0];
    const quoteAmt = amount * price;
    if (STABLES.has(quote)) return quoteAmt;
    for (const s of ['USDT', 'USD', 'USDC']) {
      try {
        const t = await ex.fetchTicker(`${quote}/${s}`);
        return quoteAmt * (t.last ?? t.close);
      } catch { /* try next */ }
    }
    try {
      const t = await ex.fetchTicker(`${base}/USDT`);
      return amount * (t.last ?? t.close);
    } catch {
      throw new Error(`Cannot value ${symbol} in USD to check the limits; trade a pair quoted in a stablecoin instead.`);
    }
  }

  placeOrder(args) {
    const run = (this.orderQueue || Promise.resolve()).then(() => this._placeOrder(args));
    this.orderQueue = run.catch(() => {});
    return run;
  }

  async _placeOrder({ accountId, symbol, side, type = 'market', amount, price, reason = '', actor = 'user', stopLoss, takeProfit, trailPct, leverage }) {
    const base = { id: newId('t'), time: new Date().toISOString(), account: accountId, accountLabel: this.accountLabel(accountId), actor, symbol, side, type, amount, price: price ?? null, reason };
    try {
      if (!['buy', 'sell'].includes(side)) throw new Error('side must be "buy" or "sell"');
      if (!['market', 'limit'].includes(type)) throw new Error('type must be "market" or "limit"');
      amount = Number(amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number (in the base currency)');
      if (type === 'limit') {
        price = Number(price);
        if (!Number.isFinite(price) || price <= 0) throw new Error('limit orders need a positive price');
      }
      if (!/^[A-Z0-9.\-]+\/[A-Z0-9.\-]+(:[A-Z0-9]+)?$/i.test(symbol || '')) throw new Error('symbol must look like BTC/USDT');
      symbol = symbol.toUpperCase();
      base.symbol = symbol;

      // Futures: symbols in ccxt's contract notation (BASE/QUOTE:SETTLE).
      const isFuture = symbol.includes(':');
      leverage = isFuture ? Math.max(1, Math.floor(Number(leverage) || 1)) : undefined;
      base.leverage = leverage || null;
      if (isFuture && accountId === PAPER_ID) throw new Error('The practice account supports spot pairs only (no futures).');
      if (isFuture && actor === 'agent') {
        const m = this.mandate;
        if (!m.allowFutures) throw new Error('Futures are not allowed in your trading limits.');
        if (leverage > m.maxLeverage) throw new Error(`Leverage ${leverage}x is above your limit of ${m.maxLeverage}x.`);
      }
      if (actor === 'agent') {
        this._assertAgentAllowed(accountId);
        await this.risk?.guard({ accountId, symbol, side, stopLoss, amount });
      }
      const ex = await this.exchange(accountId);
      const refPrice = type === 'limit' ? price : (await ex.fetchTicker(symbol)).last;
      const notionalUsd = await this._usdValue(ex, accountId, symbol, amount, refPrice);
      base.notionalUsd = Math.round(notionalUsd * 100) / 100;

      if (actor === 'agent') {
        const m = this.mandate;
        const allowed = m.allowedSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length && !allowed.includes(symbol)) throw new Error(`${symbol} is not in the approved symbols (${allowed.join(', ')}).`);
        if (notionalUsd > m.maxOrderUsd) throw new Error(`Order is ~$${notionalUsd.toFixed(2)}, above the approved max of $${m.maxOrderUsd} per order.`);
        const used = this.todayUsage();
        if (used.orders + 1 > m.maxOrdersPerDay) throw new Error(`Daily order count limit reached (${m.maxOrdersPerDay}).`);
        if (used.notionalUsd + notionalUsd > m.maxDailyUsd) throw new Error(`Daily limit: $${used.notionalUsd.toFixed(2)} already traded today, this order would exceed $${m.maxDailyUsd}.`);
      }

      if (isFuture && ex.setLeverage) await ex.setLeverage(leverage, symbol);
      if (side === 'buy' && stopLoss && Number(stopLoss) >= refPrice) throw new Error(`stopLoss (${stopLoss}) must be below the current price (${refPrice}).`);
      if (side === 'buy' && takeProfit && Number(takeProfit) <= refPrice) throw new Error(`takeProfit (${takeProfit}) must be above the current price (${refPrice}).`);
      if (ex !== this.paper && ex.amountToPrecision) amount = Number(ex.amountToPrecision(symbol, amount));
      if (ex !== this.paper && type === 'limit' && ex.priceToPrecision) price = Number(ex.priceToPrecision(symbol, price));
      for (const [key, value] of Object.entries({ stopLoss, takeProfit, trailPct })) {
        if (value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error(key + ' must be a positive number');
      }
      if (Number(trailPct) >= 100) throw new Error('trailPct must be less than 100');
      if (!(amount > 0) || !Number.isFinite(refPrice) || refPrice <= 0) throw new Error('Invalid amount or current price');
      if (actor === 'agent') this._assertAgentAllowed(accountId);
      if (actor === 'system') {
        const held = this.risk?.held(accountId, symbol) || 0;
        const reduces = side === 'sell' ? held > 0 && amount <= held + 1e-9 : held < 0 && amount <= -held + 1e-9;
        if (!reduces) throw new Error('Automatic exits may only reduce a tracked position');
      }
      const protect = side === 'buy' && (stopLoss || takeProfit || trailPct);
      let o = await ex.createOrder(symbol, type, side, amount, type === 'limit' ? price : undefined);
      // Live exchanges often answer before the order is filled: ask the exchange
      // for the real fill so positions and protection use actual numbers.
      if (ex !== this.paper) o = await this._confirmFill(ex, o, symbol);
      const filledQty = Number(o.filled) > 0 ? Number(o.filled) : (o.status === 'closed' ? amount : 0);
      const status = o.status === 'closed' || (filledQty > 0 && filledQty >= amount * 0.999) ? 'filled' : (o.status || 'submitted');
      const rec = { ...base, amount: status === 'filled' && filledQty ? filledQty : amount, price: o.average ?? o.price ?? price ?? null, status, orderId: o.id, filled: o.filled ?? null };
      if (protect) {
        const levels = { stopLoss: Number(stopLoss) || 0, takeProfit: Number(takeProfit) || 0, trailPct: Number(trailPct) || 0 };
        const b = status === 'filled'
          ? this.risk?.addBracket({ account: accountId, symbol, qty: rec.amount, entry: rec.price || refPrice, ...levels, actor, future: isFuture })
          : this.risk?.addBracket({ account: accountId, symbol, qty: amount, entry: price || refPrice, ...levels, actor, pendingOrderId: o.id, future: isFuture });
        // On real exchanges, also place the exits as orders on the exchange, so
        // they hold even when this app is closed. The app keeps watching as backup.
        if (b && !b.pending && ex !== this.paper) await this.placeNativeExits(ex, b);
        if (b) rec.protection = { stopLoss: b.stopLoss, takeProfit: b.takeProfit, trailPct: b.trailPct, waitingForFill: !!b.pending, onExchange: !!(b.native?.stop || b.native?.take) };
      }
      this._record(rec);
      return rec;
    } catch (e) {
      const rec = { ...base, status: /approved|limit|not in|not included|STOP|expired|not approved|Sell-only|require|must be|not allowed|Leverage|practice account/i.test(e.message) ? 'rejected' : 'error', error: e.message };
      this._record(rec);
      throw Object.assign(new Error(e.message), { record: rec });
    }
  }

  // Stop-loss / take-profit as exchange-side orders where ccxt supports them.
  async placeNativeExits(ex, b) {
    const params = b.future ? { reduceOnly: true } : {};
    const native = {};
    if (b.stopLoss && ex.has?.createStopLossOrder) {
      try { native.stop = (await ex.createStopLossOrder(b.symbol, 'market', 'sell', b.qty, undefined, b.stopLoss, params)).id; } catch (e) { native.stopError = e.message; }
    }
    // Spot exchanges often lock the coins for the first exit, so the second may
    // be refused; the app then watches that level itself.
    if (b.takeProfit && ex.has?.createTakeProfitOrder) {
      try { native.take = (await ex.createTakeProfitOrder(b.symbol, 'market', 'sell', b.qty, undefined, b.takeProfit, params)).id; } catch (e) { native.takeError = e.message; }
    }
    b.native = native;
    this.risk?.save();
    return native;
  }

  async cancelNativeExits(accountId, b, keep) {
    if (!b.native) return;
    const ex = await this.exchange(accountId).catch(() => null);
    if (!ex) return;
    for (const key of ['stop', 'take']) {
      if (b.native[key] && key !== keep) { try { await ex.cancelOrder(b.native[key], b.symbol); } catch { /* already gone */ } }
    }
  }

  async _confirmFill(ex, o, symbol) {
    if (!o?.id || o.status === 'closed' || o.status === 'canceled' || !ex.has?.fetchOrder) return o;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 750));
      try { o = { ...o, ...(await ex.fetchOrder(o.id, symbol)) }; } catch { /* keep the last known state */ }
      if (o.status === 'closed' || o.status === 'canceled' || o.status === 'expired' || o.status === 'rejected') break;
    }
    return o;
  }

  // Current state of an order: { status: 'open'|'closed'|'canceled', filled, average }.
  async orderStatus(accountId, orderId, symbol) {
    if (accountId === PAPER_ID) {
      const fill = this.paper.state.fills.find(f => f.id === orderId);
      if (fill) return { status: 'closed', filled: fill.filled, average: fill.average };
      return this.paper.state.openOrders.some(o => o.id === orderId) ? { status: 'open', filled: 0 } : { status: 'canceled', filled: 0 };
    }
    const ex = await this.exchange(accountId);
    if (!ex.has?.fetchOrder) return { status: 'unknown', filled: 0 };
    const o = await ex.fetchOrder(orderId, symbol);
    return { status: o.status, filled: Number(o.filled) || 0, average: o.average ?? o.price };
  }

  _record(rec, { reconciled = false } = {}) {
    rec.id ||= newId('t');
    rec.time ||= new Date().toISOString();
    appendJsonl(this.ws.tradesFile, rec);
    const settled = ['filled', 'rejected', 'error', 'canceled', 'cancelled', 'expired', 'closed'].includes(rec.status);
    if (!reconciled && !settled && rec.orderId && rec.account !== PAPER_ID) this.risk?.watchOrder(rec);
    this.activity.log(rec.actor, `trade.${rec.status}`, `${rec.side?.toUpperCase()} ${rec.amount} ${rec.symbol} on ${rec.accountLabel}${rec.notionalUsd ? ` (~$${rec.notionalUsd})` : ''}${rec.error ? ': ' + rec.error : ''}`);
    this.notify?.('trades', 'Trade ' + rec.status, rec.side + ' ' + rec.amount + ' ' + rec.symbol + (rec.error ? ': ' + rec.error : ''));
    this.ws.emit('library:changed');
    this.emit('changed');
  }

  state() {
    return {
      mandate: this.mandate,
      mandateText: this.describeMandate(),
      halted: this.halted,
      accounts: this.accounts(),
      usage: this.todayUsage(),
      history: this.history(40),
    };
  }

  static exchangeList() {
    try { return ccxt().exchanges; } catch { return []; }
  }
}

module.exports = { Trading, PaperExchange, PAPER_ID, DEFAULT_MANDATE };
