/* page.js — the trading-analytics page.
   One column, one story: the hero (the account curve runs across its background into the net figure), the live results (a chart
   with period and exchange filters, five key figures), open positions, where the result came from, the days and the coins,
   how the trades behave, the risk and the trades history. A classic script without libraries. It reads the report JSON of
   plugin.ts (GET /binance-dashboard/report?source=all|binance|bybit), its strings from copy.js (BDCopy, EN/RU)
   and its number formats from format.js (BDFormat). The CSP allows no inline styles: dynamic sizes go through the CSSOM
   (el.style.x = …), never through a style attribute. */
(function () {
  'use strict';

  const F = window.BDFormat;
  const COPY = window.BDCopy || { en: {}, ru: {} };
  if (!F) return;   // format.js did not load: the static page stays as served

  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const MINUS = F.MINUS;
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const reduced = () => mq('(prefers-reduced-motion: reduce)');
  const narrow = () => mq('(max-width: 860px)');

  /* ---------- DOM ---------- */
  function h(tag, props, kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of [].concat(kids === undefined ? [] : kids)) {
      if (c === null || c === undefined || c === false || c === '') continue;
      el.append(typeof c === 'object' ? c : String(c));
    }
    return el;
  }
  function s(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, String(attrs[k]));
    if (parent) parent.append(el);
    return el;
  }
  const clear = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); };
  function safe(fn) {
    try { fn(); } catch (e) { console.error('[trading-analytics]', e); }
  }

  /* ---------- language ---------- */
  const LANGS = ['en', 'ru'];
  const LANG_KEY = 'bd-lang';
  function pickLang() {
    const q = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(q)) return q;
    try { const v = localStorage.getItem(LANG_KEY); if (LANGS.includes(v)) return v; } catch (_) { /* private mode */ }
    return /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';
  }
  let lang = pickLang();
  function t(key, vars) {
    const own = COPY[lang] && COPY[lang][key];
    const str = own !== undefined ? own : COPY.en && COPY.en[key] !== undefined ? COPY.en[key] : key;
    return vars ? str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : str;
  }
  /** `plural(3, 'n.trades')` → '3 trades' / '3 сделки' (forms: .one/.other in English, .one/.few/.many in Russian). */
  function plural(n, key) {
    const a = Math.abs(Math.round(n));
    let form;
    if (lang === 'ru') {
      const m10 = a % 10, m100 = a % 100;
      form = m10 === 1 && m100 !== 11 ? 'one' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'few' : 'many';
    } else form = a === 1 ? 'one' : 'other';
    return t(`${key}.${form}`, { n: F.int(n) });
  }
  function applyStatic() {
    document.documentElement.lang = lang;
    // the title and every description tag follow the language (crawlers read the English ones in the HTML); an empty
    // string in the copy keeps what the HTML says, so a site sets its own title and lead without touching copy.js
    if (t('title')) document.title = t('title');
    if (t('description')) for (const sel of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) { const m = document.querySelector(sel); if (m) m.setAttribute('content', t('description')); }
    if (t('title')) for (const sel of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) { const m = document.querySelector(sel); if (m) m.setAttribute('content', t('title')); }
    for (const el of document.querySelectorAll('[data-i18n]')) { const v = t(el.dataset.i18n); if (v) el.textContent = v; }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split(':').map((x) => x.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
    for (const b of document.querySelectorAll('#lang button[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
  function setLang(l) {
    if (!LANGS.includes(l) || l === lang) return;
    lang = l;
    try { localStorage.setItem(LANG_KEY, l); } catch (_) { /* private mode */ }
    applyStatic();
    HERO.key = '';   // the figure's width may change with the language: the curve is measured again
    renderAll();
    if (S.error) showBanner(errorText());
  }

  /* ---------- formats (dates and durations by language; money and percent from format.js) ---------- */
  const MON = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  };
  const MONTH = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  };
  /** A short month name on its own (a label, not a date): RU "май", where a date says "мая". */
  const monName = (m) => (lang === 'ru' ? MONTH.ru[m].slice(0, 3).toLowerCase() : MON[lang][m]);
  const DOW = { en: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'], ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] };
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const parseDay = (key) => new Date(key + 'T00:00:00Z');
  function dayOf(key) { const d = parseDay(key); return `${d.getUTCDate()} ${MON[lang][d.getUTCMonth()]}`; }
  function timeOf(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${MON[lang][d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function clockOf(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function holdOf(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m} ${t('u.m')}`;
    if (m < 1440) return `${Math.floor(m / 60)} ${t('u.h')} ${pad(m % 60)} ${t('u.m')}`;
    return `${Math.floor(m / 1440)} ${t('u.d')} ${pad(Math.floor((m % 1440) / 60))} ${t('u.h')}`;
  }
  function agoOf(ms) {
    const sec = Math.max(0, Date.now() - ms) / 1000;
    if (sec < 45) return t('ago.now');
    const m = Math.round(sec / 60);
    if (m < 60) return t('ago.m', { n: Math.max(1, m) });
    const hrs = Math.floor(sec / 3600);
    if (hrs < 24) return t('ago.h', { n: hrs });
    return t('ago.d', { n: Math.floor(hrs / 24) });
  }
  const signCls = (v) => (v > 0.005 ? 'gain' : v < -0.005 ? 'loss' : 'zero');
  /** '+$58', '−$204', '+$1.2k': the calendar cells. */
  function moneyShort(v) {
    const a = Math.abs(v);
    if (a < 0.5) return '$0';
    const sign = v < 0 ? MINUS : '+';
    if (a < 1000) return `${sign}$${Math.round(a)}`;
    if (a < 1e6) return `${sign}$${(a / 1000).toFixed(a < 10000 ? 1 : 0)}k`;
    return `${sign}$${(a / 1e6).toFixed(1)}M`;
  }
  /** Axis labels: '$300', '−$100', '$2.5', '$12k'. */
  /** A percent axis label: "+10%", "−2.5%", "0%". */
  function axisPct(v, step) {
    if (Math.abs(v) < 1e-12) return '0%';
    const d = step * 100 < 1 ? 2 : step * 100 < 5 ? 1 : 0;
    return `${v > 0 ? '+' : MINUS}${Math.abs(v * 100).toFixed(d).replace(/\.0+$/, '')}%`;
  }
  /** Time-weighted return from the daily returns against equity: the growth index minus one, and its fall from its own peak. */
  function twrOf(series) {
    let g = 1, peak = 1;
    const cum = [], dd = [];
    for (const p of series) {
      g *= 1 + (p.ret || 0);
      peak = Math.max(peak, g);
      cum.push(g - 1);
      dd.push(g / peak - 1);
    }
    return { cum, dd };
  }
  /**
   * Capital usage per chart point: the margin held in open positions (each trip's size over its leverage) as a share of the
   * day's starting equity, its peak and its time-weighted average over the day (for a week or month: the busiest day and
   * the mean). Null where the trade history does not reach (before tradesFrom): no bar rather than a false zero.
   */
  function capitalUsage(series) {
    const r = S.report, w = win();
    if (!r || !w || !series.length) return null;
    const trips = (r.trips || []).filter((x) => x.entryTime && x.entryNotional > 0);
    if (!trips.length) return null;
    const end = r.generatedAt || Date.now();
    // a trip without its leverage (Bybit's closed ones) takes the coin's setting, else the account's usual one, never 1x by default
    const known = trips.map((x) => x.leverage).filter((v) => v > 0).sort((u, v) => u - v);
    const usual = known.length ? known[Math.floor(known.length / 2)] : 1;
    const levOf = (x) => x.leverage || (r.leverage && r.leverage[x.symbol]) || usual;
    // the money a position ties up: its initial (collateral) margin plus its maintenance margin. The maintenance rate is the
    // account's own, read off the open positions now (maintMargin over their size), 1 % when nothing is open
    const acct = r.account || {};
    const exposure = (r.positions || []).reduce((acc, q) => acc + Math.abs(Number(q.notional) || 0), 0);
    const mmr = exposure > 0 && acct.maintMargin > 0 ? Math.min(0.05, acct.maintMargin / exposure) : 0.01;
    const legs = trips.map((x) => ({ a: x.entryTime, b: x.exitTime || end, m: x.entryNotional * (1 / Math.max(1, levOf(x)) + mmr) }));
    // the day's equity: the larger of its start and its end, so a day that brought a deposit counts that money too
    const eq = new Map(w.series.map((p) => { const start = (p.balance || 0) - (p.net || 0) - (p.transfers || 0); return [p.date, Math.max(start, p.balance || 0)]; }));
    const from = w.tradesFrom || (r.windows.all && r.windows.all.tradesFrom) || series[0].date;
    const fromFills = r.usageDaily && Object.keys(r.usageDaily).length ? r.usageDaily : null;   // the server's replay of the fills, when it has one
    const dayUse = (d) => {
      if (d < from) return null;
      const e = eq.get(d);
      if (!e) return null;
      if (fromFills) {
        const u = fromFills[d];
        return u ? { peak: (u.peakIM + mmr * u.peakN) / e, avg: (u.avgIM + mmr * u.avgN) / e } : null;
      }
      const d0 = Date.parse(d + 'T00:00:00Z'), d1 = Math.min(d0 + 86400000, end);
      if (d1 <= d0) return null;
      const ev = [];
      let run = 0;
      for (const l of legs) {
        if (l.a >= d1 || l.b <= d0) continue;
        if (l.a <= d0) run += l.m; else ev.push([l.a, l.m]);
        if (l.b < d1) ev.push([l.b, -l.m]);
      }
      ev.sort((u, v) => u[0] - v[0] || u[1] - v[1]);
      let peak = run, area = 0, t0 = d0;
      for (const [tt, dm] of ev) { area += run * (tt - t0); t0 = tt; run += dm; peak = Math.max(peak, run); }
      area += run * (d1 - t0);
      return { peak: peak / e, avg: area / (d1 - d0) / e };
    };
    const days = (p) => {
      const a = p.first || p.date, b = p.last || p.date, out = [];
      for (let t2 = Date.parse(a + 'T00:00:00Z'); t2 <= Date.parse(b + 'T00:00:00Z'); t2 += 86400000) out.push(new Date(t2).toISOString().slice(0, 10));
      return out;
    };
    const res = series.map((p) => {
      const us = days(p).map(dayUse).filter(Boolean);
      if (!us.length) return null;
      return { peak: Math.max(...us.map((u) => u.peak)), avg: us.reduce((acc, u) => acc + u.avg, 0) / us.length };
    });
    return res.some(Boolean) ? res : null;
  }
  /** The compounded return of the days a..b (inclusive), from the daily returns. */
  function twrSpan(series, a, b) {
    let g = 1;
    for (let k = a; k <= b; k++) g *= series[k].g !== undefined ? series[k].g : 1 + (series[k].ret || 0);
    return g - 1;
  }
  function axisMoney(v, step) {
    const a = Math.abs(v);
    if (a < 1e-9) return '$0';
    let body;
    if (a >= 10000) body = `${(a / 1000).toFixed(step >= 1000 ? 0 : 1).replace(/\.0$/, '')}k`;
    else body = a.toLocaleString('en-US', { maximumFractionDigits: step >= 1 ? (Number.isInteger(step) ? 0 : 1) : 2 });
    return (v < 0 ? MINUS : '') + '$' + body;
  }

  /* ---------- state and hash ---------- */
  const WINDOWS = ['30d', '60d', 'ytd', 'all'];
  const SOURCES = ['all', 'binance', 'bybit'];
  const PAGE = 1, MORE = 1;   // days of the trades history: today first, one more day per click
  const S = { w: 'all', src: 'all', cmp: '', scale: 'pct', mode: 'cum', filter: 'all', shown: PAGE, report: null, all: null, updatedAt: 0, error: null };
  function readHash() {
    const q = new URLSearchParams(location.hash.replace(/^#/, ''));
    const w = q.get('w'), src = q.get('src');
    S.w = WINDOWS.includes(w) ? w : 'all';
    S.src = SOURCES.includes(src) ? src : 'all';
    const cmp = q.get('cmp');
    S.cmp = cmp && /^[A-Z0-9]{2,8}$/.test(cmp) ? cmp : '';
    S.scale = q.get('sc') === 'usd' ? 'usd' : 'pct';   // percent by default
  }
  function writeHash() {
    const q = new URLSearchParams();
    if (S.w !== 'all') q.set('w', S.w);
    if (S.src !== 'all') q.set('src', S.src);
    if (S.cmp) q.set('cmp', S.cmp);
    if (S.scale === 'usd') q.set('sc', 'usd');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + location.search + (qs ? '#' + qs : ''));
  }
  const win = () => (S.report ? S.report.windows[S.w] || S.report.windows.all : null);
  const configured = (r) => (r && Array.isArray(r.sources) ? r.sources.filter((x) => x.configured) : []);
  const multi = (r) => configured(r).length > 1;
  /** The merged report (the hero and the copy cards always speak for all the exchanges). */
  const merged = () => S.all || (S.report && (!S.report.source || S.report.source === 'all') ? S.report : null);

  /* ---------- report ---------- */
  const REPORT_URL = '/binance-dashboard/report';
  function reportUrl(source) {
    const q = new URLSearchParams(location.search);   // the fixture server's flags (?mock=live, ?fail=502, …) ride along
    q.delete('lang');
    if (source !== 'all') q.set('source', source); else q.delete('source');
    const qs = q.toString();
    return REPORT_URL + (qs ? '?' + qs : '');
  }
  function httpError(status, body) {
    const code = body && typeof body.error === 'string' ? body.error : '';
    if (code === 'binance_dashboard_not_configured') return { key: 'err.config' };
    const wait = body && typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0 ? Math.ceil(body.retryAfterSeconds) : 0;
    return wait ? { key: 'err.wait', vars: { s: wait } } : { key: 'err.http', vars: { status } };
  }
  async function fetchReport(source) {
    let res;
    try { res = await fetch(reportUrl(source), { cache: 'no-store' }); } catch (_) { throw { key: 'err.net' }; }
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) throw httpError(res.status, body);
    if (!body || typeof body.generatedAt !== 'number' || !body.windows || !body.windows.all) throw { key: 'err.bad' };
    return { body, receivedAt: Date.now() };
  }
  async function load() {
    const want = S.src;
    try {
      const { body, receivedAt } = await fetchReport(want);
      if (want !== S.src) return;   // the filter moved on while this slice was in flight; its own request is coming
      if (typeof body.source === 'string' && body.source !== S.src && SOURCES.includes(body.source)) { S.src = body.source; writeHash(); }
      S.error = null;
      hideBanner();
      S.updatedAt = receivedAt - (body.meta && body.meta.cacheAgeMs ? body.meta.cacheAgeMs : 0);
      if (!body.source || body.source === 'all') S.all = body;
      const changed = !S.report || S.report.generatedAt !== body.generatedAt || S.report.source !== body.source;
      S.report = body;
      if (changed) renderAll(); else renderStatus();
      if (S.src !== 'all') loadMerged();
    } catch (e) {
      S.error = e && e.key ? e : { key: 'err.net' };
      showBanner(errorText());
      renderStatus();
    }
  }
  async function loadMerged() {
    try {
      const { body } = await fetchReport('all');
      const changed = !S.all || S.all.generatedAt !== body.generatedAt;
      S.all = body;
      if (changed) { safe(renderHero); safe(renderCopy); }
    } catch (_) { /* the hero keeps what it has */ }
  }
  let pollTimer = 0;
  function schedulePoll() {
    clearInterval(pollTimer);
    const ttl = S.report ? S.report.meta.cacheTtlMs : 60000;
    pollTimer = setInterval(() => { if (!document.hidden) load(); }, ttl + 2000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.report && Date.now() - S.updatedAt > S.report.meta.cacheTtlMs) load();
  });

  /* ---------- status, banner ---------- */
  function errorText() {
    const msg = t(S.error.key, S.error.vars);
    return S.report ? t('err.keep', { msg, time: clockOf(S.updatedAt) }) : msg;
  }
  function showBanner(text) { $('banner-text').textContent = text; $('banner').hidden = false; }
  function hideBanner() { $('banner').hidden = true; }
  function renderStatus() {
    const r = S.report;
    let state, text;
    if (!r && !S.error) { state = 'wait'; text = t('st.wait'); }
    else if (!r) { state = 'err'; text = t('st.errNone'); }
    else if (S.error) { state = 'err'; text = t('st.err', { ago: agoOf(S.updatedAt) }); }
    else if (Date.now() - S.updatedAt > 3 * r.meta.cacheTtlMs) { state = 'stale'; text = t('st.stale', { ago: agoOf(S.updatedAt) }); }
    else { state = 'live'; text = t('st.live', { ago: agoOf(S.updatedAt) }); }
    $('status').className = 'status ' + state;
    $('status').hidden = state === 'live';   // no 'Live · updated' line, only a wait, delay or error shows
    $('status-text').textContent = text;
  }

  /* ---------- coins and exchanges ---------- */
  const QUOTE = /(USDT|USDC|BUSD|FDUSD)$/;
  /** One ticker per coin on every exchange: Bybit's own contract names read as the coin's ticker. */
  const TICKER_ALIAS = { PUMPFUN: 'PUMP' };
  const base = (sym) => {
    const b = String(sym).replace(QUOTE, '').replace(/^([A-Z]+?)(1000+)$/, '$2$1');   // Bybit's SHIB1000 is Binance's 1000SHIB
    return TICKER_ALIAS[b] || b;
  };
  const iconBase = (sym) => base(sym).replace(/^1(0+)(?=[A-Z])/, '');
  const missing = new Set();
  /** The coin's mark from /binance-dashboard/icons/token/<BASE>.svg over its first letter (the letter stays for a coin the pack lacks: 204). */
  function coin(sym) {
    const b = iconBase(sym);
    const el = h('span', { class: 'coin', 'aria-hidden': 'true' }, [h('span', { class: 'fb', text: b.charAt(0) })]);
    if (!/^[A-Z0-9]{1,16}$/.test(b) || missing.has(b)) return el;
    const img = h('img', { src: `/binance-dashboard/icons/token/${b}.svg?v=2`, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => el.classList.add('ok'), { once: true });
    img.addEventListener('error', () => { missing.add(b); img.remove(); }, { once: true });
    el.append(img);
    return el;
  }
  /** The exchange of a row, only in the merged view of a two-exchange report. */
  function exChip(source) {
    const r = S.report;
    if (!source || !r || (r.source && r.source !== 'all') || !multi(r)) return null;
    const x = r.sources.find((q) => q.key === source);
    // the exchange as its colour logo, not a word; the name lives in the tooltip and for screen readers
    const label = x ? x.label : source;
    const mark = h('span', { class: 'ex-logo ' + source, role: 'img', 'aria-label': label });
    mark.innerHTML = EX_MARK[source] || '';   // a static sprite reference, no data in it
    if (!EX_MARK[source]) mark.textContent = label;
    return tip(mark, { h: label });
  }
  /** Money the strategy runs across the exchanges: per exchange the copy-trading assets when they exceed the account's own equity. */
  function trackedCapital(r) {
    const by = r.copyTradingBySource || {};
    const list = (r.sources || []).filter((x) => x.configured && x.ok);
    if (!list.length) return r.account && r.account.marginBalance > 0 ? r.account.marginBalance : null;
    return list.reduce((sum, x) => { const c = by[x.key]; return sum + Math.max(c && c.aum > 0 ? c.aum : 0, x.marginBalance || 0); }, 0);
  }

  /* ---------- hero: the curve on the background, ending in the figure ---------- */
  const HERO = { values: null, key: '', counted: false };
  /** Catmull-Rom through the points as cubic Béziers: a calm line for the background (the chart below stays point to point). */
  function smooth(p) {
    const f = (q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`;
    if (p.length < 3) return 'M' + p.map(f).join('L');
    let d = 'M' + f(p[0]);
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      d += `C${f([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${f([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6])} ${f(p2)}`;
    }
    return d;
  }
  /* ---------- one tooltip for every chart and grid: node._tt = { h, rows: [[label, value, cls]] } or a function of the event ---------- */
  const TT = { el: null };
  const tip = (node, data) => { node._tt = data; if (node.classList) node.classList.add('tt-on'); return node; };
  // an (i) tooltip shifts sideways to stay on the screen: on a phone the icon often sits near the right edge
  const fitInfo = (e) => {
    const i = e.target && e.target.closest && e.target.closest('.info');
    const el = i && i.querySelector('.tip');
    if (!el) return;
    el.style.marginLeft = '0px';
    const r = el.getBoundingClientRect(), W = document.documentElement.clientWidth;
    let dx = 0;
    if (r.right > W - 12) dx = W - 12 - r.right;
    if (r.left + dx < 12) dx = 12 - r.left;
    el.style.marginLeft = `${Math.round(dx)}px`;
  };
  document.addEventListener('pointerover', fitInfo, { passive: true });
  document.addEventListener('focusin', fitInfo);
  function ttMove(e) {
    let n = e.target, d = null;
    while (n && n !== document) { if (n._tt) { d = n._tt; break; } n = n.parentNode; }
    if (typeof d === 'function') d = d(e);
    if (!TT.el) { TT.el = h('div', { class: 'tt', role: 'tooltip' }); TT.el.hidden = true; document.body.append(TT.el); }
    const el = TT.el;
    // the gaps between bars and dots don't blink it: it hides only if the pointer stays off anything for a moment
    if (!d) { if (!TT.hideT && !el.hidden) TT.hideT = setTimeout(() => { el.hidden = true; TT.hideT = 0; }, 140); return; }
    if (TT.hideT) { clearTimeout(TT.hideT); TT.hideT = 0; }
    el.replaceChildren(h('b', { class: 'tt-h', text: d.h }), ...(d.rows || []).filter(Boolean).map(([k, v, cls]) => h('div', { class: 'tt-r' }, [h('span', { text: k }), h('span', { class: 'tab ' + (cls || ''), text: v })])));
    el.hidden = false;
    const r = el.getBoundingClientRect(), pad = 10;
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + r.width > innerWidth - pad) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - pad) y = e.clientY - r.height - 16;
    el.style.left = `${Math.max(pad, x)}px`;
    el.style.top = `${Math.max(pad, y)}px`;
  }
  // the filter bar gets its hairline only once it sticks to the top
  { const bar = $('filter-bar');
    if (bar) { const mark = () => bar.classList.toggle('stuck', bar.getBoundingClientRect().top <= 0.5 && scrollY > 0); addEventListener('scroll', mark, { passive: true }); mark(); } }
  // a mouse shows the tooltip on hover; a finger with a plain tap, and it stays until the next tap or a scroll
  //
  let touchTip = false;
  document.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') ttMove(e); }, { passive: true });
  document.addEventListener('pointerdown', (e) => { touchTip = e.pointerType === 'touch'; if (!touchTip) ttMove(e); }, { passive: true });
  document.addEventListener('click', (e) => {
    if (!touchTip) return;
    ttMove(e);
    // an (i) opens on a tap and closes on the next tap anywhere: iOS doesn't focus a span on a tap
    const i = e.target.closest && e.target.closest('.info');
    for (const o of document.querySelectorAll('.info.open')) if (o !== i) o.classList.remove('open');
    if (i) { i.classList.toggle('open'); fitInfo(e); }
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (e.pointerType !== 'touch' && !e.relatedTarget && TT.el) { clearTimeout(TT.hideT); TT.hideT = 0; TT.el.hidden = true; } });
  addEventListener('scroll', () => { if (TT.el) TT.el.hidden = true; for (const o of document.querySelectorAll('.info.open')) o.classList.remove('open'); }, { passive: true });
  const ttMoney = (v) => [F.money(v), signCls(v)];

  /** A vertical fill that fades from the line to the zero line: one per tone (the Revolut X area). */
  function fade(defs, id, tone, from, to) {
    const g = s('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: from.toFixed(1), y2: to.toFixed(1) }, defs);
    s('stop', { offset: '0', class: 'fs0 ' + tone }, g);
    s('stop', { offset: '1', class: 'fs1 ' + tone }, g);
    return g;
  }
  /** Bar fills, per svg: a body that fades toward the zero line; `up` is strong at the top, `dn` at the bottom. */
  function barFills(defs) {
    for (const [id, tone, y1, y2] of [['bf-up', 'up', 0, 1], ['bf-dn', 'dn', 1, 0]]) {
      const g = s('linearGradient', { id, x1: 0, x2: 0, y1, y2 }, defs);
      s('stop', { offset: '0', class: 'bs0 ' + tone }, g);
      s('stop', { offset: '1', class: 'bs1 ' + tone }, g);
    }
  }
  /** One bar: the body plus a 2 px cap on the top (capTop) or on the bottom edge. */
  function bar(parent, x, y, w, hgt, tone, capTop, cls) {
    const g = s('g', { class: 'bar ' + tone + (cls ? ' ' + cls : '') }, parent);
    s('rect', { class: 'bar-b', x: x.toFixed(1), y: y.toFixed(1), width: w.toFixed(1), height: Math.max(1, hgt).toFixed(1), fill: `url(#bf-${tone})` }, g);
    s('rect', { class: 'bar-c', x: x.toFixed(1), y: (capTop ? y : y + Math.max(1, hgt) - 2).toFixed(1), width: w.toFixed(1), height: 2, rx: 1 }, g);
    return g;
  }
  /** A row of grid dots at the given x positions on one value line; all one size, the zero row a touch brighter. */
  function gridDots(el, xs, y, zero) {
    const g = s('g', { class: 'gd' + (zero ? ' z' : '') }, el);
    for (const x of xs) s('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 1.25 }, g);
    return g;
  }
  /** A percent with its decimals a size smaller: "+7" and ".1%". */
  function setPct(el, v) {
    const str = F.pct(v), m = /^(.*?)([.,]\d+%)$/.exec(str);
    if (!m) { el.textContent = str; return; }
    el.replaceChildren(m[1], h('span', { class: 'dec', text: m[2] }));
  }
  /** A money figure with its cents a size smaller, like 3,344.96 on Revolut X. */
  function setMoney(el, v) {
    const str = F.money(v), m = /^(.*?)([.,]\d+)(\D*)$/.exec(str);
    if (!m) { el.textContent = str; return; }
    el.replaceChildren(m[1], h('span', { class: 'dec', text: m[2] }), m[3]);
  }
  function drawHero(animate) {
    const svgEl = $('hero-curve'), sec = $('hero'), num = $('hero-net');
    const vals = HERO.values;
    if (!svgEl || !vals || vals.length < 2) { clear(svgEl); HERO.key = ''; return; }
    const hr = sec.getBoundingClientRect(), nr = num.getBoundingClientRect();
    const W = Math.round(hr.width), H = Math.round(hr.height);
    // desktop: the line ends just left of the figure, on its centre line; a phone has no room beside the figure, so the line runs
    // across the full width in the band above it and ends over the figure's right edge
    const nar = narrow(), fr = sec.querySelector('.hero-fig').getBoundingClientRect();
    const endX = Math.round(nar ? nr.right - hr.left - 6 : fr.left - hr.left - 20);   // desktop: at the card's edge, on the figure's line
    const endY = Math.round(nar ? fr.top - hr.top - 18 : nr.bottom - hr.top + 18);   // desktop: the line the figure stands on
    const key = [W, H, endX, endY, vals.join(',')].join('|');
    if (!animate && key === HERO.key) return;
    HERO.key = key;
    clear(svgEl);
    svgEl.classList.remove('in');
    if (W < 50 || H < 50 || nr.width < 1 || endX < 90) return;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const last = vals[vals.length - 1], hi = Math.max(...vals), lo = Math.min(...vals);
    // the last value lands on the figure's centre line; the scale is the largest that keeps the whole curve inside its band
    const yTop = nar ? Math.max(12, endY - 110) : Math.max(44, endY - 260);   // the curve stays near the figure on a tall screen
    const yBottom = nar ? endY + 12 : Math.min($('band').getBoundingClientRect().top - hr.top - 28, endY + 200);
    let k = Infinity;
    if (hi - last > 1e-9) k = Math.min(k, (endY - yTop) / (hi - last));
    if (last - lo > 1e-9) k = Math.min(k, (yBottom - endY) / (last - lo));
    if (!isFinite(k) || k < 0) k = 0;
    const X = (i) => (i / (vals.length - 1)) * endX;
    const Y = (v) => endY - (v - last) * k;
    const d = smooth(vals.map((v, i) => [X(i), Y(v)]));
    const line = s('path', { class: 'line', d }, svgEl);
    if (!nar) s('line', { class: 'rule', x1: endX + 14, x2: Math.round(num.parentElement.getBoundingClientRect().right - hr.left), y1: endY, y2: endY }, svgEl);   // the curve runs on as a price line under the figure
    s('circle', { class: 'halo', cx: endX, cy: endY, r: 11 }, svgEl);
    s('circle', { class: 'end', cx: endX, cy: endY, r: 4.5 }, svgEl);
    if (animate && !reduced() && line.getTotalLength) {
      const len = line.getTotalLength();
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = String(len);
      line.getBoundingClientRect();
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 1.3s cubic-bezier(.3,.7,.2,1)';
        line.style.strokeDashoffset = '0';
        svgEl.classList.add('in');
      });
    } else svgEl.classList.add('in');
  }
  /** Traded volume by exchange: entry plus exit notional of the trades in the report, one bar of shares. */
  const EX_MARK = { binance: '<svg aria-hidden="true" focusable="false"><use href="#i-binance"/></svg>', bybit: '<svg viewBox="2.6 8.7 18.8 6.6" aria-hidden="true" focusable="false"><use href="#i-bybit" width="24" height="24"/></svg>' };
  function renderVolume(r) {
    const box = $('hero-vol');
    const by = {};
    for (const x of r.trips || []) { const k = x.source || 'binance'; by[k] = (by[k] || 0) + (x.entryNotional || 0) + (x.exitNotional || 0); }
    const list = configured(r).map((q) => ({ key: q.key, label: q.label, v: by[q.key] || 0 })).filter((q) => q.v > 0);
    const total = list.reduce((a, q) => a + q.v, 0);
    if (!total) { box.hidden = true; return; }
    box.hidden = false;
    const bar = h('div', { class: 'vol-bar' }), legend = h('div', { class: 'vol-legend' });
    for (const q of list) {
      const seg = h('i', { class: q.key });
      seg.style.flexGrow = String(q.v / total);
      tip(seg, { h: q.label, rows: [[t('tt.vol'), F.usd0(q.v)], [t('tt.share'), F.pct(q.v / total, { sign: false })]] });
      bar.append(seg);
      const mark = h('span', { class: 'vol-mark ' + q.key });
      mark.innerHTML = EX_MARK[q.key] || '';   // a static sprite reference, no data in it
      legend.append(h('span', { class: 'vol-item' }, [mark, h('b', { text: q.label }), h('span', { class: 'tab', text: `${F.usd(q.v)} · ${F.pct(q.v / total, { sign: false })}` })]));
    }
    const days = r.meta && r.meta.tradesLookbackDays ? Math.min(r.meta.tradesLookbackDays, r.windows.all.days) : r.windows.all.days;
    const big = h('b', { class: 'kp-v tab', text: F.usd(total) });
    big._to = total; big._fmt = F.usd;
    const split = h('span', { class: 'kp-s tab' });
    list.forEach((q, i) => {   // each exchange as its logo with its share
      const mark = h('span', { class: 'ex-logo sm ' + q.key, role: 'img', 'aria-label': q.label });
      mark.innerHTML = EX_MARK[q.key] || '';
      split.append(...(i ? [' · '] : []), mark, ` ${list.length === 1 ? q.label : F.pct(q.v / total, { sign: false })}`);
    });
    box.replaceChildren(h('span', { class: 'kp-l', text: t('vol.h', { days: plural(days, 'n.cal') }) }), big, split);   // the split by exchange has its own widget below
    BAND.bar = null;
  }
  /* the key-figure band: final text first (a hidden tab or no motion shows the truth), the count-up runs once on view */
  /* the key figures at the foot of the hero: once, on the first paint, each rises in turn, its rule draws,
     its number counts up and the volume bar fills; a tab that never paints keeps the final text it already holds */
  const BAND = { bar: null, played: false };
  function bandFig(id, v, fmt) {
    const el = $(id).querySelector('.kp-v');
    el._to = v; el._fmt = fmt;
    el.textContent = fmt(v);
  }
  function bandApply(p) {
    const tiles = [...$('band').querySelectorAll('.kp:not([hidden])')];
    const ease = (q) => 1 - Math.pow(1 - q, 3);
    tiles.forEach((el, i) => {
      const e = ease(Math.max(0, Math.min(1, (p - i * 0.1) / 0.6)));
      el.style.opacity = String(0.05 + 0.95 * e);
      el.style.transform = e >= 1 ? '' : `translate3d(0,${((1 - e) * 24).toFixed(1)}px,0)`;
      el.style.setProperty('--k', e.toFixed(3));
      const v = el.querySelector('.kp-v');
      if (v && typeof v._to === 'number') v.textContent = v._fmt(e >= 1 ? v._to : v._to * e);
      if (BAND.bar && el.contains(BAND.bar)) BAND.bar.style.clipPath = e >= 1 ? '' : `inset(0 ${((1 - e) * 100).toFixed(1)}% 0 0 round 9999px)`;
    });
  }
  function bandPlay() {
    if (BAND.played || reduced()) return;
    BAND.played = true;
    let t0 = 0;
    const step = (now) => {
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / 1700);
      bandApply(p);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  /** The figure counts up once, on the first paint (it already holds its final text, so a hidden tab shows the right number). */
  function countUp(el, to, put = setMoney) {
    if (reduced()) return;
    const t0 = performance.now(), dur = 1200;
    const step = (now) => {
      const k = Math.max(0, Math.min(1, (now - t0) / dur)), e = 1 - Math.pow(1 - k, 3);
      put(el, to * e);
      if (k < 1) requestAnimationFrame(step); else put(el, to);
    };
    requestAnimationFrame(step);
  }
  function renderHero() {
    const r = merged();
    if (!r) return;
    const w = r.windows.all;
    const net = w.pnl.net;
    // the return leads, the dollars follow, and the label names the period
    const el = $('hero-net'), side = $('hero-pct');
    const hasRet = w.mwr !== null && w.mwr !== undefined;
    const lead = hasRet ? w.mwr : net;
    const put = hasRet ? (node, v) => { node.textContent = F.pct(v); } : setMoney;   // one size for the percent, no smaller decimals
    el.className = 'fig-value tab ' + signCls(lead);
    put(el, lead);
    side.textContent = hasRet ? F.money(net).replace(/^[+\u2212-]/, '') : '';   // the sign once: the percent carries it
    side.className = 'fig-pct tab ' + signCls(net);
    $('fig-label').textContent = hasRet ? t('fig.ret', { d: plural(w.days || 1, 'n.cal') }) : t('fig.label');
    // the key figures sit in a band under the hero and count up when it comes into view
    const cap = trackedCapital(r);
    bandFig('kp-days', w.daily ? w.daily.active : w.days, F.int);
    bandFig('kp-trades', w.trades.n, F.int);
    $('kp-cap').hidden = !cap;
    if (cap) bandFig('kp-cap', cap, F.usd0);
    const sub = (id, kids) => $(id).querySelector('.kp-s').replaceChildren(...kids);
    const dl = w.daily || {};
    if (typeof dl.green === 'number') sub('kp-days', [h('b', { text: F.int(dl.green) }), ` ${t('kp.green')} · `, h('b', { text: F.int(dl.red) }), ` ${t('kp.red')}`]);
    sub('kp-trades', [h('b', { text: F.int(w.trades.wins || 0) }), ` ${t('kp.won')} · `, h('b', { text: F.int(w.trades.losses || 0) }), ` ${t('kp.lost')}`]);
    if (cap) sub('kp-cap', configured(r).flatMap((q, i) => {   // the exchanges as their logos
      const mark = h('span', { class: 'ex-logo sm ' + q.key, role: 'img', 'aria-label': q.label });
      mark.innerHTML = EX_MARK[q.key] || '';
      if (!EX_MARK[q.key]) mark.textContent = q.label;
      return i ? [' + ', mark] : [mark];
    }));
    safe(() => renderVolume(r));
    bandPlay();
    const c = r.copyTrading;
    $('hero-badge').textContent = c && typeof c.copiers === 'number' ? `${t('badge.live')} · ${plural(c.copiers, 'n.copying')}` : t('badge.live');
    const first = !HERO.counted;
    HERO.values = w.series.map((p) => p.cum);
    drawHero(first);
    if (first) { HERO.counted = true; countUp(el, lead, put); }
  }

  /* ---------- results: filters, chart, key figures ---------- */
  function syncFilters(r) {
    for (const b of document.querySelectorAll('#seg-window button')) b.setAttribute('aria-pressed', String(b.dataset.w === S.w));
    const seg = $('seg-source');
    $('dd-source').hidden = !multi(r);
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.src === S.src));
      const x = r && Array.isArray(r.sources) ? r.sources.find((q) => q.key === b.dataset.src) : null;
      b.disabled = !!x && (!x.configured || !x.ok);
    }
    // the dropdowns show the chosen option
    for (const dd of document.querySelectorAll('.filters div.dd')) {   // only the filter bar's: the others label themselves
      const on = dd.querySelector('.seg button[aria-pressed="true"]');
      const l = dd.querySelector('.dd-l');
      if (on) l.replaceChildren(...[...on.childNodes].map((n) => n.cloneNode(true))); else l.textContent = '';
    }
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function ticksOf(n, plotW) {
    if (n <= 1) return [0];
    const max = Math.max(2, Math.floor(plotW / 82));
    const stride = Math.max(1, Math.ceil((n - 1) / (max - 1)));
    const out = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    const lastIdx = n - 1;
    if (out[out.length - 1] !== lastIdx) {
      if (lastIdx - out[out.length - 1] < stride * 0.6 && out.length > 1) out.pop();
      out.push(lastIdx);
    }
    return out;
  }
  const CH = { n: 0, width: 0 };
  /** By period: the window's days summed into weeks (Monday first) or calendar months; days stay as they are. */
  let gran = 'day';
  function periodSeries(w) {
    if (S.mode !== 'daily' || gran === 'day') return w.series;
    const out = [];
    for (const p of w.series) {
      const d = parseDay(p.date);
      // quarter and year too
      const key = gran === 'week' ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
        : gran === 'quarter' ? `${p.date.slice(0, 4)}-Q${Math.floor((d.getUTCMonth()) / 3) + 1}`
        : gran === 'year' ? p.date.slice(0, 4) : p.date.slice(0, 7);
      let b = out[out.length - 1];
      if (!b || b.key !== key) {
        b = { key, date: p.date, net: 0, cum: p.cum, dd: p.dd, first: p.date, g: 1, bal0: (p.balance || 0) - (p.net || 0) - (p.transfers || 0) };
        out.push(b);
      }
      b.net += p.net;
      b.g *= 1 + (p.ret || 0);
      b.cum = p.cum;
      b.last = p.date;
    }
    for (const b of out) {
      if (gran === 'week') { b.tick = dayOf(b.first); b.label = b.first === b.last ? dayOf(b.first) : `${dayOf(b.first)}–${dayOf(b.last)}`; }
      else if (gran === 'quarter') { const [yy, q] = b.key.split('-Q'); b.tick = `Q${q} ${yy}`; b.label = `Q${q} ${yy}`; }
      else if (gran === 'year') { b.tick = b.key; b.label = b.key; }
      else { const [yy, mm] = b.key.split('-').map(Number); b.tick = monName(mm - 1); b.label = `${MONTH[lang][mm - 1]} ${yy}`; }
    }
    return out;
  }
  function drawChart(w) {
    const box = $('chart'), el = $('chart-svg');
    clear(el);
    const series = w ? periodSeries(w) : [];
    const n = series.length;
    const W = Math.max(260, Math.round(box.clientWidth || 640));
    const useMode = S.mode === 'use';   // Capital usage: its own mode, a blue area line
    const usage = useMode ? capitalUsage(series) : null;
    const BAND = 0;
    const H = narrow() ? 230 : 300;
    CH.width = W;
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.setAttribute('width', String(W));
    el.setAttribute('height', String(H));
    $('chart-empty').hidden = n > 0;
    el.classList.toggle('use-mode', S.mode === 'use');
    CH.n = 0;
    if (!n) return;
    const daily = S.mode === 'daily';
    const ddMode = S.mode === 'dd';
    const pct = S.scale === 'pct' || useMode;
    const tw = pct && !daily && !useMode ? twrOf(series) : null;   // time-weighted: deposits and withdrawals do not move it
    const vals = useMode ? series.map((p, i) => (usage && usage[i] ? usage[i].peak : 0)) : series.map((p, i) => (daily ? (pct ? (p.g !== undefined ? p.g - 1 : p.ret || 0) : p.net) : ddMode ? (tw ? tw.dd[i] : p.dd) : (tw ? tw.cum[i] : p.cum)));
    // in Capital usage the second line is the day's average under its peak
    const bm = useMode ? null : daily ? periodBench(series, pct) : benchSeries(series, ddMode, pct);   // Capital usage is one line: the day's peak   // the compare line, on the same scale
    const PAD = narrow() ? 18 : 24, L = 0, R = PAD + 52, T = 16, B = 34 + BAND;   // the plot runs from the card's left edge; a value axis on the right
    const span = bm ? vals.concat(bm.vals) : vals;
    let lo = Math.min(0, ...span), hi = Math.max(0, ...span);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step + 1e-9) * step;
    hi = Math.ceil(hi / step - 1e-9) * step;
    const plotW = W - L - R, plotH = H - T - B;
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * plotH;
    const band = plotW / n;
    const inset = daily ? 0 : 10;   // the line's ends sit a little inside so the end dot is whole
    const x = daily ? (i) => L + (i + 0.5) * band : (i) => (n === 1 ? L + plotW / 2 : L + inset + (i / (n - 1)) * (plotW - 2 * inset));
    const zeroY = y(0);
    const defs = s('defs', null, el);
    const ticks = ticksOf(n, plotW);
    // no grid lines: a small grey dot where each value step meets each date tick
    for (let k = 0, steps = Math.round((hi - lo) / step); k <= steps; k++) {
      let v = lo + k * step;
      if (Math.abs(v) < step * 1e-6) v = 0;
      const yy = y(v);
      gridDots(el, ticks.map((i) => x(i)), yy, v === 0);
      s('text', { class: 'ax', x: W - PAD, y: yy + 4, 'text-anchor': 'end' }, el).textContent = useMode ? `${+(v * 100).toFixed(step * 100 < 1 ? 1 : 0)}%` : pct ? axisPct(v, step) : axisMoney(v, step);
    }
    CH.rband = s('rect', { class: 'ruler-band', x: 0, y: T, width: 0, height: H - B - T, visibility: 'hidden' }, el);
    let lastRight = -Infinity;
    ticks.forEach((i) => {
      const xx = x(i), a = xx < PAD + 30 ? 'start' : xx > W - R - 30 ? 'end' : 'middle';
      const tx = s('text', { class: 'ax', x: a === 'start' ? PAD : a === 'end' ? W - R : xx, y: H - 10, 'text-anchor': a }, el);
      tx.textContent = (series[i].tick || dayOf(series[i].date));
      const bb = tx.getBBox ? tx.getBBox() : null;
      if (bb && bb.width && bb.x < lastRight + 14) { tx.remove(); return; }   // no two labels touch
      if (bb && bb.width) lastRight = bb.x + bb.width;
    });
    CH.bars = null;
    if (daily) {
      // with a compare coin each period gets a pair: the account's bar and the coin's beside it
      const pair = !!bm, bw = pair ? Math.max(2, Math.min(16, band * 0.34)) : Math.max(2, Math.min(24, band * 0.6)), gap = pair ? Math.max(1, Math.min(4, band * 0.06)) : 0;
      const ax = (i) => (pair ? x(i) - gap / 2 - bw : x(i) - bw / 2);
      barFills(defs);
      CH.bars = series.map((p, i) => {
        const v = vals[i], flat = Math.abs(v) < (pct ? 0.00005 : 0.005);   // the bar follows the scale: dollars or the period's return
        const top = y(Math.max(0, v)), bottom = y(Math.min(0, v));
        return bar(el, ax(i), flat ? zeroY - 1 : top, bw, flat ? 2 : bottom - top, v >= 0 ? 'up' : 'dn', v >= 0);
      });
      if (pair) bm.vals.forEach((v, i) => {
        const top = y(Math.max(0, v)), hgt = Math.max(2, Math.abs(y(v) - zeroY)), x0 = x(i) + gap / 2;
        const g = s('g', { class: 'bench-bar' }, el);
        s('rect', { class: 'bb-body', x: x0.toFixed(1), y: (v >= 0 ? top : zeroY).toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1) }, g);
        s('rect', { class: 'bb-cap', x: x0.toFixed(1), y: (v >= 0 ? top : zeroY + hgt - 2).toFixed(1), width: bw.toFixed(1), height: 2, rx: 1 }, g);
      });
    } else {
      const pts = vals.map((v, i) => [x(i), y(v)]);
      const line = smooth(pts);
      const area = `${line}L${x(n - 1).toFixed(1)},${zeroY.toFixed(1)}L${x(0).toFixed(1)},${zeroY.toFixed(1)}Z`;
      fade(defs, 'ch-fu', 'up', Math.min(zeroY, ...pts.map((q) => q[1])), zeroY);
      fade(defs, 'ch-fd', 'dn', Math.max(zeroY, ...pts.map((q) => q[1])), zeroY);
      s('rect', { x: 0, y: 0, width: W, height: Math.max(0, zeroY) }, s('clipPath', { id: 'ch-up' }, defs));
      s('rect', { x: 0, y: zeroY, width: W, height: Math.max(0, H - zeroY) }, s('clipPath', { id: 'ch-dn' }, defs));
      s('path', { class: 'area', d: area, fill: 'url(#ch-fu)', 'clip-path': 'url(#ch-up)' }, el);
      s('path', { class: 'area', d: area, fill: 'url(#ch-fd)', 'clip-path': 'url(#ch-dn)' }, el);
      if (bm) {   // the benchmark under the strategy's own line, its ticker at the end
        const bl = s('path', { class: 'bench', d: smooth(bm.vals.map((v, i) => [x(i), y(v)])) }, el);
        bl.setAttribute('aria-hidden', 'true');
        const bx = x(n - 1), by = y(bm.vals[n - 1]);
        s('circle', { class: 'bench-end', cx: bx, cy: by, r: 3 }, el);
        s('text', { class: 'bench-t', x: bx - 8, y: by + (by > y(vals[n - 1]) ? 14 : -8), 'text-anchor': 'end' }, el).textContent = bm.key;
      }
      s('path', { class: 'line up', d: line, 'clip-path': 'url(#ch-up)' }, el);
      s('path', { class: 'line dn', d: line, 'clip-path': 'url(#ch-dn)' }, el);
      const lv = vals[n - 1], tone = lv >= 0 ? 'up' : 'dn';
      s('circle', { class: 'halo ' + tone, cx: x(n - 1), cy: y(lv), r: 9 }, el);
      s('circle', { class: 'end ' + tone, cx: x(n - 1), cy: y(lv), r: 4 }, el);
      el.classList.toggle('dd', ddMode);
    }
    // the scale: the top and the bottom value in quiet pills on the right edge, zero in a pill on the left
    CH.ubars = null;
    CH.guide = s('line', { class: 'guide', x1: 0, x2: 0, y1: T, y2: H - B, visibility: 'hidden' }, el);
    CH.dot = daily ? null : s('circle', { class: 'dot up', r: 5.5, cx: 0, cy: 0, visibility: 'hidden' }, el);
    CH.redge = [0, 1].map(() => s('line', { class: 'ruler-edge', x1: 0, x2: 0, y1: T, y2: H - B, visibility: 'hidden' }, el));
    CH.rdot = [0, 1].map(() => s('circle', { class: 'ruler-dot', r: 4, cx: 0, cy: 0, visibility: 'hidden' }, el));
    s('rect', { class: 'hit', x: 0, y: 0, width: W, height: H }, el);   // no tooltip here: the ruler replaces it
    Object.assign(CH, { n, W, H, L, R, T, B, plotW, band, x, y, vals, series, daily, el, ddMode: ddMode || useMode, useMode, pct, bench: bm, usage, rulerOn: false });
  }
  function readout(p, i) {
    if (S.mode === 'use' && p && i !== undefined) {
      const u = CH.usage ? CH.usage[i] : null;
      $('readout').replaceChildren(h('b', { text: p.label || dayOf(p.date) }), ' · ', u ? h('span', { text: t('ro.useP', { p: F.pct(u.peak, { sign: false }) }) }) : t('ro.useNone'));
      return;
    }
    readoutBase(p, i);
  }
  function readoutBase(p, i) {
    const el = $('readout');
    const bv = p && CH.bench && i !== undefined ? CH.bench.vals[i] : null;
    const fv = (v) => (CH.pct ? F.pct(v) : F.money(v));
    const bench = bv === null || bv === undefined ? [] : [` · ${CH.bench.key} `, h('span', { class: signCls(bv), text: fv(bv) })];
    if (!p) { el.textContent = ' '; return; }
    if (CH.pct && i !== undefined) {   // percent: the day's (or period's) return and the running return, or the fall from the peak
      const v = CH.vals[i], lab = h('b', { text: p.label || dayOf(p.date) });
      if (S.mode === 'dd') el.replaceChildren(lab, ' · ', h('span', { class: signCls(v), text: F.pct(v) }), ` ${t('ro.dd')}`, ...bench);
      else if (S.mode === 'daily') el.replaceChildren(lab, ` · ${t(p.label ? 'ro.period' : 'ro.day')} `, h('span', { class: signCls(v), text: F.pct(v) }), ...bench);
      else el.replaceChildren(lab, ` · ${t('ro.day')} `, h('span', { class: signCls(p.ret || 0), text: F.pct(p.ret || 0) }), ` · ${t('ro.total')} `, h('span', { class: signCls(v), text: F.pct(v) }), ...bench);
      return;
    }
    if (S.mode === 'dd') {
      el.replaceChildren(h('b', { text: p.label || dayOf(p.date) }), ' · ', h('span', { class: signCls(p.dd), text: F.money(p.dd) }), ` ${t('ro.dd')}`, ...bench);
      return;
    }
    el.replaceChildren(
      h('b', { text: p.label || dayOf(p.date) }), ` · ${t(p.label ? 'ro.period' : 'ro.day')} `, h('span', { class: signCls(p.net), text: F.money(p.net) }),
      ` · ${t('ro.total')} `, h('span', { class: signCls(p.cum), text: F.money(p.cum) }), ...bench,
    );
  }
  /* ---------- the ruler: press and drag, or touch with two fingers, to measure a stretch ---------- */
  function rulerShow(a, b) {
    if (!CH.n || a < 0 || b < 0) return;
    if (a > b) [a, b] = [b, a];
    CH.rulerOn = true;
    CH.guide.setAttribute('visibility', 'hidden');
    if (CH.dot) CH.dot.setAttribute('visibility', 'hidden');
    const half = CH.daily ? CH.band / 2 : 0;
    const x0 = CH.x(a) - half, x1 = CH.x(b) + half;
    // the stretch's change: dollars add up, percent compounds (a drawdown's change is in points)
    const delta = CH.pct
      ? (CH.daily ? twrSpan(CH.series, a, b) : CH.ddMode ? CH.vals[b] - CH.vals[a] : (1 + CH.vals[b]) / (1 + CH.vals[a]) - 1)
      : (CH.daily ? CH.vals.slice(a, b + 1).reduce((acc, v) => acc + v, 0) : CH.vals[b] - CH.vals[a]);
    const tone = delta >= 0 ? 'up' : 'dn';
    CH.rband.setAttribute('x', x0.toFixed(1));
    CH.rband.setAttribute('width', Math.max(1, x1 - x0).toFixed(1));
    CH.rband.setAttribute('class', 'ruler-band ' + tone);
    CH.rband.setAttribute('visibility', 'visible');
    [x0, x1].forEach((xx, k) => {
      const e = CH.redge[k];
      e.setAttribute('x1', xx.toFixed(1));
      e.setAttribute('x2', xx.toFixed(1));
      e.setAttribute('visibility', a === b && k ? 'hidden' : 'visible');
    });
    [a, b].forEach((i, k) => {
      const d = CH.rdot[k];
      if (CH.daily) { d.setAttribute('visibility', 'hidden'); return; }
      d.setAttribute('cx', CH.x(i).toFixed(1));
      d.setAttribute('cy', CH.y(CH.vals[i]).toFixed(1));
      d.setAttribute('class', 'ruler-dot ' + tone);
      d.setAttribute('visibility', 'visible');
    });
    if (CH.bars) { CH.bars.forEach((g, k) => g.classList.toggle('on', k >= a && k <= b)); CH.el.classList.add('hov'); }
    const pa = CH.series[a], pb = CH.series[b];
    const from = Date.parse((pa.first || pa.date) + 'T00:00:00Z'), to = Date.parse((pb.last || pb.date) + 'T00:00:00Z');
    const days = Math.round((to - from) / 86400000) + (CH.daily ? 1 : 0);
    const twrPart = CH.daily ? twrSpan(CH.series, a, b) : twrSpan(CH.series, Math.min(b, a + 1), b);   // the same stretch, time-weighted
    const lab = (p) => p.label || dayOf(p.date);
    const parts = [h('b', { text: a === b ? lab(pa) : `${lab(pa)} → ${lab(pb)}` })];
    if (a !== b || CH.daily) parts.push(` · ${plural(Math.max(1, days), 'n.cal')} · `, h('span', { class: signCls(delta), text: CH.pct ? F.pct(delta) : F.money(delta) }), CH.pct || CH.ddMode ? '' : ` (${F.pct(twrPart)})`);
    if (CH.bench && !CH.daily && a !== b) {
      const bd = CH.pct && !CH.ddMode ? (1 + CH.bench.vals[b]) / (1 + CH.bench.vals[a]) - 1 : CH.bench.vals[b] - CH.bench.vals[a];
      parts.push(` · ${CH.bench.key} `, h('span', { class: signCls(bd), text: CH.pct ? F.pct(bd) : F.money(bd) }));
    }
    $('readout').replaceChildren(...parts);
  }
  function rulerClear() {
    if (!CH.n || !CH.rulerOn) return;
    CH.rulerOn = false;
    CH.rband.setAttribute('visibility', 'hidden');
    for (const e of CH.redge.concat(CH.rdot)) e.setAttribute('visibility', 'hidden');
    if (CH.bars) { for (const g of CH.bars) g.classList.remove('on'); CH.el.classList.remove('hov'); }
  }
  /* ---------- benchmarks: the same net deposits held in a large coin, from the day before the window opens ---------- */
  const BM = { data: null, loading: false, tried: false };
  function closeFinder(series) {
    const keys = Object.keys(series.daily).sort();
    return (d) => {   // the last close on or before the day
      let lo = 0, hi = keys.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans < 0 ? null : series.daily[keys[ans]];
    };
  }
  const dayBefore = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  /**
   * The compare line. Percent: the coin's price return from the close before the window (and its fall from its peak).
   * Dollars: a shadow account with the strategy's own money flows - the equity at the window's start buys the coin,
   * every day's deposits buy more at that day's close and withdrawals sell; its result is value minus money put in.
   */
  function benchSeries(series, dd, pct) {
    if (!S.cmp || !BM.data || !series.length) return null;
    const c = BM.data.coins.find((x) => x.key === S.cmp);
    if (!c) return null;
    const close = closeFinder(c);
    const c0 = close(dayBefore(series[0].date)) || close(series[0].date);
    if (!c0) return null;
    let vals;
    if (pct) {
      let peak = c0;
      vals = series.map((p) => { const v = close(p.date) || c0; peak = Math.max(peak, v); return dd ? v / peak - 1 : v / c0 - 1; });
    } else {
      const s0 = series[0];
      const e0 = Math.max(0, (s0.balance || 0) - (s0.net || 0) - (s0.transfers || 0));   // the equity before the window's first day
      let units = e0 / c0, invested = e0, peak = 0;
      vals = series.map((p) => {
        const v = close(p.date) || c0, flow = p.transfers || 0;
        units += flow / v;
        invested += flow;
        const pnl = units * v - invested;
        peak = Math.max(peak, pnl);
        return dd ? pnl - peak : pnl;
      });
    }
    return { key: c.key, name: c.name, vals };
  }
  /** The coin's return over the window, for the picker. */
  /**
   * The compare coin per bar of By period: its return over the same day, week, month, quarter or year;
   * in dollars, that return on the equity the period started with.
   */
  function periodBench(series, pct) {
    if (!S.cmp || !BM.data || !series.length) return null;
    const c = BM.data.coins.find((x) => x.key === S.cmp);
    if (!c) return null;
    const close = closeFinder(c);
    const vals = series.map((p) => {
      const c0 = close(dayBefore(p.first || p.date)), c1 = close(p.last || p.date);
      if (!c0 || !c1) return 0;
      const r = c1 / c0 - 1;
      return pct ? r : r * Math.max(0, p.bal0 !== undefined ? p.bal0 : (p.balance || 0) - (p.net || 0) - (p.transfers || 0));
    });
    return { key: c.key, name: c.name, vals };
  }
  function benchReturn(c, w) {
    const close = closeFinder(c);
    const c0 = close(dayBefore(w.from)) || close(w.from), c1 = close(w.to);
    return c0 && c1 ? c1 / c0 - 1 : null;
  }
  async function loadBench() {
    if (BM.data || BM.loading || BM.tried) return;
    BM.loading = true;
    try {
      const res = await fetch('/binance-dashboard/benchmarks', { headers: { accept: 'application/json' } });
      if (res.ok) { const j = await res.json(); if (j && Array.isArray(j.coins) && j.coins.length) BM.data = j; }
    } catch (_) { /* no compare offered */ } finally { BM.loading = false; BM.tried = true; }
    renderCmp();
    if (S.cmp && BM.data) safe(renderResults);
    safe(renderRisk);   // beta and the Bitcoin marks need the closes
  }
  function renderCmp() {
    const box = $('cmp'), w = win();
    if (!box) return;
    box.hidden = !BM.data;
    if (!BM.data) return;
    if (S.cmp && !BM.data.coins.some((c) => c.key === S.cmp)) S.cmp = '';
    $('cmp-label').textContent = S.cmp ? t('cmp.vs', { k: S.cmp }) : t('cmp.btn');
    $('cmp-btn').classList.toggle('on', !!S.cmp);
    const opts = [h('p', { class: 'cmp-h', text: t('cmp.h') })];
    if (S.cmp) opts.push(h('button', { type: 'button', class: 'cmp-opt none', 'data-k': '', role: 'option', 'aria-selected': 'false' }, [h('span', { class: 'cmp-n', text: t('cmp.none') })]));
    for (const c of BM.data.coins) {
      const ret = w ? benchReturn(c, w) : null;
      opts.push(h('button', { type: 'button', class: 'cmp-opt', 'data-k': c.key, role: 'option', 'aria-selected': String(c.key === S.cmp) }, [
        coin(c.key + 'USDT'),
        h('span', { class: 'cmp-n' }, [h('b', { text: c.name }), h('small', { text: c.key })]),
        h('span', { class: 'cmp-r tab ' + (ret === null ? '' : signCls(ret)), text: ret === null ? '—' : F.pct(ret) }),
      ]));
    }
    $('cmp-menu').replaceChildren(...opts);
  }
  function cmpOpen(open) {
    const menu = $('cmp-menu');
    if (!menu) return;
    menu.hidden = !open;
    $('cmp-btn').setAttribute('aria-expanded', String(open));
    if (open) renderCmp();
  }
  function chartIndex(e) {
    if (!CH.n) return -1;
    const rect = CH.el.getBoundingClientRect();
    if (!rect.width) return -1;
    const px = (e.clientX - rect.left) * (CH.W / rect.width);
    const i = CH.daily ? Math.floor((px - CH.L) / CH.band) : Math.round(((px - CH.L) / CH.plotW) * (CH.n - 1));
    return Math.max(0, Math.min(CH.n - 1, i));
  }
  function focusDay(i) {
    if (!CH.n || i < 0) return;
    const xx = CH.x(i);
    CH.guide.setAttribute('x1', xx);
    CH.guide.setAttribute('x2', xx);
    CH.guide.setAttribute('visibility', 'visible');
    if (CH.dot) {
      CH.dot.setAttribute('cx', xx);
      CH.dot.setAttribute('cy', CH.y(CH.vals[i]));
      CH.dot.setAttribute('class', 'dot ' + (CH.vals[i] >= 0 ? 'up' : 'dn'));
      CH.dot.setAttribute('visibility', 'visible');
    }
    if (CH.bars) { CH.bars.forEach((b, k) => b.classList.toggle('on', k === i)); CH.el.classList.add('hov'); }
    if (CH.ubars) CH.ubars.forEach((b, k) => b && b.classList.toggle('on', k === i));
    readout(CH.series[i], i);
  }
  function blurDay() {
    if (!CH.n) return;
    CH.guide.setAttribute('visibility', 'hidden');
    if (CH.dot) CH.dot.setAttribute('visibility', 'hidden');
    if (CH.bars) { for (const b of CH.bars) b.classList.remove('on'); CH.el.classList.remove('hov'); }
    if (CH.ubars) for (const b of CH.ubars) if (b) b.classList.remove('on');
    readout(CH.series[CH.n - 1], CH.n - 1);
  }
  function tile(id, value, cls, sub) {
    const el = $(id);
    if (!el) return;
    const v = el.querySelector('.v');
    v.textContent = value;
    v.className = 'v tab' + (cls ? ' ' + cls : '');
    el.querySelector('.s').textContent = sub || ' ';
  }
  function renderKpis(w, r) {
    const tr = w.trades, d = w.drawdown, c = r.capital;
    tile('kpi-ret', w.mwr === null || w.mwr === undefined ? '—' : F.pct(w.mwr), w.mwr === null ? '' : signCls(w.mwr), t('kpi.ret.' + S.w));
    const enough = tr.n >= 5 && tr.winRate !== null;
    tile('kpi-wr', enough ? F.pct(tr.winRate, { sign: false }) : '—', '', enough ? t('kpi.wr.sub', { w: F.int(tr.wins), l: F.int(tr.losses) }) : plural(tr.n, 'n.closed'));
    const pfOk = tr.n >= 5 && tr.profitFactor !== null;
    tile('kpi-pf', pfOk ? tr.profitFactor.toFixed(2) : '—', '', tr.n < 5 ? t('kpi.pf.few') : tr.profitFactor === null ? t('kpi.pf.noloss') : t('kpi.pf.sub'));
    const ep = d.episodes && d.episodes[0];
    const deep = d.maxAbs > 0.005;
    // the percent leads, the dollars sit under it; plain, not red: a drawdown is a fact, not an alarm
    tile('kpi-dd', deep ? F.pct(-(d.maxPct || 0)) : '0%', '', deep ? t(ep && ep.recovered ? 'kpi.dd.recM' : 'kpi.dd.onM', { v: F.money(-d.maxAbs) }) : t('kpi.dd.none'));
    // the trade count in place of the equity, second after the return
    const days = Math.max(1, w.days || (w.series || []).length || 1);
    tile('kpi-n', F.int(tr.n), '', tr.n ? t('kpi.n.sub', { v: (tr.n / days).toFixed(tr.n / days < 10 ? 1 : 0) }) : ' ');
  }
  function renderResults() {
    const r = S.report, w = win();
    if (!r || !w) return;
    syncFilters(r);
    const dd = S.mode === 'dd', pctScale = S.scale === 'pct';
    const tw = pctScale ? twrOf(w.series) : null;
    const use = S.mode === 'use';
    const uses = use ? (capitalUsage(w.series) || []).filter(Boolean) : [];
    const useAvg = uses.length ? Math.max(...uses.map((u) => u.peak)) : null;   // the period's highest peak
    const head = use ? useAvg || 0 : pctScale ? (dd ? Math.min(0, ...tw.dd) : tw.cum[tw.cum.length - 1] || 0) : dd ? -(w.drawdown.maxAbs || 0) : w.pnl.net;
    $('ch-label').textContent = `${t(use ? 'chart.use' : dd ? 'chart.dd' : pctScale ? 'chart.ret' : 'chart.net')} · ${t('win.' + S.w)}`;
    $('ch-tip').textContent = t('tip.' + (use ? 'use' : dd ? 'dd' : S.mode === 'daily' ? 'daily' : 'cum'));
    const v = $('ch-value');
    if (use) v.textContent = useAvg === null ? '—' : F.pct(useAvg, { sign: false });
    else if (pctScale) v.textContent = F.pct(head); else setMoney(v, head);
    v.className = 'ch-value tab ' + (use ? 'use' : signCls(head));
    for (const b of document.querySelectorAll('#scale button')) b.setAttribute('aria-pressed', String(b.dataset.sc === S.scale));
    for (const b of document.querySelectorAll('#mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
    $('gran').classList.toggle('gone', S.mode !== 'daily');   // one row under the switch: the period picker or Compare
    $('cmp').classList.toggle('gone', S.mode === 'use');   // By period compares too
    $('scale').classList.toggle('gone', S.mode === 'use');   // a share of equity: no $ / %, nothing to compare
    for (const b of document.querySelectorAll('#gran button')) b.setAttribute('aria-pressed', String(b.dataset.g === gran));
    drawChart(w);
    readout(CH.n ? CH.series[CH.n - 1] : null, CH.n ? CH.n - 1 : undefined);
    renderCmp();
    $('chart-svg').setAttribute('aria-label', t('aria.chart', { range: `${dayOf(w.from)}–${dayOf(w.to)}`, net: F.money(w.pnl.net) }));
    renderKpis(w, r);
  }

  /* ---------- open positions ---------- */
  const SL = new Set(['STOP', 'STOP_MARKET', 'TRAILING_STOP_MARKET']);
  /* ---------- margin load, like Binance's Risk: how much of each exchange's equity the open positions hold ---------- */
  const loadTone = (v) => (v >= 0.8 ? 'hot' : v >= 0.5 ? 'warn' : 'ok');
  function loadOf(r) {
    const ps = r.positions || [], acct = r.account || {};
    const exposure = ps.reduce((acc, q) => acc + Math.abs(Number(q.notional) || 0), 0);
    const mmr = exposure > 0 && acct.maintMargin > 0 ? Math.min(0.05, acct.maintMargin / exposure) : 0.01;   // the account's own maintenance rate
    const eqOf = new Map((r.sources || []).filter((q) => q.configured && q.ok).map((q) => [q.key, q.marginBalance || q.walletBalance || 0]));
    const by = new Map();
    for (const q of ps) {
      const src = q.source || 'binance', n = Math.abs(Number(q.notional) || 0);
      by.set(src, (by.get(src) || 0) + (Number(q.margin) || n / Math.max(1, q.leverage || 1)) + n * mmr);
    }
    const sources = [...eqOf.entries()].map(([key, eq]) => ({ key, eq, used: by.get(key) || 0 })).filter((q) => q.eq > 0);   // every exchange, an idle one at 0 %
    const used = sources.reduce((acc, q) => acc + q.used, 0), eq = sources.reduce((acc, q) => acc + q.eq, 0);
    // the headline is the load over all the exchanges in view, an average weighted by their equity;
    // with one exchange picked it is that exchange's own, and the split under it names each one
    return { total: eq > 0 ? used / eq : null, sources, eqOf, ratio: typeof acct.marginRatio === 'number' ? acct.marginRatio : null };
  }
  /** The (i) informer of the section titles, built in code. */
  function info(text) {
    const svg = s('svg', { 'aria-hidden': 'true', focusable: 'false' });
    s('use', { href: '#i-info' }, svg);
    return h('span', { class: 'info', tabindex: '0', role: 'button', 'aria-label': t('aria.info') }, [svg, h('span', { class: 'tip', role: 'tooltip', text })]);
  }
  /** A load gauge in n pieces, drawn like the bars beside it: a translucent fill fading in toward a capped end on the last
      lit piece, its colour by the level. */
  function segBar(v, n) {
    const on = Math.min(n, Math.max(v > 0 ? 1 : 0, Math.ceil(v * n - 1e-9)));
    const fill = h('i', { class: 'r ' + loadTone(v) });
    fill.style.left = '0';
    fill.style.width = on ? `calc(${(on / n) * 100}% - 3px)` : '0';
    const bar = h('div', { class: 'lad-bar seg' }, [fill]);
    bar.style.setProperty('--n', String(n));
    return bar;
  }


  function posRow(p, r) {
    const src = p.source || 'binance';
    const mine = (r.openOrders || []).filter((o) => o.symbol === p.symbol && (o.source || 'binance') === src && o.reduceOnly);
    const at = (o) => (o.stopPrice > 0 ? o.stopPrice : o.price);
    const nearest = (list) => list.slice().sort((a, b) => Math.abs(at(a) - p.markPrice) - Math.abs(at(b) - p.markPrice))[0];
    const stop = nearest(mine.filter((o) => SL.has(o.type)));
    const target = nearest(mine.filter((o) => !SL.has(o.type)));
    const side = p.side === 'LONG' ? 'long' : 'short';
    const roe = p.roe !== null && p.roe !== undefined ? p.roe : p.margin > 0 ? p.unrealizedPnl / p.margin : null;
    const qty = p.entryPrice > 0 ? Math.abs(Number(p.notional) || 0) / p.entryPrice : 0;
    const row = h('div', { class: 'row pos' }, [
      coin(p.symbol),
      h('div', { class: 'name' }, [
        h('div', { class: 'name-1' }, [h('b', { text: base(p.symbol) }), h('span', { class: 'tag', text: t('side.' + side) }), h('span', { class: 'tag', text: `${p.leverage}×` }), exChip(src)]),
        h('small', { class: 'tab', text: [t('pos.size', { v: F.usd0(p.notional) }), t('pos.entry', { v: F.price(p.entryPrice) }), stop && target ? null : t('pos.mark', { v: F.price(p.markPrice) })].filter(Boolean).join(' · ') }),
      ]),
      stop && target ? ladder(p, at(stop), at(target)) : h('div', { class: 'orders tab' }, [
        h('span', { class: stop ? '' : 'warn', text: stop ? t('pos.stop', { v: F.price(at(stop)) }) : t('pos.noStop') }),
        target ? h('span', { text: t('pos.target', { v: F.price(at(target)) }) }) : null,
      ]),
      posLoad(p, r),
      h('div', { class: 'num' }, [h('b', { class: 'tab ' + signCls(p.unrealizedPnl), text: F.money(p.unrealizedPnl) }), roe === null ? null : h('small', { class: 'tab ' + signCls(roe), text: F.pct(roe) })]),
    ]);
    // what the totals row adds up: the loss if every stop is hit, the gain if every target is
    row._sum = { risk: stop ? qty * Math.abs(p.entryPrice - at(stop)) : null, reward: target ? qty * Math.abs(at(target) - p.entryPrice) : null };
    return row;
  }

  /**
   * Stop and target as a price ladder: the stop at the left, the target at the right, red from the stop to
   * the entry, green from the entry to the target, a tick at the entry and a dot at the price now; the risk/reward between.
   */
  function ladder(p, stop, target) {
    const entry = p.entryPrice, now = p.markPrice, span = target - stop;
    const pos = (v) => Math.max(0, Math.min(1, (v - stop) / span));
    const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : null;
    const size = Math.abs(Number(p.notional) || 0), qty = entry > 0 ? size / entry : 0;
    // drawn like the PnL by coin bars: a quiet track from the stop to the target, a hairline at the
    // entry, and the move from the entry to the price now as a bar fading in toward its capped end
    const tone = p.unrealizedPnl >= 0 ? 'up' : 'dn';
    const e = pos(entry), m = pos(now);
    const move = h('i', { class: tone + (m >= e ? ' r' : ' l') });
    move.style.left = `${Math.min(e, m) * 100}%`;
    move.style.width = `${Math.abs(m - e) * 100}%`;
    const mark = h('b');
    mark.style.left = `${e * 100}%`;
    const bar = h('div', { class: 'lad-bar' }, [move, mark]);
    const pct = (v) => F.pct(Math.abs(v - now) / now, { sign: false });
    const el = h('div', { class: 'lad tab' }, [
      bar,
      h('div', { class: 'lad-row' }, [
        h('span', { text: F.price(stop) }),
        h('span', { text: F.price(target) }),
      ]),
    ]);
    return tip(el, { h: `${base(p.symbol)} · ${t('pos.rrH')}`, rows: [
      [t('pos.ttStop'), `${F.price(stop)} · ${pct(stop)}`, 'loss'],
      [t('pos.ttTarget'), `${F.price(target)} · ${pct(target)}`, 'gain'],
      [t('pos.ttEntry'), F.price(entry)],
      [t('pos.ttNow'), F.price(now)],
      [t('pos.ttRisk'), F.usd(qty * risk), 'loss'],
      [t('pos.ttReward'), F.usd(qty * reward), 'gain'],
      rr === null ? null : [t('pos.ttRR'), `1 : ${rr.toFixed(2)}`],
    ] });
  }
  /** The position's share of its exchange's equity, as a small gauge; the liquidation in its tooltip. */
  function posLoad(p, r) {
    const eq = loadOf(r).eqOf.get(p.source || 'binance') || 0;
    const m = Number(p.margin) || Math.abs(Number(p.notional) || 0) / Math.max(1, p.leverage || 1);
    if (!(eq > 0) || !(m > 0)) return h('div', { class: 'pos-load' });
    const share = m / eq;
    const el = h('div', { class: 'pos-load tab' }, [segBar(share * 4, 5), h('small', { text: F.pct(share, { sign: false }) })]);   // drawn like the stop/target bar beside it
    return tip(el, { h: base(p.symbol), rows: [[t('pos.ttMargin'), F.usd(m)], [t('pos.ttShare'), F.pct(share, { sign: false })], p.liquidationPrice > 0 ? [t('pos.ttLiq'), F.price(p.liquidationPrice)] : null, typeof p.liqDistance === 'number' ? [t('pos.ttDist'), F.pct(p.liqDistance, { sign: false })] : null] });
  }

  /* ---------- Forecast: where the open positions can end if each one runs to its stop or its target ---------- */




  /** The line under the positions: their size, what the stops and the targets put at stake, the margin
      they hold against the equity, and the open PnL with its ROI. */
  function posTotal(ps, rows, r) {
    const sum = (f) => ps.reduce((acc, p) => acc + (Number(f(p)) || 0), 0);
    const size = sum((p) => Math.abs(p.notional)), pnl = sum((p) => p.unrealizedPnl);
    const margin = sum((p) => p.margin || Math.abs(p.notional) / Math.max(1, p.leverage || 1));
    const at = (k) => (rows.every((x) => x._sum[k] !== null) ? rows.reduce((acc, x) => acc + x._sum[k], 0) : null);
    const risk = at('risk'), reward = at('reward');
    // the capital load lives here since it left the section's head: the exchanges in view weighted by
    // their equity, each exchange and the margin ratio in the tooltip
    const L = loadOf(r), share = L.total;
    const pair = (label, v, sign) => h('span', null, [h('small', { text: label }), h('b', { class: 'tab', text: v === null ? '—' : `${sign}${F.usd0(v)}` })]);
    return h('div', { class: 'row pos ptotal' }, [
      h('span'),
      h('div', { class: 'name' }, [h('div', { class: 'name-1' }, [h('b', { text: t('pos.total') })]), h('small', { class: 'tab', text: `${plural(ps.length, 'n.pos')} · ${t('pos.size', { v: F.usd0(size) })}` })]),
      h('div', { class: 'pt-lad' }, [pair(t('pos.atStops'), risk, '−'), pair(t('pos.atTargets'), reward, '+')]),
      share === null ? h('div', { class: 'pos-load' }) : tip(h('div', { class: 'pos-load tab' }, [segBar(share, 5), h('small', { text: F.pct(share, { sign: false }) })]), { h: t('pos.load'), rows: [
        ...(L.sources.length > 1 ? L.sources.map((q) => [(r.sources.find((x) => x.key === q.key) || {}).label || q.key, F.pct(q.used / q.eq, { sign: false })]) : []),
        L.ratio === null ? null : [t('pos.ttRatio'), F.pct(L.ratio, { sign: false })],
      ] }),
      h('div', { class: 'num' }, [h('b', { class: 'tab ' + signCls(pnl), text: F.money(pnl) }), margin > 0 ? h('small', { class: 'tab', text: F.pct(pnl / margin) }) : null]),
    ]);
  }
  function renderPositions() {
    const r = S.report, list = $('pos-list');
    clear(list);
    const ps = r.positions || [];
    if (ps.length) {
      list.append(h('div', { class: 'row pos phead' }, [h('span'), h('span', { text: t('pos.hPos') }), h('span', { class: 'ph-lad' }, [h('span', { text: t('pos.ttStop') }), h('span', { text: t('pos.ttTarget') })]), h('span', { class: 'pos-load ph-load ttl' }, [h('span', { text: t('pos.load') }), info(t('pos.loadTip'))]), h('span', { class: 'num', text: t('pos.hPnl') })]));
      const rows = ps.map((p) => posRow(p, r));
      list.append(...rows);
      list.append(posTotal(ps, rows, r));   // back to the plain totals line
      return;
    }
    const lt = r.lastClosedTrip;
    const last = lt && lt.exitTime ? ' ' + t('pos.last', { sym: base(lt.symbol), side: t('side.' + lt.direction).toLowerCase(), net: F.money(lt.net), when: `${timeOf(lt.exitTime)} UTC` }) : '';
    list.append(h('p', { class: 'empty', text: t('pos.empty') + last }));
  }

  /* ---------- where the result came from: one storage-style bar ---------- */
  function renderFlow() {
    const w = win();
    if (!w) return;
    const p = w.pnl;
    const gross = p.realized, fees = p.commission, fund = p.funding + (p.other || 0), net = p.net;
    drawWaterfall([
      { label: t('flow.gross'), from: 0, to: gross },
      { label: t('flow.fees'), from: gross, to: gross + fees },
      { label: t('flow.funding'), from: gross + fees, to: gross + fees + fund },
      { label: t('flow.net'), from: 0, to: net, total: true },
    ]);
    const trades = plural(w.trades.n, 'n.trades'), days = plural(w.days, 'n.cal');
    const share = w.fees && typeof w.fees.shareOfGross === 'number' ? w.fees.shareOfGross : null;
    $('fl-note').textContent = gross > 0.005 && share !== null
      ? t('flow.note.share', { pct: F.pct(share, { sign: false }), trades, days })
      : t('flow.note.plain', { trades, days, fees: F.usd(Math.abs(fees)) });
    $('fl-note').textContent = $('fl-note').textContent.replace(/\.$/, '');
  }

  /** The waterfall: each step floats from where the previous one ended. */
  function drawWaterfall(steps) {
    const box = $('fl-bar');
    clear(box);
    WF.steps = steps;
    const W = Math.max(280, Math.round(box.clientWidth || 600)), H = narrow() ? 200 : 240;
    WF.width = W;
    const el = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', class: 'wf' }, box);
    // every step from one zero line: what came in goes up in green, what was taken goes down in red
    const vals = steps.map((x) => (x.total ? x.to : x.to - x.from));
    const ext = Math.max(...vals.map((v) => Math.abs(v)), 1);
    const step = niceStep(ext / 2);
    const lo = Math.floor(Math.min(0, ...vals) / step - 1e-9) * step, hi = Math.ceil(Math.max(0, ...vals) / step - 1e-9) * step, span = hi - lo || 1;
    const R = 60, T = 30, B = lo < 0 ? 56 : 34, plotH = H - T - B;   // a value axis on the right; room under a red bar for its figure
    const y = (v) => T + (1 - (v - lo) / span) * plotH;
    const slot = (W - R) / steps.length, bw = Math.min(110, slot * 0.56);
    barFills(s('defs', null, el));
    // the main chart's grid: a dot where each value step meets each column, the scale on the right
    const xs = steps.map((_, i) => slot * i + slot / 2);
    for (let k = 0, n = Math.round((hi - lo) / step); k <= n; k++) {
      let v = lo + k * step;
      if (Math.abs(v) < step * 1e-6) v = 0;
      gridDots(el, xs, y(v), v === 0);
      s('text', { class: 'ax', x: W, y: y(v) + 4, 'text-anchor': 'end' }, el).textContent = axisMoney(v, step);
    }
    steps.forEach((x, i) => {
      const v = vals[i], up = v >= 0, cx = slot * i + slot / 2;
      const top = y(Math.max(0, v)), bot = y(Math.min(0, v));
      tip(bar(el, cx - bw / 2, top, bw, Math.max(2, bot - top), up ? 'up' : 'dn', up, 'wf-bar'), { h: x.label, rows: [[t(x.total ? 'tt.total' : 'tt.amount'), ...ttMoney(v)], x.total ? null : [t('tt.after'), ...ttMoney(x.to)]] });
      s('text', { class: 'wf-v ' + signCls(v), x: cx, y: up ? top - 9 : Math.max(top, bot) + 18, 'text-anchor': 'middle' }, el).textContent = F.money(v);
      s('text', { class: 'wf-l', x: cx, y: H - 8, 'text-anchor': 'middle' }, el).textContent = x.label;
    });
  }
  const WF = { steps: null, width: 0 };

  /* ---------- trade analytics ---------- */
  /** Columns around a zero line in HTML (they stretch with the card): items { label, v, sub }; heights through the CSSOM. */
  function columns(items, opts) {
    const o = opts || {};
    const vals = items.map((x) => x.v);
    const rawP = Math.max(0, ...vals), rawN = Math.max(0, ...vals.map((v) => -v));
    // the bars stand on round steps so a scale can sit beside them, the main chart's way
    const step = o.wr ? 0.25 : o.prob ? niceStep(Math.max(rawP, 1e-6) / 3) : o.count ? Math.max(1, niceStep(Math.max(rawP, rawN, 1) / 3)) : niceStep(Math.max(rawP, rawN, 1e-6) / (rawP && rawN ? 2 : 3));
    let maxP = rawP > 0 ? Math.ceil(rawP / step - 1e-9) * step : 0, maxN = rawN > 0 ? Math.ceil(rawN / step - 1e-9) * step : 0;
    if (o.wr) { maxP = 0.5; maxN = 0.5; }   // win rate: always the whole 0 to 100 %, 50 % in the middle
    const wrap = h('div', { class: 'cols' + (o.count ? ' count' : '') + (o.dense ? ' dense' : '') + (o.wide ? ' wide' : '') });
    const plot = h('div', { class: 'cplot' });
    const up = h('div', { class: 'chalf up' }), dn = h('div', { class: 'chalf dn' });
    // flex-grow as shares of the whole: grow factors summing under 1 would leave part of the plot empty (probabilities)
    const k = 1 / Math.max(maxP + maxN, 1e-9);
    up.style.flexGrow = String(maxP * k || (maxN ? 0.0001 : 1));
    dn.style.flexGrow = String(maxN * k || 0.0001);
    const grid = h('div', { class: 'cgrid' });
    const full = (maxP || 0) + (maxN || 0) || 1;
    for (let v = -maxN; v <= maxP + 1e-9; v += step) {
      const vv = Math.abs(v) < step * 1e-6 ? 0 : v;
      const row = h('div', { class: 'crow' + (vv === 0 ? ' z' : '') }, items.map(() => h('i')));
      row.style.top = `${(((maxP || 0) - vv) / full) * 100}%`;
      row.append(h('span', { class: 'cax tab', text: o.wr ? `${Math.round((vv + 0.5) * 100)}%` : o.prob ? `${+(vv * 100).toFixed(step * 100 < 1 ? 1 : 0)}%` : o.count ? F.int(vv) : axisMoney(vv, step) }));
      grid.append(row);
    }
    const foot = h('div', { class: 'cfoot' });
    for (const x of items) {
      const tone = x.tone || (x.v > 0.005 ? 'up' : x.v < -0.005 ? 'dn' : 'flat');
      const pb = h('span', { class: 'cb' }, [h('i', { class: x.v > 0 ? tone : '' })]);
      const nb = h('span', { class: 'cb' }, [h('i', { class: x.v < 0 ? tone : '' })]);
      pb.firstChild.style.height = maxP > 0 && x.v > 0 ? `${(x.v / maxP) * 100}%` : '0';
      nb.firstChild.style.height = maxN > 0 && x.v < 0 ? `${(-x.v / maxN) * 100}%` : '0';
      const tt = x.rows ? { h: x.name || x.label, rows: x.rows } : { h: x.name || x.label, rows: [o.prob ? [t('fc.chance'), F.pct(x.v, { sign: false })] : o.count ? [t('tt.trades'), F.int(x.v)] : [t('tt.result'), ...ttMoney(x.v)], (x.sub || x.tsub) ? [x.sub || x.tsub, ''] : null] };
      tip(pb, tt); tip(nb, tt);
      up.append(pb);
      dn.append(nb);
      foot.append(h('span', { class: 'cl' }, [h('b', { text: x.label }), h('span', { class: 'tab ' + (o.count || o.prob ? '' : signCls(x.v)), text: o.wr ? (x.n ? F.pct(x.v + 0.5, { sign: false }) : '\u00a0') : o.prob ? (x.v >= 0.0005 ? F.pct(x.v, { sign: false }) : '\u00a0') : o.count ? F.int(x.v) : moneyShort(x.v) }), x.sub ? h('small', { class: 'tab', text: x.sub }) : null]));
    }
    plot.append(grid, up, dn);
    wrap.append(plot, foot);
    return wrap;
  }
  /* the trade analytics: one big chart with switches, a rail of figures under it */
  let taMode = 'dist';   // the returns histogram opens first
  const TA = { width: 0 };
  /**
   * Streaks: every closed trade in order, a win one step up from the last win, a loss one step down,
   * so a run of wins climbs and a run of losses digs; the tooltip has the trade and what the run has made so far.
   */
  /** The room the tab's switch row takes at the top of the chart box. */
  const taSubH = (box) => { const r = box.querySelector('.ta-sub'); return r ? r.offsetHeight + 8 : 0; };
  // streak windows: `off` trades back from the latest, a hundred shown; arrows jump a window, a drag or a sideways wheel slides
  const STW = { off: 0, size: 100, dir: 0, max: 0 };
  /**
   * The arrows roll the bars across to the next window instead of swapping it:
   * the window slides trade by trade, eased, about half a second; with reduced motion it jumps.
   */
  function stSlide(target) {
    cancelAnimationFrame(STW.raf);
    const from = STW.off;
    if (from === target) return;
    if (reduced()) { STW.off = target; safe(renderTradeChart); return; }
    const t0 = performance.now(), dur = 520;
    const step = (now) => {
      const q = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - q, 3);
      const next = Math.round(from + (target - from) * e);
      if (next !== STW.off) { STW.off = next; safe(renderTradeChart); }
      if (q < 1) STW.raf = requestAnimationFrame(step);
    };
    STW.raf = requestAnimationFrame(step);
  }
  function streakChart(box, trips) {
    const list = trips.slice().sort((a, b) => a.exitTime - b.exitTime);
    const W = Math.max(280, Math.round(box.clientWidth || 640)), H = Math.max(200, Math.round(box.clientHeight || 320) - taSubH(box));
    TA.width = W;
    const el = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'sc', role: 'img' }, box);
    const R = 48, T = 10, B = 26, pw = W - R, ph = H - T - B;
    let run = 0, sum = 0;
    const pts = list.map((x) => {
      const win = x.net > 0;
      if (win ? run > 0 : run < 0) { run += win ? 1 : -1; sum += x.net; } else { run = win ? 1 : -1; sum = x.net; }
      return { x, run, sum };
    });
    // runs count across the whole history; the chart shows one window of it, the scale shared by every window
    const all = pts, pages = Math.max(1, Math.ceil(all.length / STW.size));
    STW.max = Math.max(0, all.length - STW.size);
    STW.off = Math.max(0, Math.min(STW.max, STW.off));
    // the oldest window is a full one too: it starts at the first trade and overlaps the next one instead of showing a handful
    const end = all.length - STW.off, start = Math.max(0, end - STW.size);
    STW.pages = pages; STW.from = start; STW.to = end; STW.total = all.length;
    const hi = Math.max(1, ...all.map((p) => p.run)), lo = Math.min(-1, ...all.map((p) => p.run));
    const view = all.slice(start, end);
    const step = Math.max(1, niceStep(Math.max(hi, -lo) / 2));
    const top = Math.ceil(hi / step) * step, bot = Math.floor(lo / step) * step;
    const y = (v) => T + ((top - v) / (top - bot)) * ph;
    const slot = pw / Math.max(1, Math.min(STW.size, all.length)), bw = Math.max(1.5, Math.min(14, slot * 0.7));
    const cols = [];
    for (let i = 0; i < view.length; i += Math.max(1, Math.ceil(view.length / 12))) cols.push(slot * (i + 0.5));
    for (let v = bot; v <= top + 1e-9; v += step) {
      gridDots(el, cols, y(v), v === 0);
      s('text', { class: 'ax', x: W - 4, y: y(v) + 4, 'text-anchor': 'end' }, el).textContent = String(Math.abs(v));
    }
    barFills(s('defs', null, el));
    const bars = s('g', { class: 'st-bars' + (STW.dir ? (STW.dir > 0 ? ' in-l' : ' in-r') : '') }, el);
    view.forEach((p, i) => {
      const up = p.run > 0, x0 = slot * (i + 0.5) - bw / 2;
      const g = bar(bars, x0, up ? y(p.run) : y(0), bw, Math.abs(y(p.run) - y(0)), up ? 'up' : 'dn', up);
      tip(g, { h: `${base(p.x.symbol)} · ${timeOf(p.x.exitTime)}`, rows: [[t('tt.result'), ...ttMoney(p.x.net)], [t(up ? 'ta.st.win' : 'ta.st.loss', { n: Math.abs(p.run) }), ''], [t('ta.st.sum'), ...ttMoney(p.sum)]] });
    });
    STW.dir = 0;
    // drag sideways or turn the wheel sideways to slide through the trades
    if (STW.max > 0) {
      el.classList.add('st-drag');
      // the drag lives on the window: every step redraws the chart, so the svg under the pointer is a new one
      const per = (W / Math.max(1, view.length)) * (el.getBoundingClientRect().width / W || 1);
      el.addEventListener('pointerdown', (e) => {
        cancelAnimationFrame(STW.raf);
        const x0 = e.clientX, off0 = STW.off;
        const move = (ev) => {
          const next = Math.max(0, Math.min(STW.max, off0 + Math.round((ev.clientX - x0) / per)));
          if (next !== STW.off) { STW.off = next; safe(renderTradeChart); }
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
        addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      });
      el.addEventListener('wheel', (e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
        if (!d) return;
        e.preventDefault();
        const next = Math.max(0, Math.min(STW.max, STW.off - Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 8))));
        if (next !== STW.off) { STW.off = next; safe(renderTradeChart); }
      }, { passive: false });
    }
    const firstX = view[0] && view[0].x, lastX = view.length && view[view.length - 1].x;
    if (firstX) {
      s('text', { class: 'ax', x: 2, y: H - 6, 'text-anchor': 'start' }, el).textContent = dayOf(new Date(firstX.exitTime).toISOString().slice(0, 10));
      s('text', { class: 'ax', x: pw - 2, y: H - 6, 'text-anchor': 'end' }, el).textContent = dayOf(new Date(lastX.exitTime).toISOString().slice(0, 10));
    }
    return pts;
  }
  function scatter(box, trips) {
    const W = Math.max(280, Math.round(box.clientWidth || 640)), H = Math.max(200, Math.round(box.clientHeight || 320) - taSubH(box));   // the plot's fixed height: no jump between modes
    TA.width = W;
    const el = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'sc', role: 'img' }, box);
    const L = 8, R = 72, T = 14, B = 30, pw = W - L - R, ph = H - T - B;   // room for the value axis on the right
    const pts = trips.filter((x) => x.holdMin !== null && x.entryNotional > 0);
    const maxH = Math.max(60, ...pts.map((x) => x.holdMin)), lx = (m) => Math.log10(Math.max(1, m));
    const xr = lx(maxH) || 1, X = (m) => L + (lx(m) / xr) * pw;
    const ext = Math.max(0.005, ...pts.map((x) => Math.abs(x.retNotional))) * 1.1, Y = (v) => T + (1 - (v + ext) / (2 * ext)) * ph;
    const st = niceStep(ext / 2.2);
    const marks = [[1, '1 ' + t('u.m')], [5, '5 ' + t('u.m')], [15, '15 ' + t('u.m')], [60, '1 ' + t('u.h')], [240, '4 ' + t('u.h')], [1440, '1 ' + t('u.d')], [5760, '4 ' + t('u.d')]].filter(([m]) => m <= maxH * 1.05);
    for (let v = -Math.floor(ext / st) * st; v <= ext + 1e-12; v += st) {
      const vv = Math.abs(v) < st * 1e-6 ? 0 : v;
      gridDots(el, marks.map(([m]) => X(m)), Y(vv), vv === 0);
      s('text', { class: 'ax', x: W, y: Y(vv) + 4, 'text-anchor': 'end' }, el).textContent = vv === 0 ? '0%' : F.pct(vv);
    }
    for (const [m, lab] of [[1, '1 ' + t('u.m')], [5, '5 ' + t('u.m')], [15, '15 ' + t('u.m')], [60, '1 ' + t('u.h')], [240, '4 ' + t('u.h')], [1440, '1 ' + t('u.d')], [5760, '4 ' + t('u.d')]]) {
      if (m > maxH * 1.05) break;
      const xx = X(m), a = xx < 30 ? 'start' : xx > W - R - 30 ? 'end' : 'middle';
      s('text', { class: 'ax', x: a === 'start' ? 0 : a === 'end' ? W - R : xx, y: H - 8, 'text-anchor': a }, el).textContent = lab;
    }
    for (const x of pts) {
      tip(s('circle', { class: 'pt ' + (x.net >= 0 ? 'up' : 'dn'), cx: X(x.holdMin).toFixed(1), cy: Y(x.retNotional).toFixed(1), r: 4.5 }, el), {
        h: `${base(x.symbol)} · ${t('side.' + (x.direction === 'long' ? 'long' : 'short'))}`,
        rows: [[t('tt.held'), holdOf(x.holdMin)], [t('tt.ret'), F.pct(x.retNotional), signCls(x.retNotional)], [t('tt.result'), ...ttMoney(x.net)], x.exitTime ? [t('tt.closed'), dayOf(new Date(x.exitTime).toISOString().slice(0, 10))] : null],
      });
    }
  }
  const TB = { at: 'entry', by: 'hour' };
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#ta-chart [data-tb], #ta-chart [data-tg]');
    if (!b) return;
    if (b.dataset.tb) TB.at = b.dataset.tb; else TB.by = b.dataset.tg;
    safe(renderTradeChart);
  });
  function renderTradeChart() {
    const w = win(), box = $('ta-chart');
    if (!w || !box) return;
    clear(box);
    for (const b of document.querySelectorAll('#ta-mode button')) b.setAttribute('aria-pressed', String(b.dataset.ta === taMode));
    const tr = w.trades;
    $('ta-tip').textContent = t('tip.ta.' + taMode);
    const note = $('ta-note');
    note.textContent = ' ';
    if (tr.n < 5) { box.append(h('p', { class: 'empty', text: t('an.empty') })); return; }
    // every tab keeps the same row for its own switches, empty or not, so nothing moves between tabs
    const sub = h('div', { class: 'ta-sub' });
    box.append(sub);
    if (taMode === 'hold') {
      scatter(box, windowTrips());
      if (tr.hold && tr.hold.winners !== undefined) note.textContent = t('ta.n.hold', { w: holdOf(tr.hold.winners), l: holdOf(tr.hold.losers) });
    } else if (taMode === 'hour') {
      // results by time: by entry or by exit, by hour, weekday or month, the win rate first
      const ctl = h('div', { class: 'ta-sub' }, [
        h('div', { class: 'mini' }, ['entry', 'exit'].map((k) => h('button', { type: 'button', 'data-tb': k, 'aria-pressed': String(TB.at === k), text: t('tb.' + k) }))),
        h('div', { class: 'mini' }, ['hour', 'dow', 'month'].map((k) => h('button', { type: 'button', 'data-tg': k, 'aria-pressed': String(TB.by === k), text: t('tb.' + k) }))),
      ]);
      sub.append(...ctl.childNodes);
      const trips = windowTrips().filter((x) => (TB.at === 'entry' ? x.entryTime : x.exitTime));
      const n = TB.by === 'hour' ? 24 : TB.by === 'dow' ? 7 : 12;
      const bk = Array.from({ length: n }, () => ({ n: 0, w: 0, net: 0 }));
      for (const x of trips) {
        const d = new Date(TB.at === 'entry' ? x.entryTime : x.exitTime);
        const i = TB.by === 'hour' ? d.getUTCHours() : TB.by === 'dow' ? (d.getUTCDay() + 6) % 7 : d.getUTCMonth();
        bk[i].n++; if (x.net > 0) bk[i].w++; bk[i].net += x.net;
      }
      const lab = (i) => (TB.by === 'hour' ? `${pad(i)}:00` : TB.by === 'dow' ? DOW[lang][i] : monName(i));
      const items = bk.map((b, i) => {
        const wr = b.n ? b.w / b.n : null;
        return {
          label: TB.by === 'hour' && i % 3 ? '\u00a0' : lab(i), name: TB.by === 'hour' ? `${pad(i)}:00–${pad(i)}:59 UTC` : lab(i), n: b.n,
          v: wr === null ? 0 : wr - 0.5, tone: wr === null ? 'flat' : wr >= 0.5 ? 'up' : 'dn',
          rows: b.n ? [[t('tt.won'), F.pct(wr, { sign: false }), wr >= 0.5 ? 'gain' : 'loss'], [t('tt.trades'), F.int(b.n)], [t('tt.result'), ...ttMoney(b.net)]] : [[t('tb.none'), '']],
        };
      });
      box.append(columns(items, { wr: true, dense: n > 12 }));
      const live = items.map((x, i) => ({ ...x, i, b: bk[i] })).filter((x) => x.b.n >= 2);
      if (live.length) {
        const best = live.reduce((a, b) => (b.v > a.v ? b : a)), worst = live.reduce((a, b) => (b.v < a.v ? b : a));
        note.textContent = t('ta.n.time', { b: lab(best.i), bv: F.pct(best.v + 0.5, { sign: false }), bn: F.int(best.b.n), w: lab(worst.i), wv: F.pct(worst.v + 0.5, { sign: false }), wn: F.int(worst.b.n) }).replace(/\.0%/g, '%');
      }
    } else if (taMode === 'dur') {
      const lab = (m) => (m === null ? `>8 ${t('u.h')}` : m < 60 ? `≤${m} ${t('u.m')}` : `≤${m / 60} ${t('u.h')}`);
      const hh = (tr.holdHist || []).filter((b) => b.n > 0);
      box.append(columns(hh.map((b) => ({ label: lab(b.upTo), v: b.net, tsub: plural(b.n, 'n.trades') }))));
      if (hh.length) {
        const most = hh.reduce((a, b) => (b.n > a.n ? b : a));
        note.textContent = t('ta.n.dur', { k: lab(most.upTo), n: F.int(most.n), all: F.int(tr.n) });
      }
    } else if (taMode === 'dist') {
      const bins = (w.histogram && w.histogram.bins) || [], used = bins.filter((b) => b.n > 0);
      const items = bins.slice(bins.indexOf(used[0]), bins.indexOf(used[used.length - 1]) + 1).map((b, i, all) => {
        const mid = (b.from + b.to) / 2;
        const pc = (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v * 100).toFixed(1)}%`;
        return { label: all.length > 9 && i % 2 ? ' ' : pc(mid), name: `${pc(b.from)} … ${pc(b.to)}`, v: b.n, tone: mid >= 0 ? 'up' : 'dn' };
      });
      box.append(columns(items, { count: true }));
      note.textContent = t('ta.n.dist', { w: t('an.dist.win', { n: tr.wins }), l: t('an.dist.loss', { n: tr.losses }) });
    } else if (taMode === 'streak') {
      const pts = streakChart(box, windowTrips());
      if (STW.max > 0) {
        const arrow = (cls, d, label, off) => {
          const b = h('button', { type: 'button', class: 'arrow-btn' + cls, 'aria-label': label });
          const ic = s('svg', { 'aria-hidden': 'true', focusable: 'false' }); s('use', { href: '#i-chevron' }, ic); b.append(ic);
          b.disabled = off;
          b.addEventListener('click', () => stSlide(Math.max(0, Math.min(STW.max, STW.off + d * STW.size))));
          return b;
        };
        sub.append(h('div', { class: 'pager st-pager' }, [
          h('span', { class: 'tab', text: t('ta.st.win.n', { from: F.int(STW.from + 1), to: F.int(STW.to), n: F.int(STW.total) }) }),
          arrow('', 1, t('ta.st.older'), STW.off >= STW.max),
          arrow(' next', -1, t('ta.st.newer'), STW.off === 0),
        ]));
      }
      const w1 = Math.max(0, ...pts.map((p) => p.run)), l1 = Math.max(0, ...pts.map((p) => -p.run));
      note.textContent = t('ta.n.streak', { w: plural(w1, 'n.trades'), l: plural(l1, 'n.trades') });
    } else {
      const dirs = (w.byDirection || []);
      const row = (x) => t('an.side.row', { trades: plural(x.n, 'n.trades'), wr: x.winRate === null ? '—' : F.pct(x.winRate, { sign: false }) });
      box.append(columns(dirs.map((x) => ({ label: t('side.' + x.direction), v: x.net, tsub: row(x) })), { wide: true }));
      note.textContent = dirs.map((x) => `${t('side.' + x.direction)}: ${row(x)}`).join(' · ');
    }
  }
  function renderRail() {
    const w = win(), el = $('ta-rail');
    if (!w || !el) return;
    const tr = w.trades;
    // the percent leads, the dollars sit under it: each trade as a share of the equity at its entry
    const cell = (l, v, cls, sub) => h('div', { class: 'kpi' }, [h('span', { class: 'l', text: l }), h('span', { class: 'v tab ' + (cls || ''), text: v }), sub ? h('span', { class: 's tab', text: sub }) : null]);
    const pcts = windowTrips().filter((x) => x.equityAtEntry > 0).map((x) => x.net / x.equityAtEntry);
    const wins = pcts.filter((v) => v > 0), losses = pcts.filter((v) => v < 0);
    const mean = (a) => (a.length ? a.reduce((acc, v) => acc + v, 0) / a.length : null);
    const pctOr = (v, money) => (v === null ? F.money(money || 0) : F.pct(v));
    el.replaceChildren(
      cell(t('an.avgWin'), pctOr(mean(wins), tr.avgWin), 'gain', F.money(tr.avgWin || 0)),
      cell(t('an.avgLoss'), pctOr(mean(losses), tr.avgLoss), 'loss', F.money(tr.avgLoss || 0)),
      cell(t('an.exp'), pctOr(mean(pcts), tr.expectancy), signCls(tr.expectancy || 0), F.money(tr.expectancy || 0)),
      cell(t('an.payoff'), tr.payoff === null || tr.payoff === undefined ? '—' : `${tr.payoff.toFixed(2)}×`, '', t('an.payoff.sub')),
      cell(t('an.best'), pctOr(wins.length ? Math.max(...wins) : null, tr.largestWin), 'gain', F.money(tr.largestWin || 0)),
      cell(t('an.worst'), pctOr(losses.length ? Math.min(...losses) : null, tr.largestLoss), 'loss', F.money(tr.largestLoss || 0)),
      cell(t('an.streak.rail'), tr.streaks ? `${tr.streaks.w} / ${tr.streaks.l}` : '—', '', t('an.streak.sub')),
    );
  }
  function renderAnalytics() {
    renderTradeChart();
    renderRail();
  }

  /* ---------- activity: closed trades per day over the last year, GitHub-style ---------- */
  const ACT = { width: 0 };
  function renderActivity() {
    const r = S.report, box = $('act');
    if (!r || !box) return;
    clear(box);
    // one block per month from January of this year, days in weekday rows; a day is green or red by its result
    const gen = new Date(r.generatedAt);
    const today = Date.UTC(gen.getUTCFullYear(), gen.getUTCMonth(), gen.getUTCDate());
    const start = new Date(Date.parse(((r.windows.all && r.windows.all.from) || gen.toISOString().slice(0, 10)) + 'T00:00:00Z'));
    const sy = start.getUTCFullYear(), sm = start.getUTCMonth();
    const first = Date.UTC(sy, sm, 1), count = 12;   // twelve months from the month trading started, into the future
    const perDay = new Map();
    let total = 0;
    for (const x of r.trips || []) {
      if (x.status !== 'closed' || x.exitTime === null || x.exitTime < first) continue;
      const k = new Date(x.exitTime).toISOString().slice(0, 10);
      const d = perDay.get(k) || { n: 0, net: 0 };
      d.n++; d.net += x.net || 0;
      perDay.set(k, d);
      total++;
    }
    const maxAbs = Math.max(0, ...[...perDay.values()].map((d) => Math.abs(d.net)));
    const tone = (d) => {
      if (!d || !d.n) return 'l0';
      if (Math.abs(d.net) < 0.005) return 'lf';
      const q = maxAbs ? Math.abs(d.net) / maxAbs : 1;
      return (d.net > 0 ? 'u' : 'd') + (q < 0.34 ? 1 : q < 0.67 ? 2 : 3);
    };
    const months = [];
    for (let m = 0; m < count; m++) {
      const d0 = new Date(Date.UTC(sy, sm + m, 1));
      const y = d0.getUTCFullYear(), mo = d0.getUTCMonth(), len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const off = (d0.getUTCDay() + 6) % 7;
      months.push({ y, mo, len, off, cols: Math.ceil((off + len) / 7) });
    }
    const sc = $('act-scroll');
    const width = sc.clientWidth || 800, cols = months.reduce((a, m) => a + m.cols, 0), BG = 14;
    let size = Math.floor((width - BG * (count - 1) - 3 * (cols - count)) / cols);
    const gap = size >= 11 ? 3 : 2;
    size = Math.max(8, Math.min(16, Math.floor((width - BG * (count - 1) - gap * (cols - count)) / cols)));
    box.style.setProperty('--act-cell', `${size}px`);
    box.style.setProperty('--act-gap', `${gap}px`);
    for (const m of months) {
      const grid = h('div', { class: 'act-grid' });
      grid.style.gridTemplateColumns = `repeat(${m.cols}, var(--act-cell))`;
      for (let d = 1; d <= m.len; d++) {
        const ts = Date.UTC(m.y, m.mo, d);
        if (ts > today) {   // a day still ahead: an empty cell
          const cell = h('i', { class: 'fut' });
          cell.style.gridColumnStart = String(Math.floor((m.off + d - 1) / 7) + 1);
          cell.style.gridRowStart = String(((m.off + d - 1) % 7) + 1);
          grid.append(cell);
          continue;
        }
        const k = new Date(ts).toISOString().slice(0, 10), v = perDay.get(k);
        const cell = h('i', { class: tone(v), 'aria-label': `${dayOf(k)}: ${v ? `${plural(v.n, 'n.trades')} · ${F.money(v.net)}` : t('act.none')}`, role: 'img' });
        tip(cell, { h: dayOf(k), rows: v ? [[t('tt.trades'), F.int(v.n)], [t('tt.result'), ...ttMoney(v.net)]] : [[t('act.none'), '']] });
        cell.style.gridColumnStart = String(Math.floor((m.off + d - 1) / 7) + 1);
        cell.style.gridRowStart = String(((m.off + d - 1) % 7) + 1);
        grid.append(cell);
      }
      const head = h('div', { class: 'act-mh' }, [h('span', { text: monName(m.mo) })]);   // the month's name only
      box.append(h('div', { class: 'act-month' }, [head, grid]));
    }
    ACT.width = width;
    $('act-sub').textContent = t('act.sub', { n: plural(total, 'n.trades') });
    requestAnimationFrame(() => { sc.scrollLeft = sc.scrollWidth; });   // the latest months in view when the blocks are wider than the card
  }

  /* ---------- days ---------- */
  function monthGrid(key, byDate, today) {
    const [yy, mm] = key.split('-').map(Number);
    const days = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay() + 6) % 7;   // Monday first
    const grid = h('div', { class: 'cal' });
    for (const d of DOW[lang]) grid.append(h('span', { class: 'dow', text: d }));
    for (let i = 0; i < lead; i++) grid.append(h('span', { class: 'd blank' }));
    // every day a small column, like the charts: a translucent body under a 2 px cap, its height the
    // day's result against the month's biggest day
    let max = 0;
    for (let dd = 1; dd <= days; dd++) { const q = byDate.get(`${key}-${pad(dd)}`); if (q) max = Math.max(max, Math.abs(q.net)); }
    for (let dd = 1; dd <= days; dd++) {
      const k = `${key}-${pad(dd)}`;
      const p = byDate.get(k);
      if (!p) { grid.append(h('span', { class: 'd out' }, [h('span', { class: 'n', text: String(dd) })])); continue; }
      const idle = !p.active && Math.abs(p.net) < 0.005;
      const flat = idle || Math.abs(p.net) < 0.005, tone = flat ? 'flat' : p.net > 0 ? 'up' : 'dn';
      const col = h('i', { class: 'cb ' + tone });
      col.style.height = `${flat || !(max > 0) ? 0 : Math.max(6, (Math.abs(p.net) / max) * 40)}%`;
      grid.append(tip(h('span', { class: `d ${idle ? 'idle' : tone}${k === today ? ' today' : ''}` }, [
        col,
        h('span', { class: 'n', text: String(dd) }),
        h('span', { class: 'val tab', text: idle ? '' : moneyShort(p.net) }),
      ]), { h: dayOf(k), rows: idle ? [[t('act.none'), '']] : [[t('tt.result'), ...ttMoney(p.net)], typeof p.ret === 'number' ? [t('tt.ret'), F.pct(p.ret), signCls(p.ret)] : null, [t('tt.total'), ...ttMoney(p.cum)]] }));
    }
    return h('div', { class: 'month' }, [grid]);   // the month's name sits in the pager
  }
  let calPage = 0;
  function renderDays() {
    const w = win(), box = $('cal'), rows = $('day-rows');
    clear(box);
    clear(rows);
    if (!w || !w.series.length) { box.append(h('p', { class: 'empty', text: t('chart.empty') })); return; }
    const byDate = new Map(w.series.map((p) => [p.date, p]));
    const months = [...new Set(w.series.map((p) => p.date.slice(0, 7)))].sort().reverse();
    // one month at a time, arrows page back and forth; 0 is the latest month
    calPage = Math.max(0, Math.min(months.length - 1, calPage));
    const key = months[calPage], [yy, mm] = key.split('-').map(Number);
    box.append(monthGrid(key, byDate, w.to));
    $('cal-pos').textContent = `${MONTH[lang][mm - 1]} ${yy}`;
    $('cal-prev').disabled = calPage >= months.length - 1;
    $('cal-next').disabled = calPage === 0;
    const d = w.daily || {};
    const kv = (k, v, cls, sub) => h('div', { class: 'kv' }, [h('span', { class: 'k', text: k }), h('span', { class: 'v tab ' + (cls || '') }, [v, sub ? h('small', { text: sub }) : null])]);
    if (d.best) rows.append(kv(t('days.best'), F.money(d.best.net), signCls(d.best.net), dayOf(d.best.date)));
    if (d.worst) rows.append(kv(t('days.worst'), F.money(d.worst.net), signCls(d.worst.net), dayOf(d.worst.date)));
    if (typeof d.green === 'number') rows.append(kv(t('days.gr'), `${d.green} / ${d.red}`));
    if (typeof d.mean === 'number') rows.append(kv(t('days.avg'), F.money(d.mean), signCls(d.mean)));
  }

  /* ---------- markets ---------- */
  function mkRow(m, max) {
    // the bar shows the measure: PnL and win rate from a centre line (win rate around 50 %), volume from the left
    const bar = h('i');
    if (mkBy === 'vol') { bar.className = 'nt'; bar.style.left = '0'; bar.style.width = `${max > 0 ? ((m.volume || 0) / max) * 100 : 0}%`; }
    else {
      const v = mkBy === 'wr' ? (m.winRate === null ? 0 : (m.winRate - 0.5) * 2) : max > 0 ? m.net / max : 0;
      bar.className = v >= 0 ? 'up' : 'dn';
      bar.style.width = `${(Math.min(1, Math.abs(v)) * 50).toFixed(2)}%`;
    }
    const wr = m.winRate === null ? '—' : F.pct(m.winRate, { sign: false });
    return tip(h('div', { class: 'mk' }, [
      h('div', { class: 'mk-name' }, [coin(m.symbol), h('span', null, [h('b', { text: base(m.symbol) }), h('small', { text: plural(m.trips, 'n.trades') })])]),
      h('div', { class: 'mk-bar' + (mkBy === 'vol' ? ' from0' : '') }, [bar]),
      h('div', { class: 'v tab ' + mkCls(m), text: mkText(m) }),
    ]), { h: base(m.symbol), rows: [[t('tt.result'), ...ttMoney(m.net)], [t('tt.vol'), F.usd0(m.volume || 0)], [t('tt.trades'), F.int(m.trips)], [t('tt.won'), wr]] });
  }

  const MK_PAGE = 10;
  let mkPage = 0;
  /** Every coin of the window, best to worst, ten to a page; the arrows in the card's head turn the pages. */
  // two views of the coins: the list, or a heatmap with a tile per coin sized by its volume and coloured by its PnL
  let mkView = 'heat', mkBy = 'pnl';   // the heatmap first   // the view and the measure
  try { const b = localStorage.getItem('bt.mkBy'); if (b === 'vol' || b === 'wr') mkBy = b; } catch (e) { /* storage off */ }
  const mkVal = (m) => (mkBy === 'vol' ? m.volume || 0 : mkBy === 'wr' ? (m.winRate === null ? -1 : m.winRate) : m.net);
  const mkText = (m) => (mkBy === 'vol' ? F.usd0(m.volume || 0) : mkBy === 'wr' ? (m.winRate === null ? '—' : F.pct(m.winRate, { sign: false })) : F.money(m.net));
  const mkCls = (m) => (mkBy === 'vol' ? '' : mkBy === 'wr' ? (m.winRate === null ? 'zero' : signCls(m.winRate - 0.5)) : signCls(m.net));
  try { if (localStorage.getItem('bt.mkView') === 'list') mkView = 'list'; } catch (e) { /* storage off */ }
  /** Squarified treemap: items {v} into the rectangle x,y,w,h; returns [{item, x, y, w, h}]. */
  function squarify(items, x, y, w, h) {
    const out = [], total = items.reduce((acc, q) => acc + q.v, 0);
    if (!(total > 0)) return out;
    let rest = items.slice(), X = x, Y = y, W = w, H = h, sum = total;
    const worst = (row, side, area) => { const s2 = row.reduce((acc, q) => acc + q.a, 0); let m = 0; for (const q of row) m = Math.max(m, (side * side * q.a) / (s2 * s2), (s2 * s2) / (side * side * q.a)); return m; };
    while (rest.length) {
      const scale = (W * H) / sum, side = Math.min(W, H), row = [];
      let k = 0;
      while (k < rest.length) {
        const cand = row.concat([{ item: rest[k], a: rest[k].v * scale }]);
        if (row.length && worst(cand, side) > worst(row, side)) break;
        row.push(cand[cand.length - 1]); k++;
      }
      const ra = row.reduce((acc, q) => acc + q.a, 0), thick = ra / side;
      let off = 0;
      for (const q of row) {
        const len = q.a / thick;
        out.push(W >= H ? { item: q.item, x: X, y: Y + off, w: thick, h: len } : { item: q.item, x: X + off, y: Y, w: len, h: thick });
        off += len;
      }
      if (W >= H) { X += thick; W -= thick; } else { Y += thick; H -= thick; }
      sum -= row.reduce((acc, q) => acc + q.item.v, 0);
      rest = rest.slice(k);
    }
    return out;
  }
  const HM = { width: 0 };
  function renderHeat(rows) {
    const box = $('mk-heat');
    clear(box);
    // the tiles fill the card's own height, so switching between the list and the heatmap moves nothing
    const W = Math.max(240, Math.round(box.clientWidth || 600)), H = Math.max(280, Math.round(box.clientHeight || 440));
    HM.width = Math.round(box.clientWidth);
    const items = rows.filter((m) => m.volume > 0).sort((a, b) => b.volume - a.volume).map((m) => ({ m, v: m.volume }));
    // the area is always the volume; the colour is the measure: PnL or win rate (around 50 %), the volume in grey
    const maxAbs = Math.max(1e-9, ...items.map((q) => Math.abs(q.m.net))), maxVol = Math.max(1e-9, ...items.map((q) => q.v));
    for (const c of squarify(items, 0, 0, W, H)) {
      const m = c.item.m;
      const k = mkBy === 'vol' ? m.volume / maxVol : mkBy === 'wr' ? (m.winRate === null ? 0 : Math.abs(m.winRate - 0.5) * 2) : Math.abs(m.net) / maxAbs;
      const tone = mkBy === 'vol' ? 'nt' : mkBy === 'wr' ? (m.winRate === null || m.winRate >= 0.5 ? 'up' : 'dn') : m.net >= 0 ? 'up' : 'dn';
      const tile = h('div', { class: 'hm ' + tone }, [
        c.w > 56 && c.h > 30 ? h('b', { text: base(m.symbol) }) : null,
        c.w > 58 && c.h > 56 ? h('span', { class: 'tab', text: mkBy === 'pnl' ? moneyShort(m.net) : mkText(m) }) : null,
      ]);
      tile.style.left = `${(c.x / W) * 100}%`;
      tile.style.top = `${(c.y / H) * 100}%`;
      tile.style.width = `${(c.w / W) * 100}%`;
      tile.style.height = `${(c.h / H) * 100}%`;
      tile.style.setProperty('--k', (0.12 + 0.5 * k).toFixed(3));
      const wr = m.winRate === null ? '—' : F.pct(m.winRate, { sign: false });
      box.append(tip(tile, { h: base(m.symbol), rows: [[t('tt.result'), ...ttMoney(m.net)], [t('tt.vol'), F.usd0(m.volume)], [t('tt.trades'), F.int(m.trips)], [t('tt.won'), wr]] }));
    }
  }
  function renderMarkets() {
    const w = win(), box = $('mk-list');
    clear(box);
    const pager = $('mk-pager');
    for (const b of document.querySelectorAll('#mk-view button')) b.setAttribute('aria-pressed', String(b.dataset.v === mkView));
    for (const b of document.querySelectorAll('#mk-by [data-by]')) b.setAttribute('aria-pressed', String(b.dataset.by === mkBy));
    $('mk-by').querySelector('.dd-l').textContent = t('mk.by', { v: t({ pnl: 'mk.byPnl', vol: 'mk.byVol', wr: 'mk.byWr' }[mkBy]) });
    $('mk-heat').hidden = mkView !== 'heat';
    box.hidden = mkView === 'heat';
    if (!w) return;
    const rows = (w.bySymbol || []).filter((m) => m.trips > 0).sort((a, b) => mkVal(b) - mkVal(a) || b.net - a.net);
    if (mkView === 'heat') {
      // at least the height the list had with its pager, so the card keeps its size when the view changes
      if (HM.listH) $('mk-heat').style.minHeight = `${HM.listH}px`;
      pager.hidden = true;
      safe(() => renderHeat(rows));
      return;
    }
    if (!rows.length) { box.append(h('p', { class: 'empty', text: t('mk.empty') })); pager.hidden = true; return; }
    const pages = Math.ceil(rows.length / MK_PAGE);
    mkPage = Math.max(0, Math.min(pages - 1, mkPage));
    const max = Math.max(...rows.map((m) => (mkBy === 'vol' ? m.volume || 0 : Math.abs(m.net))));   // one scale for every page
    for (const m of rows.slice(mkPage * MK_PAGE, (mkPage + 1) * MK_PAGE)) box.append(mkRow(m, max));
    pager.hidden = pages < 2;
    $('mk-pos').textContent = t('mk.page', { from: mkPage * MK_PAGE + 1, to: Math.min(rows.length, (mkPage + 1) * MK_PAGE), n: rows.length });
    $('mk-prev').disabled = mkPage === 0;
    $('mk-next').disabled = mkPage >= pages - 1;
    { const b = box.getBoundingClientRect(), pg = pager.hidden ? null : pager.getBoundingClientRect(); if (b.height) HM.listH = Math.round((pg ? pg.bottom : b.bottom) - b.top); }
  }

  /* ---------- trades ---------- */
  function windowTrips() {
    const r = S.report, w = win();
    if (!r || !w) return [];
    const from = Date.parse(w.from + 'T00:00:00Z');
    return (r.trips || []).filter((x) => x.status === 'closed' && x.exitTime !== null && x.exitTime >= from).sort((a, b) => b.exitTime - a.exitTime);
  }
  function filteredTrips() {
    const all = windowTrips();
    if (S.filter === 'win') return all.filter((x) => x.net > 0.005);
    if (S.filter === 'loss') return all.filter((x) => x.net < -0.005);
    return all;
  }
  /** A trade's leverage: its own, else the coin's setting, else the account's usual one (Bybit's closed trades carry none). */
  function tripLev(x) {
    const r = S.report || {};
    if (x.leverage > 0) return x.leverage;
    if (r.leverage && r.leverage[x.symbol] > 0) return r.leverage[x.symbol];
    if (!r._usualLev) {
      const known = (r.trips || []).map((q) => q.leverage).filter((v) => v > 0).sort((u, v) => u - v);
      r._usualLev = known.length ? known[Math.floor(known.length / 2)] : 1;
    }
    return r._usualLev;
  }
  /** A closed trade in the open positions' layout: the name with its tags, the result on the position as a
      diverging bar from a hairline (right for a gain, left for a loss, scaled to the biggest on the page) over the entry
      and the exit price, the close time, and the PnL over its ROI. */
  /**
   * The usual stop and target distances: the exchanges keep no stop or target with a closed trade, so the
   * bar uses the strategy's own fixed distances, read off the closed trades: the median price move of the losers and of the
   * winners.
   */
  function usualStops() {
    const moves = (S.report && S.report.trips || []).filter((x) => x.status === 'closed' && x.entryVwap > 0 && x.exitVwap > 0)
      .map((x) => ((x.exitVwap - x.entryVwap) / x.entryVwap) * (x.direction === 'long' ? 1 : -1));
    const med = (a) => { const b = a.slice().sort((u, v) => u - v); return b.length ? b[Math.floor(b.length / 2)] : null; };
    const stop = med(moves.filter((m) => m < 0).map((m) => -m)), target = med(moves.filter((m) => m > 0));
    return stop > 0 && target > 0 ? { stop, target } : null;
  }
  /** A closed trade drawn like an open position: from the usual stop to the usual target, a hairline at the entry, the move to the exit. */
  function tradeRow(x, U) {
    const side = x.direction === 'long' ? 'long' : 'short', dir = side === 'long' ? 1 : -1;
    const ret = x.entryNotional > 0 ? x.retNotional : null;
    const lev = tripLev(x);
    const pct = ret === null ? null : F.pct(ret * lev);   // ROI on the margin, as the exchanges show it
    const e = x.entryVwap;
    const m = e > 0 ? ((x.exitVwap - e) / e) * dir : 0;   // the move in the trade's favour
    const stopP = U ? e * (1 - dir * U.stop) : null, targetP = U ? e * (1 + dir * U.target) : null;
    const at = (v) => (U ? Math.max(0, Math.min(1, (v + U.stop) / (U.stop + U.target))) : 0.5);
    const fill = h('i', { class: (x.net >= 0 ? 'up' : 'dn') + (m >= 0 ? ' r' : ' l') });
    fill.style.left = `${Math.min(at(0), at(m)) * 100}%`;
    fill.style.width = `${Math.abs(at(m) - at(0)) * 100}%`;
    const mark = h('b');
    mark.style.left = `${at(0) * 100}%`;
    const move = tip(h('div', { class: 'lad tab' }, [
      h('div', { class: 'lad-bar' }, [fill, mark]),
      U ? h('div', { class: 'lad-row' }, [h('span', { text: `≈${F.price(stopP)}` }), h('span', { text: `≈${F.price(targetP)}` })]) : null,
    ]), { h: base(x.symbol), rows: [
      [t('pos.ttEntry'), F.price(e)], [t('tr.exit'), F.price(x.exitVwap)],
      U ? [t('pos.ttStop'), `≈${F.price(stopP)}`, 'loss'] : null, U ? [t('pos.ttTarget'), `≈${F.price(targetP)}`, 'gain'] : null,
      ret === null ? null : [t('tr.onPos'), F.pct(ret), signCls(ret)], [t('flow.fees'), F.money(-Math.abs(x.fees))],
      U ? [t('tr.approx'), ''] : null,
    ] });
    return h('div', { class: 'row pos trade' }, [
      coin(x.symbol),
      h('div', { class: 'name' }, [
        h('div', { class: 'name-1' }, [h('b', { text: base(x.symbol) }), h('span', { class: 'tag', text: t('side.' + side) }), h('span', { class: 'tag', text: `${lev}×` }), exChip(x.source)]),
        h('small', { class: 'tab' }, [[t('pos.size', { v: F.usd0(x.entryNotional) }), t('pos.entry', { v: F.price(x.entryVwap) })].join(' · '), h('span', { class: 'ph', text: ` · ${clockOf(x.exitTime)}` })]),   // as the positions read
      ]),
      move,
      h('div', { class: 'when tab', text: clockOf(x.exitTime) }),   // the day is the group's, UTC is said once in the header
      h('div', { class: 'held tab', text: x.holdMin === null ? '—' : holdOf(x.holdMin) }),
      h('div', { class: 'num' }, [h('b', { class: 'tab ' + signCls(x.net), text: F.money(x.net) }), pct ? h('small', { class: 'tab', text: pct }) : null]),
    ]);
  }

  /** The run going now on each exchange: wins in a row with a flame, losses in a row with a cold mark. */
  function renderStreaks() {
    const box = $('tr-streaks'), r = S.report;
    if (!box || !r) return;
    clear(box);
    const by = new Map();
    for (const x of (r.trips || []).filter((q) => q.status === 'closed' && q.exitTime)) {
      const k = x.source || 'binance';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(x);
    }
    for (const [k, list] of by) {
      list.sort((a, b) => b.exitTime - a.exitTime);
      const win = list[0].net > 0;
      let n = 0;
      for (const x of list) { if ((x.net > 0) === win) n++; else break; }
      // a flame for a run of wins, a six-armed snowflake for a run of losses, both drawn as strokes
      const icon = s('svg', { viewBox: '0 0 24 24', class: 'st-ico', 'aria-hidden': 'true' });
      s('path', { d: win ? 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z' : 'M12.00 21.50L12.00 2.50M12.00 5.80L13.79 3.51M12.00 5.80L10.21 3.51M20.23 16.75L3.77 7.25M6.63 8.90L5.54 6.21M6.63 8.90L3.76 9.30M20.23 7.25L3.77 16.75M6.63 15.10L3.76 14.70M6.63 15.10L5.54 17.79M12.00 18.20L10.21 20.49M12.00 18.20L13.79 20.49M17.37 15.10L18.46 17.79M17.37 15.10L20.24 14.70M17.37 8.90L20.24 9.30M17.37 8.90L18.46 6.21', class: win ? 'fire' : 'ice' }, icon);
      box.append(tip(h('div', { class: 'st ' + (win ? 'win' : 'loss') }, [icon, h('b', { class: 'tab', text: String(n) }), h('span', null, [h('small', { text: plural(n, win ? 'n.stw' : 'n.stl') }), h('small', { class: 'st-ex', text: (r.sources && (r.sources.find((q) => q.key === k) || {}).label) || k })])]),
        { h: (r.sources && (r.sources.find((q) => q.key === k) || {}).label) || k, rows: [[plural(n, win ? 'n.stw' : 'n.stl'), String(n)], [t('st.last'), `${base(list[0].symbol)} ${F.money(list[0].net)}`, signCls(list[0].net)]] }));
    }
  }
  /**
   * Rings over the trades history: how the period's closed trades split into winners and losers,
   * longs and shorts, and between the exchanges, each drawn like the charts: a translucent band under a bright edge.
   */
  function ring(title, parts, center, sub) {
    const total = parts.reduce((acc, p) => acc + p.n, 0), R = 50, C = 2 * Math.PI * R, live = parts.filter((p) => p.n);
    const svg = s('svg', { viewBox: '0 0 128 128', class: 'oc-ring', role: 'img' });
    s('circle', { class: 'oc-track', cx: 64, cy: 64, r: R }, svg);
    let off = 0;
    for (const p of live) {
      const len = (p.n / total) * C, gap = live.length > 1 ? 3 : 0, l = Math.max(0, len - gap);
      const g = s('g', { class: 'oc-seg ' + p.tone, transform: 'rotate(-90 64 64)' }, svg);
      s('circle', { class: 'oc-band', cx: 64, cy: 64, r: R, 'stroke-dasharray': `${l.toFixed(2)} ${(C - l).toFixed(2)}`, 'stroke-dashoffset': (-off).toFixed(2) }, g);
      const Ro = R + 6.5, Co = 2 * Math.PI * Ro, lo = (l / C) * Co;
      s('circle', { class: 'oc-edge', cx: 64, cy: 64, r: Ro, 'stroke-dasharray': `${lo.toFixed(2)} ${(Co - lo).toFixed(2)}`, 'stroke-dashoffset': ((-off / C) * Co).toFixed(2) }, g);
      tip(g, { h: p.label, rows: [[t('tt.trades'), F.int(p.n)], [t('tt.share'), F.pct(p.n / total, { sign: false })], p.extra || null] });
      off += len;
    }
    s('text', { class: 'oc-n tab', x: 64, y: 66, 'text-anchor': 'middle' }, svg).textContent = center;
    s('text', { class: 'oc-l', x: 64, y: 83, 'text-anchor': 'middle' }, svg).textContent = sub;
    return h('div', { class: 'oc-col' }, [
      h('p', { class: 'ch-label', text: title }),
      h('div', { class: 'oc-body' }, [svg, h('div', { class: 'oc-rows' }, live.map((p) => h('div', { class: 'oc-row' }, [h('i', { class: 'oc-dot ' + p.tone }), h('span', { text: p.label }), h('b', { class: 'tab', text: F.pct(p.n / total, { sign: false }) })])))]),
    ]);
  }
  function renderOutcomes() {
    const box = $('tr-oc');
    const trips = windowTrips();
    box.hidden = !trips.length;
    if (!trips.length) return;
    const n = trips.length, wr = (list) => (list.length ? F.pct(list.filter((x) => x.net > 0.005).length / list.length, { sign: false }) : '—');
    const wins = trips.filter((x) => x.net > 0.005).length, losses = trips.filter((x) => x.net < -0.005).length;
    const longs = trips.filter((x) => x.direction === 'long'), shorts = trips.filter((x) => x.direction !== 'long');
    const cols = [
      ring(t('oc.h.out'), [{ label: t('oc.win'), n: wins, tone: 'up' }, { label: t('oc.loss'), n: losses, tone: 'dn' }, { label: t('oc.even'), n: n - wins - losses, tone: 'nt' }], F.int(n), t('oc.total')),
      ring(t('oc.h.side'), [{ label: t('side.long'), n: longs.length, tone: 'a', extra: [t('tt.won'), wr(longs)] }, { label: t('side.short'), n: shorts.length, tone: 'b', extra: [t('tt.won'), wr(shorts)] }], wr(trips), t('oc.won')),
    ];
    const r = S.report, srcs = new Map();
    for (const x of trips) { const k = x.source || 'binance'; if (!srcs.has(k)) srcs.set(k, []); srcs.get(k).push(x); }
    if (srcs.size > 1) {
      const label = (k) => ((r && r.sources && r.sources.find((q) => q.key === k)) || {}).label || k;
      cols.push(ring(t('oc.h.ex'), [...srcs].map(([k, list], i) => ({ label: label(k), n: list.length, tone: i ? 'b' : 'a', extra: [t('tt.won'), wr(list)] })), String(srcs.size), t('oc.ex')));
    }
    box.replaceChildren(...cols);
  }

  function renderTrades() {
    safe(renderStreaks);
    safe(renderOutcomes);
    for (const b of document.querySelectorAll('#trade-filter button')) b.setAttribute('aria-pressed', String(b.dataset.f === S.filter));
    const list = $('trade-list');
    clear(list);
    const rows = filteredTrips();
    // grouped by UTC day under a divider with the day's count and result; S.shown counts days
    const dayKeyOf = (x) => new Date(x.exitTime).toISOString().slice(0, 10);
    const days = [];
    for (const x of rows) { const k = dayKeyOf(x); if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, rows: [] }); days[days.length - 1].rows.push(x); }
    const shownDays = days.slice(0, S.shown), page = shownDays.flatMap((d) => d.rows);
    const today = new Date(S.report && S.report.generatedAt || Date.now()).toISOString().slice(0, 10);
    const yday = new Date(Date.parse(today + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    if (!rows.length) list.append(h('p', { class: 'empty', text: t('tr.empty') }));
    if (page.length) {
      list.append(h('div', { class: 'row pos trade phead' }, [h('span'), h('span', { text: t('tr.hTrade') }), h('span', { class: 'ph-lad' }, [h('span', { text: t('pos.ttStop') }), h('span', { text: t('pos.ttTarget') })]), h('span', { class: 'when', text: t('tr.hClosed') }), h('span', { class: 'held', text: t('tt.held') }), h('span', { class: 'num', text: t('pos.hPnl') })]));
      const U = usualStops();
      for (const d of shownDays) {
        const net = d.rows.reduce((acc, x) => acc + x.net, 0);
        list.append(h('div', { class: 'tday' }, [h('b', { text: d.key === today ? t('tr.today') : d.key === yday ? t('tr.yday') : dayOf(d.key) }), h('span', { class: 'tab' }, [`${plural(d.rows.length, 'n.trades')} · `, h('span', { class: signCls(net), text: F.money(net) })])]));
        for (const x of d.rows) list.append(tradeRow(x, U));
      }
    }
    $('trade-more').hidden = days.length <= S.shown;
    $('trade-csv').hidden = !rows.length;
    $('trade-count').textContent = days.length > S.shown ? t('tr.count', { shown: F.int(page.length), total: F.int(rows.length) }) : '';
  }
  function csvOf(rows) {
    const iso = (ms) => (ms === null || ms === undefined ? '' : new Date(ms).toISOString());
    const esc = (v) => { const str = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; };
    const head = ['closed_utc', 'opened_utc', 'exchange', 'symbol', 'side', 'hold_min', 'size_usd', 'entry_price', 'exit_price', 'gross', 'fees', 'funding', 'net', 'return_pct'];
    const lines = [head.join(',')];
    for (const x of rows) {
      lines.push([iso(x.exitTime), iso(x.entryTime), x.source || 'binance', x.symbol, x.direction, x.holdMin, x.entryNotional.toFixed(2), x.entryVwap, x.exitVwap, x.gross.toFixed(4), x.fees.toFixed(4), x.funding.toFixed(4), x.net.toFixed(4), x.entryNotional > 0 ? (x.retNotional * 100).toFixed(3) : ''].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- risk ---------- */
  /*
   * Risk, rebuilt: on the left how far the account sat below its peak each day, Bitcoin's own fall
   * over the same days as a grey line; on the right the risk figures side by side with simply holding Bitcoin. Everything
   * from the window's daily returns, so deposits don't move it.
   */
  const RK = { width: 0, key: 'BTC', view: 'dd' };   // the benchmark of the risk section, any of the compare coins
  try { const k = localStorage.getItem('bt.rkCmp'); if (k) RK.key = k; } catch (e) { /* storage off */ }
  function riskData(w) {
    const days = (w.series || []).filter((p) => typeof p.ret === 'number');
    if (days.length < 3) return null;
    const c = BM.data && (BM.data.coins.find((q) => q.key === RK.key) || BM.data.coins.find((q) => q.key === 'BTC'));
    const close = c ? closeFinder(c) : null;
    const btcRet = close ? days.map((p) => { const c1 = close(p.date), c0 = close(dayBefore(p.date)); return c0 && c1 ? c1 / c0 - 1 : null; }) : null;
    const side = (r) => {
      let g = 1, peak = 1, mdd = 0;
      const dd = r.map((v) => { g *= 1 + v; peak = Math.max(peak, g); const d = g / peak - 1; mdd = Math.min(mdd, d); return d; });
      const mean = r.reduce((x, y) => x + y, 0) / r.length;
      const sd = Math.sqrt(r.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, r.length - 1));
      const down = Math.sqrt(r.reduce((x, y) => x + Math.min(0, y) ** 2, 0) / r.length);
      return {
        dd, mdd, ret: g - 1, worst: Math.min(...r), best: Math.max(...r), swing: sd, up: r.filter((v) => v > 0).length / r.length,
        sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : null, sortino: down > 0 ? (mean / down) * Math.sqrt(365) : null,
        calmar: mdd < -1e-6 ? (g - 1) / -mdd : null,
      };
    };
    const acct = side(days.map((p) => p.ret));
    const btc = btcRet && btcRet.every((v) => v !== null) ? side(btcRet) : null;
    let corr = null;
    if (btc) {
      const r = days.map((p) => p.ret), m1 = r.reduce((x, y) => x + y, 0) / r.length, m2 = btcRet.reduce((x, y) => x + y, 0) / r.length;
      let sxy = 0, sxx = 0, syy = 0;
      r.forEach((v, i) => { sxy += (v - m1) * (btcRet[i] - m2); sxx += (v - m1) ** 2; syy += (btcRet[i] - m2) ** 2; });
      corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    }
    return { days, acct, btc, corr, btcRet, bm: c ? { key: c.key, name: c.name } : null };
  }
  function drawUnderwater(D) {
    const svg = $('rk-svg'), box = $('rk-chart');
    clear(svg);
    const W = Math.max(260, Math.round(box.clientWidth || 520)), H = narrow() ? 160 : 230;
    RK.width = W;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    const n = D.days.length, R = 56, T = 8, B = 26, plotW = W - R, plotH = H - T - B;
    const low = Math.min(D.acct.mdd, D.btc ? D.btc.mdd : 0, -0.01);
    const step = niceStep(-low / 3), bot = -Math.ceil(-low / step - 1e-9) * step;
    const x = (i) => (n === 1 ? plotW / 2 : 6 + (i / (n - 1)) * (plotW - 12)), y = (v) => T + (v / bot) * plotH;
    const ticks = ticksOf(n, plotW);
    for (let v = 0; v >= bot - 1e-9; v -= step) {
      gridDots(svg, ticks.map(x), y(v), Math.abs(v) < 1e-9);
      s('text', { class: 'ax', x: W - 4, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = axisPct(v, step);
    }
    for (const i of [0, n - 1]) s('text', { class: 'ax', x: i ? x(i) : x(0), y: H - 6, 'text-anchor': i ? 'end' : 'start' }, svg).textContent = dayOf(D.days[i].date);
    const pts = D.acct.dd.map((v, i) => [x(i), y(v)]), line = smooth(pts);
    fade(s('defs', null, svg), 'rk-f', 'dn', y(0), y(bot));
    s('path', { class: 'area', d: `${line}L${x(n - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`, fill: 'url(#rk-f)' }, svg);
    if (D.btc) s('path', { class: 'bench', d: smooth(D.btc.dd.map((v, i) => [x(i), y(v)])) }, svg);
    s('path', { class: 'line dn', d: line }, svg);
    tip(svg, (e) => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - 6) / (plotW - 12)) * (n - 1))));
      return { h: dayOf(D.days[i].date), rows: [[t('rk.acct'), F.pct(D.acct.dd[i]), D.acct.dd[i] < -0.0005 ? 'loss' : ''], D.btc ? [D.bm.name, F.pct(D.btc.dd[i]), D.btc.dd[i] < -0.0005 ? 'loss' : ''] : null] };
    });
  }
  /**
   * Direction only: two lanes, the account above the coin,
   * an arrow up or down for each day, and the days both went the same way joined by one highlighted pill.
   */
  function drawCorr(D) {
    const svg = $('rk-svg'), box = $('rk-chart');
    clear(svg);
    const W = Math.max(260, Math.round(box.clientWidth || 520)), H = narrow() ? 160 : 230;
    RK.width = W;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    const R = 64, B = 26, plotW = W - R, n = D.days.length;
    const a = D.days.map((p) => p.ret), b = D.btcRet;
    const dir = (v) => (v > 0.0005 ? 1 : v < -0.0005 ? -1 : 0);
    const slot = plotW / n, cx = (i) => slot * (i + 0.5);
    // the lanes on top, the correlation as it built up day by day under them
    const laneH = (H - B) * 0.56, mid = laneH / 2, gapY = Math.min(30, laneH / 4), yA = mid - gapY, yB = mid + gapY;
    const r = Math.max(3, Math.min(9, slot * 0.28));
    s('text', { class: 'ax rk-lane', x: W - 4, y: yA + 4, 'text-anchor': 'end' }, svg).textContent = t('rk.acct');
    s('text', { class: 'ax rk-lane', x: W - 4, y: yB + 4, 'text-anchor': 'end' }, svg).textContent = D.bm.key;
    const arrow = (x, y, d, g) => {
      if (!d) { s('rect', { class: 'rk-flat', x: (x - r * 0.7).toFixed(1), y: (y - 1).toFixed(1), width: (r * 1.4).toFixed(1), height: 2, rx: 1 }, g); return; }
      const k = r * 0.95;
      s('path', { class: 'rk-arr ' + (d > 0 ? 'up' : 'dn'), d: d > 0 ? `M${x},${y - k}L${x + k},${y + k * 0.7}L${x - k},${y + k * 0.7}Z` : `M${x},${y + k}L${x + k},${y - k * 0.7}L${x - k},${y - k * 0.7}Z` }, g);
    };
    for (let i = 0; i < n; i++) {
      const da = dir(a[i]), db = dir(b[i]), same = da !== 0 && da === db;
      const g = s('g', { class: 'rk-day' + (same ? ' same' : '') }, svg);
      if (same) s('rect', { class: 'rk-match', x: (cx(i) - r * 1.6).toFixed(1), y: (yA - r * 2).toFixed(1), width: (r * 3.2).toFixed(1), height: (yB - yA + r * 4).toFixed(1), rx: (r * 1.6).toFixed(1) }, g);
      else s('line', { class: 'rk-split', x1: cx(i), x2: cx(i), y1: yA + r * 1.6, y2: yB - r * 1.6 }, g);
      arrow(cx(i), yA, da, g);
      arrow(cx(i), yB, db, g);
      tip(s('rect', { class: 'hit', x: (cx(i) - slot / 2).toFixed(1), y: 0, width: slot.toFixed(1), height: H }, g), {
        h: dayOf(D.days[i].date), rows: [[t('rk.acct'), F.pct(a[i]), signCls(a[i])], [D.bm.name, F.pct(b[i]), signCls(b[i])], [same ? t('rk.same') : t('rk.split'), '']],
      });
    }
    // the correlation of all the days up to each one, from the third day on: its last point is the figure in the head
    const top = laneH + 14, bot = H - B - 4, yc = (v) => top + ((1 - v) / 2) * (bot - top);
    for (const v of [1, 0, -1]) {
      gridDots(svg, D.days.map((_, i) => i).filter((i) => i % Math.max(1, Math.ceil(n / 10)) === 0).map(cx), yc(v), v === 0);
      s('text', { class: 'ax', x: W - 4, y: yc(v) + 4, 'text-anchor': 'end' }, svg).textContent = v === 0 ? '0' : v > 0 ? '+1' : `${MINUS}1`;
    }
    const corrTo = (k) => {
      const x = a.slice(0, k + 1), y = b.slice(0, k + 1), m1 = x.reduce((p, q) => p + q, 0) / x.length, m2 = y.reduce((p, q) => p + q, 0) / y.length;
      let sxy = 0, sxx = 0, syy = 0;
      x.forEach((v, i) => { sxy += (v - m1) * (y[i] - m2); sxx += (v - m1) ** 2; syy += (y[i] - m2) ** 2; });
      return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    };
    const cpts = [];
    for (let k = 2; k < n; k++) { const v = corrTo(k); if (v !== null) cpts.push([cx(k), yc(v), v]); }
    if (cpts.length > 1) {
      s('path', { class: 'rk-cline', d: smooth(cpts.map((q) => [q[0], q[1]])) }, svg);
      const e = cpts[cpts.length - 1];
      s('circle', { class: 'rk-cend', cx: e[0], cy: e[1], r: 3.5 }, svg);
    }
    s('text', { class: 'ax rk-lane', x: 0, y: top - 4, 'text-anchor': 'start' }, svg).textContent = t('rk.cline');
    for (const i of [0, n - 1]) s('text', { class: 'ax', x: i ? cx(i) + slot / 2 - 2 : cx(0) - slot / 2 + 2, y: H - 6, 'text-anchor': i ? 'end' : 'start' }, svg).textContent = dayOf(D.days[i].date);
  }


  /** A table row: the figure for the account and for the coin. */
  const RK_TIPS = new Set(['calmar', 'sharpe', 'sortino']);
  function rkRow(key, a, b, fmt, tone) {
    return h('div', { class: 'rk-row' }, [
      // an (i) only where the figure isn't self-explanatory
      h('div', { class: 'ttl' }, [h('span', { class: 'rk-l', text: t('rk.' + key) }), RK_TIPS.has(key) ? info(t('rk.' + key + '.tip')) : null]),
      h('b', { class: 'rk-a tab ' + tone(a), text: fmt(a) }),
      h('span', { class: 'rk-b tab', text: b === null ? '—' : fmt(b) }),
    ]);
  }


  for (const b of document.querySelectorAll('#rk-view button')) b.addEventListener('click', () => { RK.view = b.dataset.v === 'corr' ? 'corr' : 'dd'; safe(renderRisk); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#rk-cmp-list [data-k]');
    if (!b) return;
    RK.key = b.dataset.k;
    try { localStorage.setItem('bt.rkCmp', RK.key); } catch (er) { /* storage off */ }
    safe(renderRisk);
  });
  function renderRisk() {
    const w = win(), r = S.report;
    if (!w || !r) return;
    const D = riskData(w);
    const d = w.drawdown, ep = d.episodes && d.episodes[0];
    // the left card: the drawdown or the correlation with the benchmark, switched in its head
    const corr = RK.view === 'corr' && D && D.corr !== null;
    if (RK.view === 'corr' && !corr) RK.view = 'dd';
    for (const b of document.querySelectorAll('#rk-view button')) b.setAttribute('aria-pressed', String(b.dataset.v === RK.view));
    $('rk-view').hidden = !(D && D.corr !== null);
    $('rk-key').style.visibility = corr ? 'hidden' : '';   // the lanes name themselves; the key keeps its room
    $('rk-label').textContent = corr ? t('rk.cr', { k: D.bm.key }) : t('rk.uw');
    $('rk-key').classList.toggle('bars', corr);
    $('rk-tip').textContent = corr ? t('rk.cr.tip', { k: D.bm.name }) : t('rk.uw.tip');
    if (corr) {
      // the headline says it in days: how often the account went the same way as the coin; the correlation under it
      const same = D.days.filter((p, i) => Math.sign(p.ret) === Math.sign(D.btcRet[i])).length;
      $('rk-dd').textContent = t('rk.sameN', { n: same, of: D.days.length });
      $('rk-dd').className = 'ch-value tab';
      $('rk-dd-sub').textContent = `${t('rk.sameSub', { k: D.bm.key })} · ${t('rk.corrV', { v: (D.corr < 0 ? MINUS : '') + Math.abs(D.corr).toFixed(2) })}: ${t(Math.abs(D.corr) < 0.3 ? 'rk.corr.low' : D.corr > 0 ? 'rk.corr.pos' : 'rk.corr.neg', { k: D.bm.name }).replace(/^./, (c) => c.toLowerCase())}`;
    } else {
      $('rk-dd').textContent = D ? F.pct(D.acct.mdd) : '—';
      $('rk-dd').className = 'ch-value tab ' + (D && D.acct.mdd < -0.0005 ? 'loss' : 'zero');
      const now = d.current > 0.005 ? t('rk.now.below', { pct: F.pct(d.currentPct || 0, { sign: false }) }) : t('rk.now.high');
      $('rk-dd-sub').textContent = ep ? `${dayOf(ep.peak)} → ${dayOf(ep.trough)} · ${ep.recovered ? t('rk.rec', { on: dayOf(ep.recovered) }) : t('rk.open')} · ${now}` : now;
    }
    const rows = $('rk-rows');
    clear(rows);
    if (!D) return;
    safe(() => (corr ? drawCorr(D) : drawUnderwater(D)));
    const B = D.btc, bm = D.bm ? D.bm.key : '', lossy = (v) => (v < -0.0005 ? 'loss' : ''), plain = () => '', signy = (v) => signCls(v);
    const num = (v) => (v < 0 ? MINUS : '') + Math.abs(v).toFixed(2);
    // one header names the two columns and the marks on the bars, instead of the coin on every row
    rows.append(h('div', { class: 'rk-row rk-hd' }, [h('span'), h('span', { class: 'rk-a', text: t('rk.acct') }), h('span', { class: 'rk-b', text: B ? bm : '' })]));
    // what it earned, how rough the ride was, and the two together
    const gainy = (v) => (v > 0.0005 ? 'gain' : ''), opt = (k, a, b, ...rest) => (a === null || a === undefined ? null : rkRow(k, a, b === undefined ? null : b, ...rest));
    rows.append(
      rkRow('ret', D.acct.ret, B ? B.ret : null, (v) => F.pct(v), signy),
      rkRow('best', D.acct.best, B ? B.best : null, (v) => F.pct(v), gainy),
      rkRow('worst', D.acct.worst, B ? B.worst : null, (v) => F.pct(v), lossy),
      rkRow('up', D.acct.up, B ? B.up : null, (v) => F.pct(v, { sign: false }), plain),
      rkRow('swing', D.acct.swing, B ? B.swing : null, (v) => F.pct(v, { sign: false }), plain),
      rkRow('mdd', D.acct.mdd, B ? B.mdd : null, (v) => F.pct(v), lossy),
      opt('calmar', D.acct.calmar, B ? B.calmar : null, num, signy),
      opt('sharpe', D.acct.sharpe, B ? B.sharpe : null, num, signy),
      opt('sortino', D.acct.sortino, B ? B.sortino : null, num, signy),
    );
    // the benchmark picker
    const dd = $('rk-cmp');
    dd.hidden = !BM.data;
    if (BM.data && D.bm) {
      $('rk-bm-name').textContent = D.bm.name;
      dd.querySelector('.dd-l').textContent = t('cmp.vs', { k: D.bm.key });
      const list = $('rk-cmp-list');
      list.replaceChildren(...BM.data.coins.map((c) => h('button', { type: 'button', 'data-k': c.key, 'aria-pressed': String(c.key === D.bm.key), text: c.name })));
    }
  }


  /* ---------- copy the account ---------- */
  function renderCopy() {
    const r = merged() || S.report;
    if (!r) return;
    const by = r.copyTradingBySource || {};
    for (const key of ['binance', 'bybit']) {
      const el = document.querySelector(`[data-copiers="${key}"]`);
      if (!el) continue;
      const c = by[key] || (key === 'binance' ? r.copyTrading : null);
      el.textContent = c && typeof c.copiers === 'number' ? `${t('copy.live')} · ${plural(c.copiers, 'n.copying')}` : t('copy.live');
    }
  }

  /* ---------- volume by exchange: the period's closed trades, entry plus exit notional, one row per exchange ---------- */
  const EX_TONE = { binance: 'bn', bybit: 'bb' };
  function renderExVolume() {
    const box = $('vx-body');
    if (!box) return;
    const r = S.report, trips = windowTrips();
    const by = {};
    for (const x of trips) {
      const k = x.source || 'binance';
      const b = by[k] || (by[k] = { v: 0, n: 0 });
      b.v += (x.entryNotional || 0) + (x.exitNotional || 0);
      b.n++;
    }
    const all = (r && r.sources && r.sources.length ? configured(r) : [{ key: 'binance', label: 'Binance' }]);
    const list = all.map((q) => ({ key: q.key, label: q.label, v: (by[q.key] || {}).v || 0, n: (by[q.key] || {}).n || 0 })).filter((q) => q.v > 0).sort((a, b) => b.v - a.v);
    const total = list.reduce((a, q) => a + q.v, 0), n = list.reduce((a, q) => a + q.n, 0);
    if (!total) { box.replaceChildren(h('p', { class: 'empty', text: t('mk.empty') })); return; }
    const max = list[0].v;
    const rows = list.map((q) => {
      const fill = h('i', { class: EX_TONE[q.key] || 'bb' });
      fill.style.width = `${Math.max(2, (q.v / max) * 100).toFixed(2)}%`;
      const mark = h('span', { class: 'vol-mark ' + q.key });
      mark.innerHTML = EX_MARK[q.key] || '';   // a static sprite reference, no data in it
      return tip(h('div', { class: 'vx-row' }, [
        mark,
        h('div', { class: 'vx-main' }, [
          h('div', { class: 'vx-top' }, [h('b', { text: q.label }), h('span', { class: 'tab' }, [h('b', { text: F.usd(q.v) }), ` · ${F.pct(q.v / total, { sign: false })}`])]),
          h('div', { class: 'vx-track' }, [fill]),
          h('small', { class: 'tab', text: `${plural(q.n, 'n.trades')} · ${t('vx.avg', { v: F.usd0(q.v / 2 / q.n) })}` }),
        ]),
      ]), { h: q.label, rows: [[t('tt.vol'), F.usd0(q.v)], [t('tt.share'), F.pct(q.v / total, { sign: false })], [t('tt.trades'), F.int(q.n)]] });
    });
    box.replaceChildren(
      h('div', { class: 'vx-total' }, [h('span', { text: t('vx.total') }), h('b', { class: 'tab', text: F.usd(total) })]),
      h('div', { class: 'vx-rows' }, rows),
    );
    $('vx-note').textContent = t('vx.note', { trades: plural(n, 'n.trades'), avg: F.usd0(total / 2 / n) }).replace(/\.$/, '');
  }

  /* ---------- render passes ---------- */
  function renderWindow() {
    safe(renderResults);
    safe(renderFlow);
    safe(renderExVolume);
    safe(renderDays);
    safe(renderMarkets);
    safe(renderAnalytics);
    safe(renderTrades);
    safe(renderRisk);
  }
  function renderAll() {
    if (S.report) {
      safe(renderHero);
      renderWindow();
      safe(renderPositions);
      safe(renderActivity);
      safe(renderCopy);
    }
    safe(renderStatus);
  }

  /* ---------- events ---------- */
  $('seg-window').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-w]');
    if (!b || b.dataset.w === S.w) return;
    S.w = b.dataset.w;
    S.shown = PAGE;
    mkPage = 0;
    calPage = 0;
    writeHash();
    syncFilters(S.report);
    renderWindow();
  });
  $('seg-source').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-src]');
    if (!b || b.disabled || b.dataset.src === S.src) return;
    S.src = b.dataset.src;
    S.shown = PAGE;
    writeHash();
    syncFilters(S.report);
    load();   // the slice comes from the server's cache; the current one stays on screen until it lands
  });
  $('mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === S.mode) return;
    S.mode = b.dataset.mode;
    safe(renderResults);
  });
  $('trade-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b || b.dataset.f === S.filter) return;
    S.filter = b.dataset.f;
    S.shown = PAGE;
    safe(renderTrades);
  });
  $('ta-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-ta]'); if (b && b.dataset.ta !== taMode) { taMode = b.dataset.ta; safe(renderTradeChart); } });
  $('gran').addEventListener('click', (e) => { const b = e.target.closest('button[data-g]'); if (b && b.dataset.g !== gran) { gran = b.dataset.g; safe(renderResults); } });
  $('mk-prev').addEventListener('click', () => { mkPage--; safe(renderMarkets); });
  for (const b of document.querySelectorAll('#mk-by [data-by]')) b.addEventListener('click', () => {
    mkBy = b.dataset.by === 'vol' || b.dataset.by === 'wr' ? b.dataset.by : 'pnl';
    mkPage = 0;
    try { localStorage.setItem('bt.mkBy', mkBy); } catch (e) { /* storage off */ }
    safe(renderMarkets);
  });
  // icon buttons, named in the page's own tooltip (no browser title)
  for (const b of document.querySelectorAll('#mk-view button')) tip(b, { get h() { return t(b.dataset.v === 'heat' ? 'mk.heat' : 'mk.list'); } });
  for (const b of document.querySelectorAll('#mk-view button')) b.addEventListener('click', () => {
    mkView = b.dataset.v === 'heat' ? 'heat' : 'list';
    try { localStorage.setItem('bt.mkView', mkView); } catch (e) { /* storage off */ }
    safe(renderMarkets);
  });
  $('cal-prev').addEventListener('click', () => { calPage++; safe(renderDays); });
  $('cal-next').addEventListener('click', () => { calPage--; safe(renderDays); });
  $('mk-next').addEventListener('click', () => { mkPage++; safe(renderMarkets); });
  $('trade-more').addEventListener('click', () => { S.shown += MORE; safe(renderTrades); });
  $('trade-csv').addEventListener('click', () => download(`trades-${S.src}-${S.w}.csv`, csvOf(filteredTrips())));
  $('lang').addEventListener('click', (e) => { const b = e.target.closest('button[data-lang]'); if (b) setLang(b.dataset.lang); });
  $('banner-retry').addEventListener('click', () => load());
  const svgEl = $('chart-svg');
  // mouse: hover reads a day, press and drag measures; touch: one finger reads, two fingers measure
  const PTR = new Map();
  let drag = null, relX = null;
  const pair = () => { const [p1, p2] = [...PTR.values()]; rulerShow(chartIndex(p1), chartIndex(p2)); };
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      drag = { a: chartIndex(e) };
      relX = null;
      try { svgEl.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
      rulerShow(drag.a, drag.a);
      e.preventDefault();
      return;
    }
    PTR.set(e.pointerId, e);
    if (PTR.size >= 2) pair(); else { rulerClear(); focusDay(chartIndex(e)); }
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      if (drag) { rulerShow(drag.a, chartIndex(e)); return; }
      if (CH.rulerOn) {   // a kept measure gives way once the mouse moves on
        if (relX !== null && Math.abs(e.clientX - relX) < 24) return;
        rulerClear();
      }
      focusDay(chartIndex(e));
      return;
    }
    if (PTR.has(e.pointerId)) PTR.set(e.pointerId, e);
    if (PTR.size >= 2) pair(); else focusDay(chartIndex(e));
  });
  const release = (e) => {
    if (e.pointerType === 'mouse') {
      if (!drag) return;
      const a = drag.a, b = chartIndex(e);
      drag = null;
      relX = e.clientX;
      if (a === b) { rulerClear(); focusDay(b); }
      return;
    }
    PTR.delete(e.pointerId);
    if (PTR.size < 2) rulerClear();
    if (PTR.size === 0) blurDay(); else focusDay(chartIndex([...PTR.values()][0]));
  };
  svgEl.addEventListener('pointerup', release);
  svgEl.addEventListener('pointercancel', release);
  svgEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drag) { rulerClear(); blurDay(); } });
  $('scale').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sc]');
    if (!b || b.dataset.sc === S.scale) return;
    S.scale = b.dataset.sc;
    writeHash();
    safe(renderResults);
  });
  // the filter dropdowns: one open at a time, a choice or a click outside closes it
  const ddClose = (except) => { for (const dd of document.querySelectorAll('div.dd')) if (dd !== except && dd.querySelector('.dd-menu')) { dd.querySelector('.dd-menu').hidden = true; dd.querySelector('.dd-btn').setAttribute('aria-expanded', 'false'); } };
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.dd-btn');
    if (btn) {
      const dd = btn.closest('.dd'), menu = dd.querySelector('.dd-menu');
      ddClose(dd);
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }
    if (e.target.closest('.dd-menu button') || !e.target.closest('div.dd')) ddClose(null);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ddClose(null); });
  // the compare picker
  $('cmp-btn').addEventListener('click', (e) => { e.stopPropagation(); cmpOpen($('cmp-menu').hidden); });
  $('cmp-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    S.cmp = b.dataset.k;
    writeHash();
    cmpOpen(false);
    safe(renderResults);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#cmp')) cmpOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cmpOpen(false); });
  addEventListener('hashchange', () => {
    if (!/=/.test(location.hash)) return;   // a plain anchor (#copy, #results) is navigation, not state
    const was = { w: S.w, src: S.src };
    readHash();
    syncFilters(S.report);
    if (S.src !== was.src) load();
    else if (S.w !== was.w) renderWindow();
  });
  let resizeFrame = 0;
  addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      safe(() => drawHero(false));
      const w = win();
      if (ACT.width && Math.round($('act-scroll').clientWidth) !== ACT.width) safe(renderActivity);
      if (taMode === 'hold' && TA.width && Math.round($('ta-chart').clientWidth) !== TA.width) safe(renderTradeChart);
      if (mkView === 'heat' && HM.width && Math.round($('mk-heat').clientWidth) !== HM.width) safe(renderMarkets);
      if (RK.width && Math.round($('rk-chart').clientWidth) !== RK.width) safe(renderRisk);
      if (WF.steps && Math.round($('fl-bar').clientWidth) !== WF.width) safe(() => drawWaterfall(WF.steps));
      if (w && Math.round($('chart').clientWidth) !== CH.width) safe(() => { drawChart(w); readout(CH.n ? CH.series[CH.n - 1] : null); });
    });
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => safe(() => drawHero(false)));
  // fonts.ready can resolve before Inter is even requested; when a face finishes loading, the figure's width changes: measure again
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => safe(() => drawHero(false)));

  /* ---------- boot ---------- */
  readHash();
  applyStatic();
  syncFilters(null);
  renderStatus();
  load().then(schedulePoll).then(() => loadBench());   // the benchmarks after the report: they only add a line to it
  setInterval(() => safe(renderStatus), 30000);
})();
