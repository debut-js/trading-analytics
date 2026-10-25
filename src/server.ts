#!/usr/bin/env node
// The standalone server: `npm start` reads .env (when there is one), serves the page and the report on PORT (default 3000).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { tradingAnalytics } from './plugin.js';

/** A minimal .env reader: KEY=value lines, # comments, optional quotes. Variables already set win. */
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1] as string;
    let value = m[2] as string;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(resolve(process.cwd(), '.env'));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
await app.register(tradingAnalytics);
await app.listen({ port, host });
app.log.info(`trading-analytics on http://localhost:${port}`);
