# Inbound event contract (Tekion adapter)

Tekion APC partner documentation was not available, so this is the **canonical contract the adapter expects**.
A thin mapper from real Tekion payloads to this shape is the only piece that has to change.

## Transport

```
POST /webhooks/tekion
Content-Type: application/json
X-Tekion-Timestamp: <unix seconds, 10 digits>
X-Tekion-Signature: hex(HMAC_SHA256(TEKION_WEBHOOK_SECRET, "<timestamp>.<raw body>"))
```

| Response | Meaning |
|---|---|
| 202 `{accepted:true, duplicate:false}` | Stored in the inbox; processed asynchronously |
| 202 `{accepted:true, duplicate:true}` | Same `event_id` seen before; ignored |
| 400 | Bad JSON, missing `event_id`, unsupported `type` |
| 401 | Missing, stale (more than 300 s) or bad signature |
| 404 | Unknown `tenant_id` |
| 429 | Rate limited (120/min per IP) |

## Envelope

```json
{
  "tenant_id": "tenant-demo",
  "event_id": "unique-per-source",
  "type": "deal.funded | ro.closed | vehicle.updated | ownership.ended",
  "occurred_at": "2026-05-01T10:00:00Z",
  "data": { "...": "per type, below" }
}
```

## `data` by type

- **deal.funded**: `vin, make, model, year, rooftop_id, customer_party_id, customer{name, phone, email, language, tz},
  odometer, sold_at, warranty_end_date, warranty_end_miles, loan_end_date, insurance_renewal_date`
- **ro.closed**: `vin, make, model, year, rooftop_id, customer_party_id, customer{...}, odometer, closed_at, csat (1-5),
  declined[{item}], ro_id?, technician_story?`
  - `ro_id`: the DMS repair-order number. It is the idempotency key for RO history and technician stories. If it is
    absent, the event id is used.
  - `technician_story` (optional, for closed-loop learning):

    | Field | Type | Rule |
    |---|---|---|
    | `customer_complaint` | string | required, ≤ 2000 |
    | `technician_diagnosis` | string | required, ≤ 2000 |
    | `technician_action` | string | required, ≤ 2000 |
    | `override_occurred` | boolean | required. `true` = the technician disagreed with the AI prediction |
    | `labor_code` | string | required, ≤ 40 |
    | `ai_predicted_service` | string | optional, ≤ 500. If absent, this system's most recent open diagnostic for the VIN is used |

    An invalid story is rejected and audited (`technician_story.rejected`). The RO itself is still processed. Free
    text is PII-redacted before storage. Each `(tenant, ro_id)` gets at most one story.
- **vehicle.updated**: `vin, odometer, odometer_at, warranty_end_date, warranty_end_miles, loan_end_date,
  insurance_renewal_date`
- **ownership.ended**: `vin, customer_party_id`

## Semantics

- A repair order on a VIN by a **different** customer marks the current ownership `possibly_sold` and opens a
  callback case. The owner is never overwritten silently.
- A later `deal.funded` for a new customer on the same VIN closes the old ownership and starts a new one.
- Processing is at-least-once and idempotent on `(source, event_id)`. Events fail three times and then go to `dead`
  (visible in the dashboard).

## Channel inbound (SMS provider)

`POST /webhooks/channel` with `X-Channel-Timestamp` and `X-Channel-Signature` (same scheme, `CHANNEL_WEBHOOK_SECRET`).
Body: `{tenant_id, from, body, message_id}`. Idempotent on `message_id`.
