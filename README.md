# trading-analytics

A live, public analytics page for a Binance (and optionally Bybit) USDⓈ-M futures account, built from read-only API keys.

It shows what exchanges don't: the result after fees and funding, where the fees went, drawdown and risk next to simply
holding Bitcoin, open positions with their stops, targets and capital load, results by day, coin, hour and holding time,
win and loss streaks, and every closed trade. English and Russian, dark, no tracking, no build step for the page.

## Start in one command

```bash
git clone https://github.com/debut-js/trading-analytics.git
cd trading-analytics
cp .env.example .env        # put your read-only keys in
npm install && npm run build && npm start
```

Open http://localhost:3000.

No keys yet? `npm run demo` serves a bundled sample report.

With Docker: `cp .env.example .env`, fill it in, then `docker compose up -d`.

### Keys

Create **read-only** keys:

- **Binance**: API Management → Create API → tick only *Enable Reading*. IP restriction is recommended.
- **Bybit** (optional): API → Create New Key → System-generated → *Read-Only*.

The keys stay on the server. The browser only ever gets the computed report.

## Settings

All settings live in `.env`. See `.env.example` for the full list.

| Variable | What it does |
|---|---|
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | The account. Without them the page loads and says the report is not configured. |
| `BYBIT_API_KEY`, `BYBIT_API_SECRET` | A second account on Bybit. The page gets an exchange filter. |
| `TITLE`, `BRAND` | Page title, and the name in the header. |
| `SITE_HOST` | Canonical host for links and the sitemap. |
| `DATA_START` | Ignore everything before this UTC day. |
| `TRADES_DAYS` | Days of fills used to rebuild trades, 1–90 (default 30). |
| `CACHE_TTL_SECONDS` | How often the report is rebuilt while someone has the page open (default 60). |
| `SITE_DIR` | Your own layer over the page (below). |
| `DEMO` | `1` serves the bundled sample report. A path serves your own report JSON. |
| `BINANCE_COPY_PORTFOLIO_ID`, `BYBIT_COPY_LEADER_MARK` | Lead traders only. Show how many accounts copy you. |

## Make it yours without forking

Point `SITE_DIR` at a folder:

```
site/
  slots/
    meta.html        <title>, description, Open Graph
    head.html        extra <script src="/binance-dashboard/site.js"> etc.
    body-start.html  anything right after <body>
    brand.html       the header's logo and name
    nav.html         extra header links
    hero-copy.html   the headline, the lead and your buttons
    bar-cta.html     a button in the sticky filter bar
    sections.html    your own sections after Risk
    foot-brand.html  the footer's name
  static/
    site.js          served at /binance-dashboard/site.js
    og.png           served at /og.png
    favicon.svg      served at /favicon.svg
```

Each `slots/<name>.html` replaces the `<!--slot:name-->…<!--/slot:name-->` block of `web/page.html`. A missing slot keeps
the default.

To change texts, load a script through `head.html` and merge into the strings:

```js
Object.assign(window.BDCopy.en, { h1: 'My account', sub: 'Every trade, live.' });
Object.assign(window.BDCopy.ru, { h1: 'Мой счёт' });
```

Third-party scripts need their hosts in the CSP. Pass them through the plugin's `csp` option.

## Use it inside your own Fastify app

```ts
import Fastify from 'fastify';
import { tradingAnalytics } from 'trading-analytics';

const app = Fastify();
await app.register(tradingAnalytics, {
  title: 'My account',
  siteDir: './site',
  csp: { script: ['https://analytics.example.com'], connect: ['https://analytics.example.com'] },
  onReport: (report) => { /* react to new trades, post them somewhere… */ },
  alwaysWarm: true,
});
await app.listen({ port: 3000 });
```

Install from GitHub at a tag: `npm i github:debut-js/trading-analytics#v0.1.0`.

## How it works

- `src/core/`: the exchange clients and the analytics. Trades are rebuilt from fills, and returns are time-weighted so
  deposits don't count as profit. Drawdowns, windows, insights and capital load are all computed here.
- `src/plugin.ts`: the Fastify plugin. It serves the page with a strict CSP and keeps one report in memory. The report is
  rebuilt in the background while someone is looking, and the last good one is served when an exchange has a bad moment.
- `web/`: the page. Plain HTML, CSS and JS, no framework and no build step.

API usage stays well inside Binance's limits. A report costs about 1000 of the 2400 weight per minute, and visitors share
one build.

## License

MIT
