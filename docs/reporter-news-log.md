# Reporter News Log

The canonical, deduplicated record of every news candidate the reporter
workflow has seen, and what became of it. It is **not** the broadcast ledger:
the ledger records what went out, while this log records what was found. Logging
an item here never means it was approved, queued or published.

Ownership: ShareBot/FarmClaw captures and verifies items. Market Dashboard
stores and displays them. Penny owns approval, scheduling and reconciliation.

Storage: `DATA_DIR/reporter-news-log.json`. It uses the same locked, atomic
JSON-file pattern as the broadcast ledger and is safe on a single replica.

## Auth

Writes need `x-broadcast-key: $BROADCAST_LEDGER_API_KEY` (or the admin key). This
is the same key ShareBot already uses for the ledger. Reads are open to a
logged-in dashboard session or to a request that carries the key.

Approval is the exception. It needs `x-approver-key: $REPORTER_NEWS_APPROVER_KEY`
on `POST /api/reporter-news/:id/approval`, and nothing else can approve:

- The ledger key and the admin key never approve. `PATCH` with
  `status: "approved"` returns `403`.
- With `REPORTER_NEWS_APPROVER_KEY` unset, or set to the same value as the
  ledger or admin key, approval is disabled (`503`). There is no fallback.
- Only the human approval path holds the approver key. FarmClaw, ShareBot67
  and any other agent that prepares drafts must never be given it, so they
  can log and advance their own work but cannot authorize its publication.

## Workflow

```
discovered → verified → approved → queued → posted
     └──────────┴───────────┴─────────┴──→ failed
     └──────────┴───────────┴──→ rejected
```

- Intake accepts only `discovered` or `verified` (the default). Approval comes
  only through the approval endpoint; queueing, posting and failures come
  through `PATCH`.
- Every record carries a `contentHash` (`sha256:…`) over the reviewed content:
  headline, url, canonicalUrl, source, sourceId, publishedAt, market, symbols,
  summary and imageUrl. An approval must send back the hash it reviewed, and
  the stored `approvalReceipt` keeps it.
- Approved content is frozen. A `PATCH` that edits `summary`, `symbols` or
  `market` on an approved, queued or posted record returns `409`, and a repeat
  intake leaves the approved content untouched.
- `approved → queued` needs an `approvalReceipt` whose hash still matches the
  record's content. A record approved before receipts existed must first be
  confirmed once through the approval endpoint.
- Re-sending the current status is accepted, so retries are idempotent. Any
  other move that isn't listed above returns `409` with `currentStatus`.
- A failure records the stage it failed at as `failedFrom`. A `failed` record
  can only go back to that stage, move on to that stage's next step, or be
  rejected. For example, `approved → failed → queued` is allowed, but
  `discovered → failed → queued` and `verified → failed → queued` return
  `409`. A failure can never be used to skip verification or approval.
- Each status must keep its evidence for as long as the record holds it. This
  is checked on every `PATCH`, including patches that only change metadata, so
  evidence can't be erased after the status is set:
  - `queued` needs `farmbot.queueId`.
  - `posted` needs `farmbot.publication` with a `receiptId`, `postId` or
    `url`. Success is never inferred from a helper response alone.
  - `failed` needs the exact `error` text, for example the TLS or network
    error. A failure stays `failed` until it is retried, and it is never
    recorded as `queued` without a real queue ID.
- A `PATCH` that is refused changes nothing.

## Endpoints

### `POST /api/reporter-news/intake`

```json
{
  "url": "https://www.reuters.com/markets/fed-holds?utm_source=x",
  "headline": "Fed holds rates steady",
  "source": "Reuters",
  "sourceId": "optional, used when there is no URL",
  "publishedAt": "2026-10-05T15:00:00Z",
  "capturedAt": "2026-10-05T16:00:00Z",
  "market": "Economics",
  "symbols": ["SPY", "DXY"],
  "summary": "…",
  "imageUrl": "https://…",
  "capturedBy": "sharebot67",
  "status": "verified"
}
```

`market` accepts Stock/Stocks/Markets, Crypto, Economics, Geopolitics, or
anything else, which is stored as `general`.

Deduplication uses the canonical URL. That means https, lowercase host, no
`www.`, no tracking params, no fragment and no trailing slash. When an item
has no URL, both `source` and `sourceId` are required, because an ID on its
own is only unique within one source. Sending only one of them returns `400`.

The response is a durable receipt. `201` means a new record was created and
`200` means it was deduplicated:

```json
{ "ok": true, "id": "rnl_…", "created": true, "deduplicated": false,
  "status": "verified", "reporterDate": "2026-10-05", "record": { … } }
```

On a repeat intake, blank fields are filled in, `summary`, `imageUrl` and
`symbols` are refreshed, and `intakeCount` goes up. The status can only move
from `discovered` to `verified`; it never moves backwards.

`reporterDate` is always the America/Vancouver calendar day of `capturedAt`.
Any `reporterDate` the caller sends is ignored. To backfill a past day, send
the historical `capturedAt`.

### `POST /api/reporter-news/:id/approval`

Approver key only (`x-approver-key`).

```json
{ "decision": "approved", "contentHash": "sha256:…", "approver": "jason", "note": "…" }
```

```json
{ "decision": "rejected", "approver": "jason", "note": "…" }
```

- `approved` needs a `verified` record (or one that failed at `verified`) and
  the exact `contentHash` that was reviewed. A different hash returns `409`
  with `currentContentHash`, and nothing changes. Review it again and resend.
- Re-sending the same approval is idempotent (`changed: false`).
- On a record approved before approval receipts existed, `approved` with its
  current hash binds a receipt (`confirmedLegacy: true`) without moving status.
- History records `actor: "approver-key"`. `approver` is stored as `claimedBy`.

### `PATCH /api/reporter-news/:id`

```json
{ "status": "queued", "actor": "penny",
  "farmbot": { "queueId": "fb_123", "scheduledAt": "…", "status": "scheduled" } }
```

```json
{ "status": "posted",
  "farmbot": { "status": "published",
               "publication": { "receiptId": "…", "postId": "…", "url": "…", "postedAt": "…" } } }
```

```json
{ "status": "failed", "error": "TLS handshake timeout to farmbot backend" }
```

History attribution: the key is shared, so the server can only vouch that
"a holder of the shared key" made a write. Each history entry stores that as
`actor: "shared-key"`. The caller's own `actor` (on `PATCH`) or `capturedBy`
(on intake) is stored separately as `claimedBy`, and it is not verified.

`farmbot` fields are merged. A reconciler that only sends `status` or
`lastCheckedAt` keeps the queue ID that was already stored. Other fields you
can patch are `verification` (`unverified|verified|disputed`), `symbols`,
`market`, `summary` and `note`. The content fields are frozen once a record is
approved. `PATCH` may resume a `failed` record at `approved` only if it failed
after approval.

### Reads

- `GET /api/reporter-news/daily?date=YYYY-MM-DD&market=&source=&symbol=&status=`
  returns the day's records with counts for each status. The counts ignore the
  `status` filter, so they always describe the whole day. The response also
  includes source and symbol facets.
- `GET /api/reporter-news/days?limit=30` returns recent days with their totals.
- `GET /api/reporter-news/lookup?url=…` or `?source=…&sourceId=…` checks
  whether an item is already logged. It never creates a record.
- `GET /api/reporter-news/:id` returns one record with its status history.

The Reporter Room's **Daily News Log** panel renders `/daily`.

## Phase 2 (not built yet)

- A reconciler that runs every 10–15 minutes and checks queued records against
  the FarmBot backend, using `PATCH` with `farmbot.status`/`lastCheckedAt`.
- A nightly close at about 23:55 America/Vancouver that totals the day, flags
  missing receipts and stores an immutable daily snapshot.
- Alerts only for missing receipts, reconciliation mismatches or repeated
  intake failures.
- Before scheduling is turned on: backfill one test day, verify
  deduplication, and compare records against FarmBot queue and post receipts.
