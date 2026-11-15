# Security notes

## Exposure

- The server binds `HOST`, default **`127.0.0.1`**. `loadConfig` refuses any non-loopback host unless
  `ALLOW_NON_LOOPBACK=1` **and** `OIDC_ISSUER` is set **and** `AUTH_TEST_BYPASS` is not set.
- The customer reply page and reply-link creation are **disabled whenever the bind is not loopback**. Making them
  reachable by customers needs a reviewed customer-facing authentication mechanism and a security review first.
  The capability link is a demo convenience, not that mechanism.
- Start the app only through `server.ts` (`npm run dev` / `npm start`). It owns the bind check and creates the runtime
  that route handlers use. Plain `next dev` / `next start` serve no data: every API route returns 503.
- No container, port publishing or tunnel config ships with the project. To reach it from another machine, use an
  SSH local port-forward (`ssh -L 8787:127.0.0.1:8787 host`), not a wider bind.

## Staff authentication

| Mode | How | When |
|---|---|---|
| OIDC (real) | `Authorization: Bearer <JWT>`; RS256 only; verified against `OIDC_JWKS_URL` with issuer, audience, `exp`, `nbf`; `sub` must match a row in `users` | Any shared deployment |
| Fail-closed | No `OIDC_ISSUER` and no bypass: every staff request is 401 | Default if not configured |
| Dev bypass | `AUTH_TEST_BYPASS=1`: `X-Dev-User: <seeded sub>` header. Loopback only. `DEV_TOOLS=1` also requires it | Local demo only |

Authorization is a role × action matrix (`lib/server/auth.ts`) plus rooftop scoping on every query. Analysts and support
never receive customer names, phone numbers, drafts or message bodies. Approvers cannot approve their own edit
(four-eyes rule).

## Machine callers

- `/webhooks/tekion` and `/webhooks/channel`: HMAC-SHA256 over `timestamp.body`, 300 s tolerance, constant-time
  compare, idempotent on event or message id, rate limited. The Tekion signing scheme is an **assumption**:
  partner docs were not available. Replace it with Tekion's real scheme when you onboard.

## Data handling

- Phone and email are matched via HMAC (`HMAC_SECRET`) hashes. Raw values are stored for sending (synthetic in the demo).
- **Third-party AI vendor.** With `AI_PROVIDER=gemini|openai`, data leaves the machine for Google or OpenAI:
  - PII-redacted text: replies, garage questions, technician stories for embeddings.
  - Grounded facts: vehicle, mileage, services, costs. No name, phone or email.
  - **Customer photos and audio, sent as-is**. Images have EXIF/GPS stripped first. Media can contain faces,
    plates or voices that redaction cannot remove.

  Get a data-processing agreement and choose the vendor's no-training / zero-retention tier before using real
  customer data. With `AI_PROVIDER=off`, nothing is sent.
- API keys live only in `.env`. They go in request headers (`x-goog-api-key` or `Authorization`), never in URLs.
  Provider errors carry only the HTTP status, so a key can never appear in an error or log. The `ai_calls` ledger
  stores capability, prompt id, model, a hash of the input (not the prompt), the validated output, latency and
  validation result.
- The model cannot lower a rules urgency floor or clear a safety flag. Critical faults always get the fixed template.
- Uploads: type is decided by magic bytes (JPEG/PNG/WebP, MP3/MP4/WAV/WebM/Ogg), size caps apply, and JPEG EXIF/GPS
  is stripped. Files are served to staff with `Content-Security-Policy: sandbox`. Images are kept 90 days and audio
  30 days, then purged.
- Audit log: append-only (DB triggers) and hash-chained. Check it with `npm run audit`.
- Security headers on every response: `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, CORP `same-origin`.
  API responses carry CSP `default-src 'none'` (`lib/api/http.ts`). Pages get a per-request nonce CSP from `proxy.ts`
  (`script-src 'self' 'nonce-…' 'strict-dynamic'`; `style-src` allows inline styles for React style attributes; dev mode
  adds `'unsafe-eval'` for React's dev tooling).
- Next.js telemetry is disabled by `server.ts` and the build script.
- Secrets: `.env` is gitignored and mode 600. `npm run init` generates random values and never prints them. No
  credential appears in any committed file.

## Before any non-local use

1. Wire OIDC to the dealer-group IdP and remove `AUTH_TEST_BYPASS`/`DEV_TOOLS` from the environment.
2. Choose and review a customer authentication mechanism for the reply page **and the Digital Garage**
   (`/garage/:token`, `/api/garage/*`). Both use the same capability link, which is a demo stand-in, not reviewed
   customer auth. They are disabled on any non-loopback bind and rate limited.
3. Sign a DPA with the AI vendor and enable zero data retention, or keep `AI_PROVIDER=off`.
4. Replace the assumed Tekion HMAC scheme with the partner's documented one.
5. Put TLS in front, move SQLite to Postgres with RLS, and move secrets to a secret store.
