import { existsSync, readFileSync } from 'node:fs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Environment shape read by the config loaders (process.env or a test override). */
export type Env = Record<string, string | undefined>;

export type AiProviderName = 'gemini' | 'openai' | 'off';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  publicBaseUrl: string;
  hmacSecret: string;
  tekionWebhookSecret: string;
  channelWebhookSecret: string;
  authTestBypass: boolean;
  devTools: boolean;
  oidc: { issuer: string; audience: string; jwksUrl: string };
  ai: AiConfig;
  recallMode: 'live' | 'mock';
  limits: { jsonBytes: number; imageBytes: number; audioBytes: number };
  quietHours: { startHour: number; endHour: number };
}

/**
 * Model-provider settings. Endpoints are fixed to the vendors' public API hosts: no env override, so a
 * misconfigured variable can never send API keys or customer media to an arbitrary host.
 */
export interface AiConfig {
  provider: AiProviderName;
  timeoutMs: number;
  gemini: { apiKey: string; model: string; embedModel: string; baseUrl: string };
  openai: { apiKey: string; model: string; audioModel: string; embedModel: string; baseUrl: string };
}

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const OPENAI_BASE = 'https://api.openai.com/v1';

/** Minimal .env reader (no dotenv dependency). Existing env vars win. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing ${name}. Run "npm run init" to create .env, or export it.`);
  return v;
}

export function loadAiConfig(env: Env): AiConfig {
  const raw = (env.AI_PROVIDER ?? 'off').trim().toLowerCase();
  if (raw !== 'gemini' && raw !== 'openai' && raw !== 'off') throw new Error(`AI_PROVIDER must be gemini, openai or off (got "${raw}")`);
  const provider = raw as AiProviderName;
  const geminiKey = env.GEMINI_API_KEY ?? '';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  if (provider === 'gemini' && !geminiKey) throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY in .env');
  if (provider === 'openai' && !openaiKey) throw new Error('AI_PROVIDER=openai requires OPENAI_API_KEY in .env');
  return {
    provider,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30_000),
    gemini: {
      apiKey: geminiKey,
      // gemini-2.5-* is closed to new API keys (Google returns 404 and points to 3.x). Override with GEMINI_MODEL.
      model: env.GEMINI_MODEL ?? 'gemini-3.8-flash',
      embedModel: env.GEMINI_EMBED_MODEL ?? 'gemini-embedding-001',
      baseUrl: GEMINI_BASE,
    },
    openai: {
      apiKey: openaiKey,
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
      // Audio-input chat model: hears the sound itself (squeal vs grind), not just speech.
      audioModel: env.OPENAI_AUDIO_MODEL ?? 'gpt-4o-audio-preview',
      embedModel: env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small',
      baseUrl: OPENAI_BASE,
    },
  };
}

export function loadConfig(env: Env = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  const bypass = env.AUTH_TEST_BYPASS === '1';
  const issuer = env.OIDC_ISSUER ?? '';
  // Non-loopback binds are only allowed with real OIDC and no test bypass (builder-security: never stub + 0.0.0.0).
  if (!LOOPBACK.has(host) && (bypass || !issuer || env.ALLOW_NON_LOOPBACK !== '1')) {
    throw new Error(`Refusing to bind ${host}. Loopback only unless ALLOW_NON_LOOPBACK=1 with OIDC_ISSUER set and AUTH_TEST_BYPASS unset.`);
  }
  const jwksUrl = env.OIDC_JWKS_URL ?? (issuer ? `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs` : '');
  return {
    host,
    port: Number(env.PORT ?? 8787),
    dataDir: env.DATA_DIR ?? 'data',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://${host.includes(':') ? `[${host}]` : host}:${Number(env.PORT ?? 8787)}`,
    hmacSecret: required(env, 'HMAC_SECRET'),
    tekionWebhookSecret: required(env, 'TEKION_WEBHOOK_SECRET'),
    channelWebhookSecret: required(env, 'CHANNEL_WEBHOOK_SECRET'),
    authTestBypass: bypass,
    devTools: env.DEV_TOOLS === '1' && bypass,
    oidc: { issuer, audience: env.OIDC_AUDIENCE ?? '', jwksUrl },
    ai: loadAiConfig(env),
    recallMode: env.RECALL_MODE === 'live' ? 'live' : 'mock',
    limits: { jsonBytes: 1_000_000, imageBytes: 15 * 1024 * 1024, audioBytes: 10 * 1024 * 1024 },
    quietHours: { startHour: 8, endHour: 21 },
  };
}
