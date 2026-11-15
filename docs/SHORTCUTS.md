# Shortcuts and substitutions (MVP vs. HLD)

The MVP keeps the HLD's **behaviour** (contracts, policy order, safety path, audit, RBAC) and swaps the
**infrastructure** for Node 24 built-ins, so it runs on one laptop. The backend core (`lib/server/`) still has no third-party
dependencies; the only packages are Next.js and React for the UI and route handlers.

| HLD component | MVP substitute | What is lost | Path back |
|---|---|---|---|
| Go services | TypeScript on Node 24 (native type stripping) | Static binaries, Go toolchain | Port module by module; interfaces are kept narrow |
| PostgreSQL + RLS | `node:sqlite` (WAL, FKs, `user_version` migrations); tenant scoping in every query | DB-enforced tenancy (RLS), concurrency | Same schema maps to Postgres; add RLS policies on `tenant_id` |
| NATS JetStream | `events` table as inbox and outbox, `pump()` with per-event transaction, 3 attempts then dead | Fan-out, consumer groups, replay across services | Publish from the outbox rows; consumers stay idempotent on `event_id` |
| Temporal (journey timers) | HLD fallback from section 03: periodic `evaluateAll` scheduler (60 s) + snooze/due dates in rows | Durable per-ownership workflows, signals | Temporal workflow per ownership; current evaluate becomes an activity |
| OPA (Rego) policy gate | `lib/server/policy.ts` pure function, same check order (consent, ownership, quiet hours, cap, gap, decline memory) | Policy-as-data, separate deploy | Port checks 1:1 to Rego; tests in `test/core.test.ts` carry over |
| Valkey cache | In-process TTL cache (`lib/server/cache.ts`) in front of the DB-backed recall cache; OIDC JWKS cached in the verifier | Shared cache across replicas | Swap the cache interface |
| SeaweedFS (media) | Local `data/media/` with sha256 names, retention purge job | Replication, presigned URLs | Same `MediaStore` interface |
| ClickHouse analytics | SQL aggregates on the operational DB (`/api/dashboard`, `/metrics`) | Cohort and funnel analytics at scale | Feed ClickHouse from the event log |
| Keycloak (staff OIDC) | `OidcVerifier`: RS256 + JWKS, issuer/audience/exp/nbf, fail-closed when unset. Dev identities only with `AUTH_TEST_BYPASS=1` on loopback | No login UI; tokens must come from an existing IdP | Point `OIDC_ISSUER`/`OIDC_AUDIENCE` at Keycloak |
| OpenBao (secrets) | Gitignored `.env` (mode 600) written by `npm run init` with random values | Rotation, leasing | Load the same variables from the secret store |
| SMS/email providers | `SandboxProvider` (records sends, never leaves the machine) | Real delivery, DLRs | Implement the `Provider` interface; inbound already uses a signed `/webhooks/channel` |
| NHTSA recall API | `RecallService` mock fixtures (synthetic campaign `SYN-24V-001`); `RECALL_MODE=live` path calls the public API | Real recall data in the demo | Set `RECALL_MODE=live` (outbound HTTPS only) |
| Self-hosted models | Hosted vendor APIs, Gemini or OpenAI, chosen with `AI_PROVIDER`. With `off`, the app runs rules-only with template drafts | Data stays in-house; no vendor dependency | Implement `ModelProvider` for another endpoint |
| Vector database (pgvector, ANN) | `lib/server/vector.ts`: Float32 BLOBs in SQLite, one store per (tenant, collection, embedding model), brute-force cosine scan | Sub-linear search at scale. The scan is fine to about 50k stories per tenant | pgvector with an HNSW index; same `VectorStore` interface |
| React staff app + customer PWA | Next.js App Router: React staff console and customer pages (`app/`, `components/`), API as route handlers (`app/api`, `lib/api`) | Offline PWA | UI calls only the documented JSON API |
| k3s, Argo CD, OpenTofu | `npm start` (custom Node server around Next.js) on loopback | Everything deploy-related | Out of scope for the MVP |
| promptfoo eval harness | `npm run eval`: 28 deterministic checks plus a live vendor section when a key is set | Model-quality and calibration metrics | Build a labelled golden set from real technician stories |

## Product scope shortcuts

- **Customer reply page** uses a 72 h capability link (256-bit token, hashed at rest, 50 uses, revocable) and is
  **enabled only on a loopback bind**. It is not a reviewed customer authentication mechanism. See SECURITY.md.
- **Rules UI** saves drafts and previews impact. Publishing is API-only (`POST /api/rules/:id/publish`, group admin).
- **Email channel** is not implemented; SMS-shaped messages only.
- **Audio** uploads are stored and shown to staff. Sound triage needs a vendor: OpenAI audio-input model or Gemini.
  OpenAI's audio input accepts only wav and mp3, so other formats get rules-only triage there.
- **OEM knowledge base** (`lib/server/knowledge.ts`): the schedules, intervals and costs for the seeded models are
  representative values, not OEM-sourced. Unknown models fall back to a generic schedule. A milestone counts as
  completed when the last RO's odometer or date reached it. Later completions imply earlier ones. This is inferred
  from the last RO, not from line-item labour codes.
- **Equity peak** is a heuristic: the month before the 36-month / 36,000-mile basic warranty lapses at the owner's
  driving rate. It does not use a market-value feed.
- **Booking** from the garage creates a callback case for an advisor. There is no scheduler integration.
- **Loyalty** points (100 per RO, 10 per tenure month) and tier thresholds (Silver 300, Gold 800, Platinum 1500) are
  demo values in `LOYALTY_RULES`, not a dealer program.
- **Churn** weights and thresholds follow the spec verbatim. They are not fitted to outcome data.
- **Closed loop**: an AI prediction comes from the RO payload (`ai_predicted_service`) or from this system's most
  recent open diagnostic for the VIN. Embedding runs in a background worker, not in the event pump.
- **Recall P1** sends the fixed notice immediately (subject to consent) and opens a P1 case for advisor follow-up
  (HLD: recall and safety items need an advisor acknowledgement). Two seeded vehicles carry the synthetic recall
  fixtures (P-0001 2019 Camry, P-0002 2018 Accord).
- **Synthetic data only**: fabricated VINs, 555-01xx phone numbers, `example.test` emails. Each vehicle has a consistent
  timeline: in-service date and model year, a 36-month warranty from in-service, new or pre-owned sale, 60-month loans,
  odometer from a per-driver annual mileage, and service visits every 5-7 months for regular owners (lapsed owners
  stopped 12-20 months ago; unhappy owners lapse). The seed then simulates a month of operation: about 60% of the
  initial backlog was approved and sent 5-28 days ago, so the queue is realistic and the cap/cadence rules have history.
