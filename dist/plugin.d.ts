import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { createClient } from './core/binance.js';
import { buildReports, type Report } from './core/report.js';
import { createBybitClient } from './core/bybit.js';
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
export declare const STATIC_FILES: readonly ["page.css", "page.js", "head.js", "format.js", "copy.js"];
/** URL name → source file: the browser formatter is format.client.js so it can't shadow the server's format.ts. */
export declare const STATIC_SOURCES: Readonly<Record<string, string>>;
/** No inline script or style anywhere; the one hash covers the inline style a chart library puts on its attribution mark. */
export declare const STYLE_SRC = "'self' 'unsafe-hashes' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='";
export declare function buildCsp(extra?: Partial<Record<CspDirective, string[]>>): string;
/** A request that finds the report older than this serves the cache and kicks a background rebuild. */
export declare const SWR_AFTER_MS = 45000;
/** The TTL timer keeps rebuilding while the page was opened this recently. */
export declare const KEEP_WARM_MS: number;
/** JSON + gzip bodies are re-serialized at most once per bucket (cacheAgeMs granularity). */
export declare const SERIALIZE_BUCKET_MS = 5000;
/** After a failed build no new one is started for this long — or for Binance's Retry-After when that is longer. */
export declare const FAILURE_COOLDOWN_MS = 20000;
export declare function tradingAnalytics(app: FastifyInstance, opts?: TradingAnalyticsOptions): Promise<void>;
export default tradingAnalytics;
export { buildReports, DEFAULT_TITLE } from './core/report.js';
export type { Report, Reports } from './core/report.js';
