// trading-analytics as a Fastify plugin: the page, its files and the live report of a Binance (and optionally Bybit)
// futures account, from read-only API keys. Public, unauthenticated.
//
//   GET /                                   → page.html (strict CSP; slots and __TITLE__ / __SITE__ / __BRAND__ filled in)
//   GET /binance-dashboard                  → 301 /
//   GET /robots.txt, /sitemap.xml           → index the one page
//   GET /binance-dashboard/report           → cached analytics JSON (gzip when accepted); ?source=all|binance|bybit
//   GET /binance-dashboard/benchmarks       → daily closes of the ten largest coins, for the compare views
//   GET /binance-dashboard/<file>           → page.css, page.js, head.js, format.js, copy.js and the site's own files
//   GET /binance-dashboard/icons/token/:sym → coin marks
//
// A site customises the page without forking it: `siteDir` may hold `slots/<name>.html` (each replaces the
// `<!--slot:name-->…<!--/slot:name-->` block of page.html) and `static/<file>` (served under /binance-dashboard/, and
// favicon.svg / og.png at the root). Strings: a site script does Object.assign(BDCopy.en, { … }).
//
// Keys (read-only, "Enable Reading" only) sign requests on the server and never reach the browser:
//   BINANCE_API_KEY / BINANCE_API_SECRET (or BINANCE_DASHBOARD_API_KEY / _SECRET)
//   BYBIT_API_KEY / BYBIT_API_SECRET (or BYBIT_DASHBOARD_API_KEY / _SECRET), optional second account
// Without Binance keys the page is still served and the report answers 503 naming the missing variable.
//
// Cache: one report in RAM, warmed at start and rebuilt every cacheTtlMs while somebody opened the page in the last
// 10 minutes. A request that finds it older than 45 s gets the cached copy and kicks a background rebuild. A failed
// build starts a cool-down (20 s, or Binance's Retry-After when longer); the cached report keeps being served. Error
// bodies never carry upstream text (it can name the server's IP); the log keeps the details.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createClient, isRateLimit } from './core/binance.js';
import { createKlinesStore } from './core/klines.js';
import { createBenchmarksStore } from './core/benchmarks.js';
import { buildReports, DEFAULT_TITLE, type Report, type Reports } from './core/report.js';
import { createBybitClient } from './core/bybit.js';
import { isReportSource, type ReportSource } from './core/sources.js';
import { createTradesCache } from './core/trades-cache.js';
import { tokenIcon } from './core/icons.js';

type Env = Record<string, string | undefined>;
type CspDirective = 'script' | 'connect' | 'img' | 'child' | 'frame';

export interface TradingAnalyticsOptions {
  /** Where settings are read from (default process.env). */
  env?: Env;
  /** Page title and brand; default the TITLE env, then "Futures account". */
  title?: string;
  /** Shown in the header and footer; default the title. */
  brand?: string;
  /** Canonical origin, e.g. https://example.com; default from SITE_HOST (or LANDING_HOST), else the request's own host is unknown so http://localhost. */
  site?: string;
  /** Redirect www.<host> → <host> and api.<host>/ → <host>/ when set (default SITE_HOST / LANDING_HOST). */
  redirectHost?: string | null;
  /** The package's page files (default ../web next to this file). */
  webDir?: string;
  /** The site's own layer: slots/<name>.html and static/<file> (default SITE_DIR, else none). */
  siteDir?: string | null;
  /** Extra CSP hosts for third-party scripts the site adds (analytics and the like). */
  csp?: Partial<Record<CspDirective, string[]>>;
  /** Called with the merged report after every successful build (never awaited by requests). */
  onReport?: (report: Report, log: FastifyBaseLogger) => void | Promise<void>;
  /** Keep rebuilding on the TTL even without visitors (a site that reacts to new trades wants this). */
  alwaysWarm?: boolean;
  /** Serve a fixed report from this JSON file instead of calling the exchanges (DEMO=1 uses the bundled one). */
  demoReport?: string | null;
  buildReports?: typeof buildReports;
  createClient?: typeof createClient;
  createBybitClient?: typeof createBybitClient;
  /** Build the first report at registration (default true). Tests pass false. */
  warmUp?: boolean;
  /** Clock for cache age and the keep-warm window (default Date.now). */
  now?: () => number;
}

const PACKAGE_WEB = fileURLToPath(new URL('../web/', import.meta.url));
const BUNDLED_DEMO = fileURLToPath(new URL('../demo/report.json', import.meta.url));

export const STATIC_FILES = ['page.css', 'page.js', 'head.js', 'format.js', 'copy.js'] as const;
/** URL name → source file: the browser formatter is format.client.js so it can't shadow the server's format.ts. */
export const STATIC_SOURCES: Readonly<Record<string, string>> = { 'format.js': 'format.client.js' };

/** No inline script or style anywhere; the one hash covers the inline style a chart library puts on its attribution mark. */
export const STYLE_SRC = "'self' 'unsafe-hashes' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='";
export function buildCsp(extra: Partial<Record<CspDirective, string[]>> = {}): string {
  const add = (k: CspDirective) => (extra[k]?.length ? ' ' + extra[k]!.join(' ') : '');
  return `default-src 'none'; script-src 'self'${add('script')}; style-src ${STYLE_SRC}; font-src 'self'; connect-src 'self'${add('connect')}; img-src 'self' data:${add('img')}; child-src blob:${add('child')}; frame-src blob:${add('frame')}; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** A request that finds the report older than this serves the cache and kicks a background rebuild. */
export const SWR_AFTER_MS = 45_000;
/** The TTL timer keeps rebuilding while the page was opened this recently. */
export const KEEP_WARM_MS = 10 * 60_000;
/** JSON + gzip bodies are re-serialized at most once per bucket (cacheAgeMs granularity). */
export const SERIALIZE_BUCKET_MS = 5_000;
/** After a failed build no new one is started for this long — or for Binance's Retry-After when that is longer. */
export const FAILURE_COOLDOWN_MS = 20_000;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const typeOf = (name: string): string => CONTENT_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';
const etagOf = (body: Buffer): string => `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Public body of a report request that cannot be served: never upstream text. `retryAfterSeconds` only when known. */
const unavailable = (retryAfterSeconds: number | null): { error: 'binance_unavailable'; retryAfterSeconds?: number } =>
  retryAfterSeconds === null ? { error: 'binance_unavailable' } : { error: 'binance_unavailable', retryAfterSeconds };

interface StaticFile {
  body: Buffer;
  etag: string;
  type: string;
}
interface CacheEntry {
  /** The merged report and one per configured source, from one collection. */
  reports: Reports;
  at: number;
}

/** page.html with every `<!--slot:name-->…<!--/slot:name-->` block replaced by the site's slots/<name>.html when it has one. */
async function fillSlots(page: string, siteDir: string | null): Promise<string> {
  if (!siteDir) return page;
  return replaceAsync(page, /<!--slot:([a-z-]+)-->[\s\S]*?<!--\/slot:\1-->/g, async (block, name: string) => {
    const file = join(siteDir, 'slots', `${name}.html`);
    return existsSync(file) ? (await readFile(file, 'utf8')).replace(/\n$/, '') : block;
  });
}
async function replaceAsync(s: string, re: RegExp, fn: (m: string, ...groups: string[]) => Promise<string>): Promise<string> {
  const parts: Promise<string>[] = [];
  s.replace(re, (m, ...g) => { parts.push(fn(m, ...(g as string[]))); return m; });
  const done = await Promise.all(parts);
  let i = 0;
  return s.replace(re, () => done[i++] as string);
}

export async function tradingAnalytics(app: FastifyInstance, opts: TradingAnalyticsOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const webDir = opts.webDir ?? PACKAGE_WEB;
  const siteDir = opts.siteDir !== undefined ? opts.siteDir : env.SITE_DIR?.trim() || null;
  const title = opts.title ?? (env.TITLE?.trim() || env.BINANCE_DASHBOARD_TITLE?.trim() || DEFAULT_TITLE);
  const brand = opts.brand ?? (env.BRAND?.trim() || title);
  const host = opts.redirectHost !== undefined ? opts.redirectHost : env.SITE_HOST?.trim() || env.LANDING_HOST?.trim() || null;
  const site = opts.site ?? (host ? `https://${host}` : `http://localhost:${env.PORT ?? 3000}`);
  const csp = buildCsp(opts.csp);
  const pageHeaders = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
  const hit = { at: now() };   // registration counts as a hit: a deploy followed by a visit gets a fresh report

  // Replacer functions, not strings: `$&` / `$$` in an operator-set title must not be expanded by replaceAll.
  const filled = await fillSlots(await readFile(join(webDir, 'page.html'), 'utf8'), siteDir);
  const page = filled.replaceAll('__TITLE__', () => escapeHtml(title)).replaceAll('__BRAND__', () => escapeHtml(brand)).replaceAll('__ALIAS__', () => escapeHtml(title)).replaceAll('__SITE__', () => site);

  const statics = new Map<string, StaticFile>();
  const load = async (name: string, file: string): Promise<void> => {
    try {
      const body = await readFile(file);
      statics.set(name, { body, etag: etagOf(body), type: typeOf(name) });
    } catch (err) {
      app.log.warn({ err: errorMessage(err) }, `trading-analytics: ${name} is missing, answering 404`);
    }
  };
  for (const name of STATIC_FILES) await load(name, join(webDir, STATIC_SOURCES[name] ?? name));
  // the site's own files: served next to the package's, and they win on a clash
  const siteStatic = siteDir ? join(siteDir, 'static') : null;
  if (siteStatic && existsSync(siteStatic)) for (const name of await readdir(siteStatic)) if (/^[\w.-]+$/.test(name)) await load(name, join(siteStatic, name));
  const rootFile = async (name: string): Promise<StaticFile | null> => {
    for (const dir of [siteStatic, webDir]) {
      if (dir && existsSync(join(dir, name))) { const body = await readFile(join(dir, name)); return { body, etag: etagOf(body), type: typeOf(name) }; }
    }
    return null;
  };
  const favicon = await rootFile('favicon.svg');
  const og = await rootFile('og.png');

  const fonts = new Map<string, StaticFile>();
  try {
    for (const name of (await readdir(join(webDir, 'fonts'))).filter((n) => n.endsWith('.woff2'))) {
      const body = await readFile(join(webDir, 'fonts', name));
      fonts.set(name, { body, etag: etagOf(body), type: 'font/woff2' });
    }
  } catch (err) {
    app.log.warn({ err: errorMessage(err) }, 'trading-analytics: fonts/ is missing, system fonts will show');
  }

  const sendFile = (req: FastifyRequest, reply: FastifyReply, file: StaticFile | null | undefined, cache: string) => {
    if (!file) { reply.code(404); return { error: 'not_found' }; }
    reply.header('Cache-Control', cache).header('ETag', file.etag).header('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === file.etag) { reply.code(304).send(); return reply; }
    reply.type(file.type);
    return file.body;
  };

  // ---- the page, its files, robots / sitemap and the host redirects: served with or without keys ----
  if (host) {
    const apiHost = `api.${host}`, wwwHost = `www.${host}`;
    app.addHook('onRequest', async (req, reply) => {
      const h = String(req.headers.host ?? '').split(':')[0];
      const path = req.url.split('?')[0];
      if (h === wwwHost) { reply.code(301).header('Location', `${site}${req.url}`).send(); return reply; }
      if (h === apiHost && (path === '/' || path === '/binance-dashboard')) { reply.code(301).header('Location', `${site}/`).send(); return reply; }
      return undefined;
    });
  }
  app.get('/', async (_req, reply) => {
    hit.at = now();
    reply.headers(pageHeaders).type('text/html; charset=utf-8');
    return page;
  });
  app.get('/binance-dashboard', async (_req, reply) => { reply.code(301).header('Location', '/').send(); return reply; });
  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600');
    return `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`;
  });
  app.get('/sitemap.xml', async (_req, reply) => {
    reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=3600');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site}/</loc></url></urlset>\n`;
  });
  app.get('/favicon.svg', async (req, reply) => sendFile(req, reply, favicon, 'public, max-age=86400'));
  app.get('/og.png', async (req, reply) => sendFile(req, reply, og, 'public, max-age=86400'));
  app.get<{ Params: { name: string } }>('/binance-dashboard/fonts/:name', async (req, reply) => sendFile(req, reply, fonts.get(req.params.name), 'public, max-age=31536000, immutable'));
  // Coin marks: a symbol no source has answers 204 (the page keeps the coin's letter), cached for an hour.
  app.get<{ Params: { name: string } }>('/binance-dashboard/icons/token/:name', async (req, reply) => {
    const m = /^([A-Z0-9]{1,16})\.svg$/.exec(req.params.name);
    const icon = m ? await tokenIcon(m[1] as string) : null;
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!icon || icon === 'pending') {
      reply.code(204).header('Cache-Control', icon === 'pending' ? 'no-store' : 'public, max-age=3600');
      return;
    }
    reply.header('Cache-Control', 'public, max-age=604800, immutable').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type(icon.type);
    return icon.body;
  });
  app.get<{ Params: { name: string } }>('/binance-dashboard/:name', async (req, reply) => sendFile(req, reply, statics.get(req.params.name), 'public, max-age=300'));

  // ---- the report ----
  const demo = opts.demoReport !== undefined ? opts.demoReport : env.DEMO === '1' || env.DEMO === 'true' ? BUNDLED_DEMO : env.DEMO?.trim() || null;
  const apiKey = env.BINANCE_API_KEY?.trim() || env.BINANCE_DASHBOARD_API_KEY?.trim();
  const apiSecret = env.BINANCE_API_SECRET?.trim() || env.BINANCE_DASHBOARD_API_SECRET?.trim();
  if (demo) {
    const body = await readFile(demo, 'utf8');
    const gz = gzipSync(body);
    app.log.info(`trading-analytics: demo mode, serving ${demo}`);
    app.get('/binance-dashboard/report', async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Vary', 'Accept-Encoding').type('application/json; charset=utf-8');
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { reply.header('Content-Encoding', 'gzip'); return gz; }
      return body;
    });
    app.get('/binance-dashboard/benchmarks', async () => ({ coins: [] }));
    return;
  }
  if (!apiKey || !apiSecret) {
    const missing = [!apiKey && 'BINANCE_API_KEY', !apiSecret && 'BINANCE_API_SECRET'].filter(Boolean).join(', ');
    app.log.warn(`trading-analytics: report disabled, ${missing} not set; the page is still served (DEMO=1 shows sample data)`);
    app.get('/binance-dashboard/report', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.code(503);
      return { error: 'binance_dashboard_not_configured', missing };
    });
    app.get('/binance-dashboard/benchmarks', async () => ({ coins: [] }));
    return;
  }

  const build = opts.buildReports ?? buildReports;
  const client = (opts.createClient ?? createClient)(apiKey, apiSecret);
  const bybitKey = env.BYBIT_API_KEY?.trim() || env.BYBIT_DASHBOARD_API_KEY?.trim();
  const bybitSecret = env.BYBIT_API_SECRET?.trim() || env.BYBIT_DASHBOARD_API_SECRET?.trim();
  const bybitHost = env.BYBIT_HOST?.trim() || env.BYBIT_DASHBOARD_HOST?.trim();
  const bybit = bybitKey && bybitSecret ? (opts.createBybitClient ?? createBybitClient)(bybitKey, bybitSecret, bybitHost ? { host: bybitHost } : {}) : null;
  if (!bybit) app.log.info('trading-analytics: Bybit off (BYBIT_API_KEY / BYBIT_API_SECRET not set)');
  const ttlSeconds = Number(env.CACHE_TTL_SECONDS ?? env.BINANCE_DASHBOARD_CACHE_TTL_SECONDS ?? 60);
  const cacheTtlMs = (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60) * 1000;
  const tradesLookbackDays = Math.min(90, Math.max(1, Number(env.TRADES_DAYS ?? env.BINANCE_DASHBOARD_TRADES_DAYS ?? 30) || 30));
  const inceptionEnv = env.INCEPTION ?? env.BINANCE_DASHBOARD_INCEPTION;
  const inceptionDate = inceptionEnv && /^\d{4}-\d{2}-\d{2}$/.test(inceptionEnv) ? inceptionEnv : undefined;
  if (inceptionEnv && !inceptionDate) app.log.warn(`INCEPTION="${inceptionEnv}" is not YYYY-MM-DD; using the first income day`);
  const dataStartEnv = env.DATA_START?.trim();
  const dataStart = dataStartEnv && /^\d{4}-\d{2}-\d{2}$/.test(dataStartEnv) ? dataStartEnv : undefined;
  if (dataStartEnv && !dataStart) app.log.warn(`DATA_START="${dataStartEnv}" is not YYYY-MM-DD; counting the whole history`);
  const buildOpts = { tradesLookbackDays, klines: createKlinesStore(), tradesCache: createTradesCache(), cacheTtlMs, inceptionDate, dataStart, title, bybit, bybitMemo: { last: null }, copyTrading: { binance: env.BINANCE_COPY_PORTFOLIO_ID?.trim() || undefined, bybit: env.BYBIT_COPY_LEADER_MARK?.trim() || undefined } };

  let cached: CacheEntry | null = null;
  let inflight: Promise<void> | null = null;
  /** The last failed build, until a build succeeds. `retryAfterSeconds` = Binance's Retry-After of a 418 / 429 / -1003. */
  let failure: { at: number; retryAfterSeconds: number | null } | null = null;
  const serialized = new Map<ReportSource, { key: string; body: string; gz: Buffer }>();

  /** Whole seconds left of the cool-down after a failed build; 0 when none is running. */
  function cooldownLeftSeconds(): number {
    if (!failure) return 0;
    const wait = Math.max(FAILURE_COOLDOWN_MS, (failure.retryAfterSeconds ?? 0) * 1000);
    const left = failure.at + wait - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function refresh(): Promise<void> {
    // allowMissingFills: only the very first build (nothing cached to fall back on) may degrade to a report without fills.
    inflight ??= build(client, { ...buildOpts, allowMissingFills: cached === null })
      .then((reports) => {
        cached = { reports, at: now() };
        failure = null;
        const bybitWarnings = reports.all.meta.warnings.filter((w) => /^bybit/i.test(w));
        if (bybitWarnings.length) app.log.warn({ warnings: bybitWarnings.map((w) => w.slice(0, 300)) }, 'bybit source degraded');
        if (opts.onReport) Promise.resolve().then(() => opts.onReport!(reports.all, app.log)).catch((e) => app.log.warn({ err: errorMessage(e) }, 'onReport failed'));
      })
      .catch((err: unknown) => {
        failure = { at: now(), retryAfterSeconds: isRateLimit(err) ? (err.retryAfterSeconds ?? null) : null };
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function refreshInBackground(log: FastifyBaseLogger): void {
    if (cooldownLeftSeconds() > 0) return;   // a build just failed: the warm-up, the SWR kick and the TTL timer all wait it out
    refresh().catch((err) => {
      log.error({ err: errorMessage(err), cooldownSeconds: cooldownLeftSeconds() }, cached ? 'report refresh failed; serving the cached report' : 'report warm-up failed');
    });
  }

  /** JSON + gzip of one slice of `entry` with meta.cacheAgeMs patched; memoised per slice, report and 5-second age bucket. */
  function serialize(entry: CacheEntry, source: ReportSource): { body: string; gz: Buffer } {
    const report = entry.reports[source] ?? entry.reports.all;
    const age = Math.max(0, now() - entry.at);
    const key = `${report.generatedAt}|${Math.floor(age / SERIALIZE_BUCKET_MS)}`;
    const memo = serialized.get(source);
    if (memo && memo.key === key) return memo;
    const body = JSON.stringify({ ...report, meta: { ...report.meta, cacheAgeMs: age } });
    const made = { key, body, gz: gzipSync(body) };
    serialized.set(source, made);
    return made;
  }

  if (opts.warmUp !== false) refreshInBackground(app.log);
  const timer = setInterval(() => {
    if (opts.alwaysWarm || now() - hit.at < KEEP_WARM_MS) refreshInBackground(app.log);
  }, cacheTtlMs);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  // daily closes of the ten largest coins for the compare views
  const benchmarks = createBenchmarksStore(6 * 60 * 60 * 1000, (m) => app.log.warn(m));
  app.get('/binance-dashboard/benchmarks', async (_req, reply) => {
    const data = await benchmarks.get(client, now());
    reply.header('Cache-Control', data.coins.length ? 'public, max-age=3600' : 'no-store').header('X-Content-Type-Options', 'nosniff').type('application/json; charset=utf-8');
    return data;
  });

  app.get<{ Querystring: { source?: string } }>('/binance-dashboard/report', async (req, reply) => {
    hit.at = now();
    const source: ReportSource = isReportSource(req.query.source) ? req.query.source : 'all';
    reply.header('Cache-Control', 'no-store').header('Vary', 'Accept-Encoding').header('X-Content-Type-Options', 'nosniff').type('application/json; charset=utf-8');
    let entry = cached;
    if (entry) {
      if (now() - entry.at > SWR_AFTER_MS) refreshInBackground(req.log);
    } else {
      const left = cooldownLeftSeconds();
      if (left > 0) { reply.code(503).header('Retry-After', String(left)); return unavailable(left); }
      try {
        await refresh();
      } catch (err) {
        req.log.error({ err: errorMessage(err), cooldownSeconds: cooldownLeftSeconds() }, 'report failed');
        reply.code(502);
        return unavailable(isRateLimit(err) && err.retryAfterSeconds !== undefined ? cooldownLeftSeconds() : null);
      }
      entry = cached;
      if (!entry) { reply.code(502); return unavailable(null); }
    }
    const { body, gz } = serialize(entry, source);
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { reply.header('Content-Encoding', 'gzip'); return gz; }
    return body;
  });
}

export default tradingAnalytics;
export { buildReports, DEFAULT_TITLE } from './core/report.js';
export type { Report, Reports } from './core/report.js';
