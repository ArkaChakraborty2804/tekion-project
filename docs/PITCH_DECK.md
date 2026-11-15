# TekOrbit pitch deck: slide templates and content

The deck has 9 slides at 16:9 and follows the order of the winning GrabHack deck: title and problem, solution, architecture, workflow, demo, example and impact, thank you. Two slides are added because Tekion judges will ask about them: a problem slide with numbers, and a trust and safety slide.

Every number on these slides is either taken from the running app or labelled as an assumption. A judge can check them.

---

## 0. Design system (applies to every slide)

Grab used its green brand colour edge to edge. For Tekion, use a dark "automotive cloud" look that matches the product UI, so the screenshots blend into the slides.

> **Check the brand colours first.** The values below come from the TekOrbit app UI. Before you build the deck, check Tekion's official colours and logo on tekion.com (press or brand kit) and replace `--brand-accent` if they differ. Use the Tekion logo only as permitted for the hackathon.

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#080B11` | Slide background (near-black navy) |
| `--surface` | `#0E1422` | Cards, callout boxes |
| `--surface-2` | `#151D30` | Inner panels, code/CLI blocks |
| `--border` | `rgba(255,255,255,0.10)` | Card borders (1 px) |
| `--brand-accent` | `#2563EB` (blue-600) | Headlines accents, arrows, primary chips |
| `--accent-2` | `#38BDF8` (sky-400) | Secondary highlights, gradients |
| `--good` | `#10B981` | "Allowed / sent / safe" |
| `--warn` | `#F59E0B` | "Held / due soon" |
| `--critical` | `#EF4444` | Safety, P1, problem statements |
| `--text` | `#F8FAFC` | Primary text |
| `--muted` | `#94A3B8` | Secondary text |

**Fonts** (these are the fonts the app uses):
- Headlines: **Plus Jakarta Sans** Bold or ExtraBold, tracking -2%.
- Body: **Inter** Regular or Medium.
- Numbers, code and CLI: **JetBrains Mono**.

**Recurring elements** (Grab's equivalents in brackets):
- **Top band** on content slides: a 96 px dark band with the Tekion and TekOrbit logos on the left, the slide title on the right, and a 2 px `--brand-accent` underline. (Grab used a green header band.)
- **Callout cards:** `--surface` fill, 12 px radius, 1 px border, and a small icon chip (lucide icons, the same set as the app). (Grab used dashed white boxes.)
- **Connectors:** dotted `--brand-accent` arrows from the callouts to the central screenshot. (Grab used dotted white arrows.)
- **Hero imagery:** the studio car photos in `public/cars/` plus product screenshots. (Grab used illustrated drivers.)
- **Footer** on every slide: `TekOrbit · Post-Purchase Loyalty Journey Orchestrator · Team <name>` and the slide number on the right, in `--muted` at 10 pt.

**How to capture the screenshots** (run `npm run dev`, use the Demo Group Admin identity, browser at 1440×900, dark theme):

| Shot | URL |
|---|---|
| S1 Executive Overview | `http://127.0.0.1:8787/#overview` |
| S2 Approval Queue | `http://127.0.0.1:8787/#queue` |
| S3 Customer 360 | `http://127.0.0.1:8787/#customers` |
| S4 Churn & Closed Loop | `http://127.0.0.1:8787/#insights` |
| S5 Cases & Safety | `http://127.0.0.1:8787/#cases` |
| S6 Digital Garage (customer) | Customer 360 → **Create customer link** → **Open Digital Garage** |
| S7 Garage problem check, P1 result | Type "brakes feel like they fail" and click **Check it** |
| S8 Audit (chain verified) | `http://127.0.0.1:8787/#audit` |

---

## Slide 1: Title and problem

**Template**
```
┌──────────────────────────────────────────────────────────────────────┐
│ [Tekion logo]                                   [hackathon logo]      │
│                                                                      │
│  TekOrbit                                ┌──────────────────────┐    │
│  Post-Purchase Loyalty                   │   hero car photo     │    │
│  Journey Orchestrator                    │ (suv-large.jpg, dark │    │
│                                          │  studio, right-bleed)│    │
│  ⬡ Theme 3 · Customer Experience         └──────────────────────┘    │
│  ⬡ Team: <TEAM NAME>       ┌────────────────────────────────────┐    │
│                            │ EXISTING PROBLEM  (red label)      │    │
│                            │ <problem statement, 3 lines>       │    │
│                            └────────────────────────────────────┘    │
│  <Member 1>   <Member 2>   <Member 3>                                │
└──────────────────────────────────────────────────────────────────────┘
```
- Background: `--bg`, with a radial `--brand-accent` glow at 15% opacity behind the car.
- Use hexagon chips (like Grab's) for the theme and team name, filled with `--surface` and a 1 px `--brand-accent` border.

**Content**
- **Title:** TekOrbit
- **Subtitle:** Post-Purchase Loyalty Journey Orchestrator
- **Tagline:** *One right message, at the right time, for the whole life of the car.*
- **Theme chip:** Theme 3 · Customer Experience (also covers Theme 2 · Churn & Win-Back Predictor)
- **Existing problem:** After the sale, dealers contact owners through separate, uncoordinated campaigns for service, warranty, insurance, trade-in and reviews. Owners get spammed, ignore the messages or opt out, and take their car to independent garages. Dealers lose service revenue and the next car sale.
- **Team:** `<TEAM NAME>` · `<Member 1>` · `<Member 2>` · `<Member 3>`

---

## Slide 2: Why it matters (new; Grab folded this into slide 1)

**Template**
```
┌ top band: "The post-sale gap" ───────────────────────────────────────┐
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     ┌──────────────────┐   │
│  │ BIG STAT │  │ BIG STAT │  │ BIG STAT │     │ "Today" timeline │   │
│  │  label   │  │  label   │  │  label   │     │  5 colliding     │   │
│  └──────────┘  └──────────┘  └──────────┘     │  campaign chips  │   │
│                                               │  in the same week│   │
│  ── Tekion has ──────────── ── Gap we fill ── └──────────────────┘   │
│  CRM campaigns              One coordinated journey                  │
│  Salesperson AI (≤30 days)  Whole ownership (3–5+ years)             │
└──────────────────────────────────────────────────────────────────────┘
```

**Content**
- **Stat 1:** **276M+** repair orders at US franchised dealers (2025, NADA)
- **Stat 2:** **$164B+** service and parts sales (2025, NADA)
- **Stat 3:** **Up to 30 days.** That's how long Tekion's Salesperson AI nurtures a customer after the sale, according to Tekion's public site. Ownership lasts 3–5+ years.
- **"Today" timeline:** in one week, the same owner gets a service reminder, a warranty offer, an insurance renewal, a trade-in offer and a review request. Five chips stacked on the same day, red outline.
- **Gap table (two columns):**

  | Tekion has | We add |
  |---|---|
  | CRM campaigns | One coordinated journey with priority, bundling and a frequency cap across the dealer group |
  | Salesperson AI (up to 30 days) | Coverage across the whole ownership (3–5+ years) |
  | Next-best-action claims | An explainable "why now" reason for every message |

> The two NADA figures come from the HLD, where they are marked as verified. The 30-day figure is Tekion's public claim. Recheck all three before presenting.

---

## Slide 3: Our solution (Grab's "OUR SOLUTION" layout)

**Template**
```
┌ top band: "Our solution" ────────────────────────────────────────────┐
│ ┌callout A┐                 ┌───────────────────┐        ┌callout D┐ │
│ │ icon    │ ⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯▶ │                   │ ◀⋯⋯⋯⋯⋯ │ icon    │ │
│ └─────────┘                 │  SCREENSHOT S1    │        └─────────┘ │
│ ┌callout B┐                 │  (Executive       │        ┌callout E┐ │
│ │         │ ⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯▶ │   Overview)       │ ◀⋯⋯⋯⋯⋯ │         │ │
│ └─────────┘                 │                   │        └─────────┘ │
│ ┌callout C┐                 └───────────────────┘        ┌callout F┐ │
│ │         │ ⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯▶   caption under shot  ◀⋯⋯⋯⋯⋯ │         │ │
│ └─────────┘                                              └─────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```
- Put the S1 screenshot in the centre with a thin `--brand-accent` frame. Add a small "DMS event → Engine → Staff → Customer" icon flow above it, mirroring Grab's "NL → AI Orchestration Agent".
- Use six callouts, three on each side, each with an icon chip, a bold title and two lines of text.

**Content (6 callouts)**
1. **Journey orchestrator** (icon: Route). Turns Tekion DMS events (deal funded, RO closed) into one ownership journey per vehicle and owner. Seven journey steps, from service due to review request.
2. **"Customer is boss" contact policy** (icon: ShieldCheck). Checks consent, a cap of 2 messages per 30 days, quiet hours, decline memory and non-responder decay. Every held message is stored with its reason.
3. **Human in the loop** (icon: Inbox). Staff approve, edit, snooze or reject each draft. A second approver is required after an edit. Each card shows "why now" and the exact SMS.
4. **Safety-first triage** (icon: OctagonAlert). Brake, steering, fuel and fire reports by text, photo or engine sound go straight to P1. The customer gets a fixed "do not drive" template and an advisor is alerted. The AI can raise urgency, never lower it.
5. **Churn & win-back** (icon: TrendingDown). A churn score built from recency, frequency, declined work and warranty status. It shows revenue at risk and the named drivers, and HIGH-risk owners get a $40 voucher draft. Win-backs are never sent automatically.
6. **Digital Garage** (icon: Car). A customer passport with the OEM maintenance timeline, loyalty tier, recalls, trade-in window, a grounded chat and one-tap booking.

**Caption under the screenshot:** *Executive Overview: live queue, safety cases, revenue at risk, and the messages the policy held back.*

---

## Slide 4: Architecture (Grab's "Detailed Architecture" layout)

**Template**
```
┌ top band: "Architecture" ────────────────────────────────────────────┐
│  LEFT 60%: layered diagram              RIGHT 40%: tagged notes       │
│  ┌ Tekion APC webhooks (HMAC) ┐          <tekion_adapter>  …          │
│  └────────────┬───────────────┘          <journey_engine>  …          │
│  ┌ Event inbox (idempotent)   ┐          <policy_gate>     …          │
│  ┌ Journey & Decision Engine  ┐          <ai_gateway>      …          │
│  │ rules D1–D7 · bundling     │          <channels_ui>     …          │
│  ┌ Contact Policy Gate        ┐          ─────────────────────────    │
│  ┌ AI Gateway ┐ ┌ Knowledge  ┐          TECH STACK (logo grid)        │
│  ┌ Approval queue → Channel  ┐                                        │
│  ┌ Staff console │ Garage    ┐                                        │
│  └ Audit chain (append-only) ┘                                        │
└──────────────────────────────────────────────────────────────────────┘
```
- Colour each layer box by role: ingest in sky, decide in blue, guard in emerald, AI in violet, surfaces in slate.
- The right column uses `<monospace_tags>` exactly like Grab's `<python_cli>` style.

**Content: diagram boxes (top to bottom)**
1. Tekion APC webhooks: `deal.funded`, `ro.closed`, `vehicle.updated`, `ownership.ended`, signed with HMAC
2. Event inbox: idempotent, retried 3 times, then dead-lettered
3. Journey & Decision Engine: ownership state machine, rules D1–D7, scoring, bundling
4. Contact Policy Gate: consent, ownership, frequency cap, cadence, decline memory. Quiet hours schedule the send rather than block it.
5. AI Gateway (Gemini / OpenAI) and Knowledge (OEM schedules, technician stories in a vector store)
6. Approval queue → Channel (consent ledger, STOP, outbox)
7. Staff console (Next.js) | Customer Digital Garage and reply page
8. Audit log: hash-chained and append-only

**Content: right-column notes**
- `<tekion_adapter>` Signed webhooks go into an idempotent inbox. Only this mapper changes when we onboard to the real Tekion APC.
- `<journey_engine>` Decides the one next message for each ownership. Rules are deterministic and every decision has a reason. No model training is needed, so it works from day one.
- `<policy_gate>` Enforces "customer is boss". Failure closes the gate: no consent means no send. P1 safety skips the cap but never skips consent.
- `<ai_gateway>` One place for every model call. It validates the output against a schema, retries once, falls back to rules and logs the call. A draft is only used if it passes `checkDraft`, which rejects any number not in the facts and any unlisted URL.
- `<channels_ui>` The staff console and customer pages call one JSON API with role-based access and analyst masking. Live updates stream over server-sent events.

**Tech stack logo grid:** Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · Node 24 (`node:sqlite`) · Gemini / OpenAI. The backend core has no third-party dependencies.

---

## Slide 5: Journey workflow (Grab's "Specialized Agent Workflow" layout)

**Template**
```
┌ top band: "How every journey step decides" ──────────────────────────┐
│                     ┌──────────────────────┐                         │
│                     │  Journey Engine      │                         │
│                     │  (classify + score)  │                         │
│                     └──────────┬───────────┘                         │
│  ┌col1┐ ┌col2┐ ┌col3┐ ┌col4┐ ┌col5┐ ┌col6┐ ┌col7┐ ┌col8┐              │
│  │ ①  │ │ ①  │ │ ①  │ │ ①  │ │ ①  │ │ ①  │ │ ①  │ │ ①  │  DETECT      │
│  │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │              │
│  │ ②  │ │ ②  │ │ ②  │ │ ②  │ │ ②  │ │ ②  │ │ ②  │ │ ②  │  DECIDE      │
│  │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │ │ ↓  │              │
│  │ ③  │ │ ③  │ │ ③  │ │ ③  │ │ ③  │ │ ③  │ │ ③  │ │ ③  │  ACT         │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘              │
└──────────────────────────────────────────────────────────────────────┘
```
- One centre node, then 8 columns of 3 cards each, with an icon chip on every card. Card fill is `--surface`; the column header is in `--brand-accent`.

**Content (8 columns × Detect / Decide / Act)**

| Column | ① Detect | ② Decide | ③ Act |
|---|---|---|---|
| **Service due** | OEM milestone reached by estimated miles or months | Bundle with warranty, insurance or an accessory if within 60 days | Draft from facts; staff approve; sent in the customer's send window |
| **Safety recall** | Open recall found for this VIN | P1: never bundled with marketing | Fixed notice sent now; P1 case for an advisor call |
| **Declined work** | Items declined on the last repair order | Follow up while still relevant | Service-purpose message with the declined items |
| **Win-back** | Churn risk is HIGH (recency, CSAT, declines, warranty cliff) | Needs marketing consent; replaces the plain reminder | $40 voucher draft, human approval only |
| **Warranty / insurance** | End or renewal date within the window | Attach to a service visit when possible | Offer with the date taken from the record |
| **Trade-in** | Loan maturity or the equity-peak window | Selling store owns the offer | Trade-in conversation draft |
| **Review** | Good RO experience (CSAT ≥ 4) within 3–21 days | Never time-only | Review request |
| **Customer reply** | Inbound text, photo or noise | STOP → opt out · safety words → P1 · otherwise AI intent | Snooze, possibly-sold, a case, or a fixed safety template |

---

## Slide 6: Product demo (Grab's "CLI + ChatBot" slide)

**Template**
```
┌ top band: "Staff console  ⟷  Customer Digital Garage" ───────────────┐
│  ┌ LEFT: SCREENSHOT S2 (Queue card) ┐ │ ┌ RIGHT: SCREENSHOT S6 ─────┐ │
│  │                                  │ │ │ (Garage hero + timeline) │ │
│  └──────────────────────────────────┘ │ └──────────────────────────┘ │
│  caption: what staff sees              │  caption: what owner sees    │
│  ┌ small: S4 Churn │ small: S8 Audit ┐ │  • bullet  • bullet          │
└──────────────────────────────────────────────────────────────────────┘
```
- Divide the slide with a vertical dashed `--brand-accent` line, as Grab did. Put two small thumbnails under the left screenshot.

**Content**
- **Left heading:** Staff console (dealer)
  - Caption: *Every card shows the rule that fired, the OEM facts, the exact SMS, and the customer's local time ("sends Sat 08:00 PST").*
- **Right heading:** Digital Garage (owner)
  - Caption: *The OEM maintenance timeline with an odometer pin, recalls, loyalty tier, trade-in window, and a "something wrong?" check by text, photo or recorded noise.*
- **Bullets:**
  - Both screens run on one backend engine and one JSON API.
  - The garage chat answers only from the vehicle's own records; any number not in the facts is rejected.
  - Dealers see why each message exists. Owners see why they should come back.

---

## Slide 7: Example scenario and business impact (Grab's "Cancellation scenario + impact" slide)

**Template**
```
┌ top band: "Example: 'My brakes feel like they fail'" ────────────────┐
│  LEFT 62%                                       │ RIGHT 38%          │
│  [S7 garage P1 result] ═▶ [arrow chip] ═▶ [S5]  │ BUSINESS IMPACT    │
│  step strip: ① ② ③ ④ ⑤ (numbered chips)        │ • metric  …        │
│  paragraph: what happened in 5 steps            │ • metric  …        │
│                                                 │ • metric  …        │
└──────────────────────────────────────────────────────────────────────┘
```
- Make the arrow chip between the screenshots a rounded `--critical` label reading **"P1 safety path"**, like Grab's "FLASH SALE ENGINE redirects" chip.

**Content: scenario strip**
1. The owner types *"brakes feel like they fail when I stop"* in the Digital Garage.
2. A code-owned safety rule matches before any model runs, so the result is **P1**.
3. The fixed "do not drive, call us" template goes out by SMS. No AI-written text is used.
4. A P1 safety case appears in **Cases & Safety** and the bell count goes up for the advisor.
5. In the background, the AI finds similar past technician repairs to help the advisor diagnose. Those precedents are never shown to the customer.

**Alternative scenario** (if you'd rather not lead with safety): *Staff approve at 6 pm IST, which is 4:34 am in Los Angeles. The message is held and sent at 08:00 customer time, so the queue is never empty and the customer is never texted at night.*

**Content: business impact** (show measured numbers first, then labelled projections)
- **Measured in the demo** (synthetic 80-owner dealer group; take these from S1 and S4 on the day):
  - **`<N>` messages held back** by the contact policy, each with a reason (28 in the current seed)
  - **`$<X>` service revenue at risk** identified, with named drivers ($9,461 in the current seed)
  - **`<H>` HIGH-risk owners** given a win-back draft (10 in the current seed)
  - **0 messages sent at night**, and P1 safety handling is code-enforced
- **Projected, labelled as assumptions:**
  - Fewer opt-outs, because of at most 2 messages per 30 days and bundling. *Assumption to validate in a pilot.*
  - Service retention lift through the warranty-lapse churn cliff. *Pilot KPI: return rate at 12 and 24 months.*
  - Advisor time saved, because every draft arrives with its facts and reason. *Pilot KPI: approval time per card.*
- **Scale:** the rule tables, policy gate and AI gateway are tenant-scoped, so one engine serves a whole dealer group across rooftops.

> Grab's deck used percentages like "+20–30%" without sources. Tekion judges are domain experts, so keep projections clearly labelled and lean on the live numbers they can watch you produce.

---

## Slide 8: Trust, safety and compliance (new; a differentiator over last year's winner)

**Template**
```
┌ top band: "Built to be trusted with real customers" ─────────────────┐
│  ┌ card ┐ ┌ card ┐ ┌ card ┐ ┌ card ┐      ┌ SCREENSHOT S8 (Audit) ┐  │
│  │icon  │ │icon  │ │icon  │ │icon  │      │  "Hash chain verified" │  │
│  └──────┘ └──────┘ └──────┘ └──────┘      └────────────────────────┘  │
│  ┌ card ┐ ┌ card ┐ ┌ card ┐ ┌ card ┐      tests: 78/78 · eval 28/28   │
└──────────────────────────────────────────────────────────────────────┘
```

**Content (8 cards, 1 line each)**
1. **Consent ledger:** consent is tracked per purpose (service, safety, marketing), and sends fail closed without it. STOP is honoured with no AI involved.
2. **Quiet hours:** 08:00–21:00 in the recipient's time zone; messages are held, never blocked.
3. **Guardrails:** every number in a draft must come from the facts; banned phrases and unlisted links are rejected.
4. **AI never lowers safety:** rules OR the model can raise a safety flag, and only a rule can clear one.
5. **Four-eyes approval:** whoever edits a draft cannot approve it.
6. **Role-based access and masking:** analysts never see names, phones or message bodies.
7. **Hash-chained audit:** every approval, send, consent change and model call is logged and checkable.
8. **Privacy:** EXIF and GPS data are stripped from photos, and media is kept 90 days (photos) or 30 days (audio).

**Footer strip:** `78/78 unit tests · 28/28 scenario evals · runs on one laptop with npm run dev`

---

## Slide 9: Thank you (Grab's closing slide)

**Template**
```
┌──────────────────────────────────────────────────────────────────────┐
│ [Tekion logo]                                                        │
│                                                                      │
│              THANK YOU                    ╭─────── curved accent      │
│              (Plus Jakarta 120 pt)        │        lines in          │
│                                           │        --brand-accent    │
│   TekOrbit · <TEAM NAME>                  ╰─────── at 40% opacity     │
│   <repo / demo link>   <email>                                       │
└──────────────────────────────────────────────────────────────────────┘
```
- `--bg` background with two curved `--brand-accent` lines at 40% opacity, like Grab's light-green swoosh. Optionally a faint car silhouette (`sedan-topdown.jpg` at 8% opacity, bottom right).

**Content:** THANK YOU · TekOrbit, the one coherent experience after the deal · `<TEAM NAME>` · `<demo/repo link>` · `<contact>`

---

## Checklist before export

- [ ] Replace the `<TEAM NAME>`, member and link placeholders.
- [ ] Check the Tekion logo usage and brand colour, and update `--brand-accent` if needed.
- [ ] Recapture S1–S8 on a fresh seed (`npm run seed` into an empty `data/`) on demo day, so the numbers match what you show live.
- [ ] Re-check the NADA figures and the Tekion 30-day claim.
- [ ] Keep slide 7's projections labelled as assumptions.
- [ ] Export to PDF at 16:9 and check that the screenshots are readable at 1920×1080.
