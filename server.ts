/**
 * Entrypoint: one Node process serves the Next.js app (pages + API route handlers) and runs the background loops.
 *
 * Exposure: binds cfg.host (default 127.0.0.1). loadConfig refuses a non-loopback HOST unless OIDC is configured,
 * ALLOW_NON_LOOPBACK=1 and AUTH_TEST_BYPASS is unset. Do not use `next dev -H ...` instead of this file: the route
 * handlers depend on the runtime created here and return 503 without it.
 */
import { createServer } from 'node:http';
import next from 'next';
import { initRuntime, closeRuntime, PEER_HEADER } from './lib/server/runtime.ts';
import { startScheduler } from './lib/server/scheduler.ts';
import { drainBackground } from './lib/server/background.ts';
import { clock } from './lib/server/clock.ts';

// No usage telemetry leaves the machine unless the operator opts in.
process.env.NEXT_TELEMETRY_DISABLED ??= '1';

const ROOT = import.meta.dirname;
const dev = !process.argv.includes('--prod');
const rt = initRuntime(ROOT);
const { host, port } = rt.cfg;

const app = next({ dev, dir: ROOT, hostname: host, port, turbopack: false, webpack: true });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  // Overwrite (never trust) any client-supplied value.
  req.headers[PEER_HEADER] = req.socket.remoteAddress ?? '';
  handle(req, res).catch((err: unknown) => {
    console.error('[server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  });
});
// Keep slow clients from holding sockets open.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.maxHeadersCount = 100;
if (dev) {
  const upgrade = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head); });
}

const stopScheduler = startScheduler(rt);

server.listen(port, host, () => {
  const bypass = rt.cfg.authTestBypass ? ' [AUTH_TEST_BYPASS=1: dev identities enabled, NOT for shared hosts]' : '';
  console.log(`Loyalty orchestrator (${dev ? 'dev' : 'production'}) on http://${host}:${port}${bypass}`);
  console.log(`Clock offset ${clock.offsetMs()} ms · provider ${rt.provider.name} · recall ${rt.cfg.recallMode} · AI ${rt.ai ? `${rt.ai.name} ${rt.ai.textModel}` : 'off (rules only)'}`);
});

const shutdown = () => {
  stopScheduler();
  setTimeout(() => process.exit(0), 3000).unref();
  // Let in-flight AI and embedding jobs finish before the database closes.
  server.close(() => {
    void drainBackground().finally(() => {
      closeRuntime();
      process.exit(0);
    });
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
