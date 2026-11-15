# Post-Purchase Loyalty Journey Orchestrator (MVP)

Local MVP of the design in `tekion-loyalty-hld/HLD.md`, built as one **Next.js** app (UI + API). After a vehicle sale, it turns dealer DMS events into
**one well-timed, consented, human-approved message at a time** (service due, recall, declined-work follow-up,
warranty, insurance, loan end, review). Customers can reply by text, photo or engine-sound recording, and safety
replies reach an advisor immediately.

**Stack.** Next.js 16 (App Router, React 19) for the staff console, customer pages and API route handlers, served by a
small custom Node server (`server.ts`) that owns the loopback bind check and the background loops. The backend core
(`lib/server/`) has no third-party dependencies: Node 24 built-ins only (`node:sqlite`, `node:crypto`, `node:test`).
**Synthetic data only.**

## Run

```bash
node --version          # needs v24+
npm install             # Next.js + React (registry pinned to public npm in .npmrc)
npm run init            # writes .env with random secrets (mode 600, gitignored, never printed)
npm run seed            # creates data/loyalty.db with 80 synthetic customers and scenarios
npm run dev             # http://127.0.0.1:8787 (dev, hot reload)
# or: npm run build && npm start   (production)
```

Open http://127.0.0.1:8787 and pick a demo identity (top right). Try:

1. **Queue**: approve, edit (guardrails apply), reject with a reason, or snooze.
2. **Cases**: the P1 safety case from customer 30 ("brakes feel like they fail").
3. **Customers**: search `P-0003`, open the 360 view, **Create customer link**, open the reply-page link, send a message, upload a
   photo. Try the reply `my brakes failed` to see the fixed safety template.
4. **Dev** (as Demo Group Admin): move the clock forward 180 days, then **Run pump and evaluate all** to see new
   service-due items. Simulate inbound texts (`STOP`, `sold`, `snooze 3 months`).
5. Switch to **Demo Analyst**: names, drafts and message bodies are hidden.

To reseed, stop the server, delete `data/` yourself, then `npm run seed`.

Continuum features:

6. **Digital Garage**: **Create customer link** also prints a `/garage/<token>` URL. It shows the vehicle
   passport, an OEM maintenance roadmap with costs, equity, loyalty tier, recalls, chat grounded in those facts,
   photo or engine-sound upload for triage, and a booking request.
7. **Churn**: staff dashboard shows RFM-D risk tiers, revenue at risk and named drivers. HIGH-tier customers get a
   win-back draft ($40 Loyalty Service Voucher) in the approval queue. It is never auto-sent.
8. **Closed loop**: `ro.closed` events carrying a `technician_story` are stored, embedded by the vendor and used as
   precedents for new complaints (`/api/opps/:id/precedents`). AI accuracy vs. technician overrides is at
   `/api/analytics/accuracy`.

## AI (Gemini or OpenAI, switchable)

The model is a hosted vendor API, chosen with `AI_PROVIDER` in `.env`. No local models.

```bash
AI_PROVIDER=gemini            # gemini | openai | off (default off)
GEMINI_API_KEY=...            # required when AI_PROVIDER=gemini
OPENAI_API_KEY=...            # required when AI_PROVIDER=openai
# Optional overrides (defaults shown)
GEMINI_MODEL=gemini-3.8-flash        GEMINI_EMBED_MODEL=gemini-embedding-001
# If the default returns 503 (high demand), gemini-3.5-flash-lite was responsive when this was tested.
OPENAI_MODEL=gpt-4o-mini             OPENAI_EMBED_MODEL=text-embedding-3-small
OPENAI_AUDIO_MODEL=gpt-4o-audio-preview
AI_TIMEOUT_MS=30000
```

Startup fails if the selected provider has no key. Keys are sent only in request headers and never logged.

How the model is used: reply intent classification, photo triage (vision), engine-sound triage (audio), draft
rewording, garage chat, diagnostic hypotheses and embeddings for technician-story retrieval. Every call goes through
one gateway (`lib/server/ai.ts`). The gateway validates the JSON against a schema, retries once with the rejection reason,
writes a row to the `ai_calls` ledger, and falls back to rules or templates on failure.

What the model can never do: lower a rules urgency floor or clear a safety flag. Critical faults (brake hydraulic,
fire, fuel leak, steering bind) always force P1 and the fixed safety template. A generated draft or chat answer is
used only if it passes `checkDraft`: every number must appear in the facts, there are no banned phrases, and it
contains no unlisted URLs or phone numbers.

If you switch embedding model, stories are re-embedded into a separate vector store. Vectors from different models
are never mixed.

## Check

```bash
npm test                # 78 tests: core, DB, Continuum (vector, churn, OEM, triage, gateway, vendor request shapes), closed loop
npm run eval            # 28 deterministic scenario checks on a fresh in-memory seed (+ live vendor checks if AI_PROVIDER is set)
npm run audit           # verify the audit hash chain
npm run typecheck       # tsc --noEmit over the whole project
```

**Quiet hours** (08:00–21:00 customer-local) never empty the queue. Staff can approve at any hour; a service or marketing
message approved at night is held and sent at 08:00 in the customer's time zone (each queue card shows the customer's
local time and when it would send). Safety messages are never held. Tests pin the clock, so they pass at any hour.

Tests never hit the network. Vendors are tested with a fake `fetch` (request shape, header-only key, JSON mode,
timeouts, error redaction) and a scripted model (retry, fallback, safety override). With `AI_PROVIDER` set,
`npm run eval` also runs a **live** section against the real vendor. It embeds the seeded stories, retrieves the
brake-pad precedent for a reworded complaint, validates a diagnosis, checks a grounded garage-chat answer and the
safety template, and confirms the ledger. These are integration smoke checks, not a model-quality benchmark.

## Layout

| Path | What |
|---|---|
| `server.ts` | Entrypoint: loopback bind check, runtime, Next.js request handler, background loops |
| `proxy.ts` | Per-request nonce CSP and security headers for pages |
| `app/(staff)`, `app/(garage)`, `app/(reply)` | Pages: staff console, Digital Garage, customer reply page (separate root layouts) |
| `app/api/**/route.ts`, `app/webhooks`, `app/healthz`, `app/metrics` | Route files (one line each) pointing at `lib/api` handlers |
| `lib/api/` | HTTP layer: `http.ts` (JSON, body caps, rate limits, staff auth, masking), `staff.ts`, `customer.ts`, `webhooks.ts`, `dev.ts` |
| `components/staff/`, `components/customer/` | React client components for the console and customer pages |
| `lib/server/runtime.ts`, `scheduler.ts`, `bus.ts`, `shared.ts` | Process runtime (config, DB, providers), background loops, SSE change bus, process-wide singletons |
| `lib/server/engine.ts` | Ownership state, candidates D1–D7, bundling, drafts, approvals (four-eyes) |
| `lib/server/policy.ts` | Contact policy gate: consent, ownership, quiet hours, cap, gap, decline memory |
| `lib/server/inbound.ts`, `ai.ts` | Reply handling, rules-first NLU, safety keywords, draft guardrails, AI gateway (schema validation, retry, ledger, fallback) |
| `lib/server/providers.ts` | Gemini and OpenAI clients (JSON, vision, audio, embeddings) behind one `ModelProvider` interface |
| `lib/server/triage.ts` | Photo and engine-sound triage; code-owned P1 floor |
| `lib/server/knowledge.ts` | OEM maintenance schedules, roadmap, equity |
| `lib/server/churn.ts` | RFM-D churn score, tiers, revenue at risk |
| `lib/server/feedback.ts`, `vector.ts` | Technician stories, embedding worker, persistent vector store, precedents, accuracy |
| `lib/server/garage.ts` | Digital Garage passport, loyalty tiers, grounded chat facts, booking |
| `lib/server/channel.ts` | Consent ledger, STOP, outbox, sandbox provider |
| `lib/server/tekion.ts`, `events.ts` | Signed webhook adapter, idempotent inbox and pump |
| `lib/server/recall.ts`, `media.ts`, `reply.ts` | Recall lookups, upload validation and EXIF stripping, capability links |
| `lib/server/auth.ts` | OIDC verifier, RBAC |
| `lib/server/audit.ts`, `db.ts` | Hash-chained audit log, SQLite schema and migrations |
| `lib/server/cli.ts`, `synth.ts` | Operator CLI (seed, eval, audit) and the synthetic data generator |
| `test/`, `eval/` | `node:test` suites and the scenario eval (run without Next.js) |
| `docs/` | `SHORTCUTS.md` (MVP vs. HLD), `SECURITY.md`, `CONTRACT.md` (event contract) |

## Verified vs. assumed

**Verified on this machine (Next.js port, 2026-11-14):** server binds 127.0.0.1 only (lsof) in dev and production;
`next build` and `tsc --noEmit` are clean; tests 78/78 and eval 28/28 at any hour; live Gemini garage
chat, embeddings and precedents work; staff API returns
401 without identity; analysts get masked data; path traversal returns 404; security headers are on every response;
audit chain verifies; reply link, message and image upload work end to end; non-image uploads are rejected; SSE
pushes changes.

**Assumed / not verified:** Tekion webhook payloads and signing scheme (no partner docs); real SMS delivery
(sandbox only); NHTSA live mode (not exercised); live OpenAI calls (Gemini was exercised; OpenAI request shapes are tested with a fake fetch); model quality; OEM schedules and costs are representative, not OEM-sourced; legal readings of TCPA/CTIA rules
come from the HLD and are not legal advice.

See `docs/SECURITY.md` before running this anywhere but your own machine.
