// Entry point. Crashes loudly on bad config; the container restarts and Docker's health check reports it.
import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.ts';
import { createApp } from './app.ts';

process.on('uncaughtException', (err) => { console.error(new Date().toISOString(), 'FATAL uncaught', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(new Date().toISOString(), 'FATAL unhandled rejection', err); process.exit(1); });

const env = (key: string, fallback: string) => process.env[key] ?? fallback;
const int = (key: string, fallback: number) => {
  const value = Number(env(key, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return value;
};

const dataDir = env('DATA_DIR', './data');
mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, 'diff.db'));

const handle = createApp(store, {
  publicDir: env('PUBLIC_DIR', './dist/public'),
  mintsPerIpPerDay: int('MINTS_PER_IP_PER_DAY', 100),
  mintsPerDay: int('MINTS_PER_DAY', 2000),
  savesPerIpPerMinute: int('SAVES_PER_IP_PER_MINUTE', 120),
  readsPerIpPerMinute: int('READS_PER_IP_PER_MINUTE', 600),
  maxDiffKb: int('MAX_DIFF_KB', 1024), // ~1 MB: around 400 pages of prose, Before and After together
  maxDbBytes: int('MAX_DB_BYTES', 2 * 1024 ** 3),
  secureCookies: env('SECURE_COOKIES', 'true') === 'true',
});

const port = int('PORT', 8080);
// Slow or idle clients are dropped fast, and open connections are capped: each may buffer a request body of
// up to about 2 MB, so 64 of them stay well inside the container's 256 MB.
const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, handle);
server.maxConnections = int('MAX_CONNECTIONS', 64);
server.listen(port, () => console.log(new Date().toISOString(), `diff listening on :${port}`));

const shutdown = () => server.close(() => { store.db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
