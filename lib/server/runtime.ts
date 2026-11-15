/**
 * Process runtime: config, database, providers and the engine context, created once by server.ts (or the CLI/tests)
 * and shared with the Next.js route handlers through shared.ts.
 *
 * The bind check lives here: loadConfig refuses any non-loopback HOST unless real OIDC is configured and the test
 * bypass is off. Route handlers never create the runtime themselves, because only server.ts knows the real bind
 * address. Running plain `next dev` therefore fails closed (503) instead of serving on an unchecked interface.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, loadEnvFile, type Config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { RecallService } from './recall.ts';
import { MediaStore } from './media.ts';
import { SandboxProvider } from './channel.ts';
import { OidcVerifier } from './auth.ts';
import { createModelProvider, type ModelProvider } from './providers.ts';
import { handleEvent, type Ctx } from './engine.ts';
import { pump } from './events.ts';
import { shared } from './shared.ts';

export interface Runtime {
  root: string;
  cfg: Config;
  db: Db;
  recall: RecallService;
  provider: SandboxProvider;
  ai: ModelProvider | null;
  media: MediaStore;
  verifier: OidcVerifier;
  ctx: Ctx;
  /** Customer pages (reply, garage) are served only on a loopback bind. See docs/SECURITY.md. */
  customerPagesEnabled: boolean;
}

/** Request header carrying the socket peer address from server.ts to route handlers. server.ts always overwrites it. */
export const PEER_HEADER = 'x-loyalty-peer';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const slot = shared<{ rt: Runtime | null }>('runtime', () => ({ rt: null }));

export function initRuntime(root: string): Runtime {
  if (slot.rt) return slot.rt;
  loadEnvFile(join(root, '.env'));
  const cfg = loadConfig();
  const dataDir = resolve(root, cfg.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'loyalty.db'));
  const provider = new SandboxProvider();
  const ai = createModelProvider(cfg.ai);
  const recall = new RecallService(db, cfg.recallMode);
  slot.rt = {
    root, cfg, db, recall, provider, ai,
    media: new MediaStore(dataDir, db),
    verifier: new OidcVerifier(cfg.oidc),
    ctx: { db, cfg, recall, provider, ai },
    customerPagesEnabled: LOOPBACK.has(cfg.host),
  };
  return slot.rt;
}

export class RuntimeNotStarted extends Error {
  constructor() {
    super('server runtime not initialised: start the app with "npm run dev" or "npm start" (server.ts), not "next dev"');
  }
}

export function runtime(): Runtime {
  if (!slot.rt) throw new RuntimeNotStarted();
  return slot.rt;
}

export function closeRuntime(): void {
  slot.rt?.db.close();
  slot.rt = null;
}

/** Drains the event inbox through the engine (one transaction per event). */
export function runPump(rt: Runtime = runtime()) {
  return pump(rt.db, (ev) => handleEvent(rt.ctx, ev), 200);
}
