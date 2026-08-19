# Broadcast Receipt Ledger

A durable, shared record of every completed news broadcast, so the three
posting paths can see each other's work.

## Why it exists

News goes out three ways:

1. The GPT / iOS Shortcut
2. The OpenClaw agent **ShareBot67** (`newsreporter`)
3. Manual posting, when the OpenClaw gateway is offline

Without a shared record, ShareBot67 can only see what it did itself. A story
broadcast by the shortcut — or by hand while the gateway was down — is
invisible to it, so it either reports a failure that didn't happen or reposts
a story that already went out.

A live ping doesn't fix this: a ping sent while the gateway is down is simply
lost. A stored receipt is not. The ledger lives in the dashboard app, which
stays reachable independently of the OpenClaw gateway, and every path writes
to it.

**A missing live acknowledgment is not a failed broadcast.** If a posted
receipt exists for a story, the story went out — regardless of what any
gateway did or didn't confirm. That is the contract this ledger enforces.

## Where the data lives

`<DATA_DIR>/broadcast-ledger.json`, using the same JSON-on-disk pattern as
the other stores in this repo. There is no database and no migration to run:
the file is created on first write.

```json
{ "version": 1, "receipts": [ /* newest first */ ] }
```

Two operational notes:

- `DATA_DIR` **must** point at the mounted Railway volume (usually
  `/app/data`). On ephemeral container storage the ledger is wiped on every
  deploy, which defeats the whole purpose.
- The file is rewritten whole on each mutation, so this is safe on a single
  replica only. Don't scale the service past one instance without moving the
  store to a real database first.

Receipts are capped at 5000, newest kept. **Message bodies are never stored** —
only a normalized hash and the headline.

## Receipt shape

| Field | Notes |
| --- | --- |
| `id` | `rcpt_<base36 ts>_<8 hex>` |
| `idempotencyKey` | Caller-supplied. Re-posting the same key updates the receipt, never duplicates it. |
| `createdAt` / `updatedAt` | ISO 8601 |
| `source` | `shortcut` \| `sharebot67` \| `manual` \| `dashboard` |
| `kind` | `story` (a single item) \| `digest` (the dashboard's 3-section daily report) |
| `title` | Headline, ≤300 chars |
| `url` / `canonicalUrl` | Raw and canonicalized. Canonical = https, lowercase host, no `www.`, tracking params stripped, no fragment, no trailing slash. |
| `urlHash` | sha256 of `canonicalUrl`, first 32 hex |
| `contentHash` | sha256 of normalized text (lowercased, links/emoji/punctuation stripped, whitespace collapsed) |
| `headlineKey` | First 12 significant words of the normalized title |
| `destinations[]` | `{ channel, chatId, threadId, status, messageId, messageUrl, error }` |
| `status` | `pending` \| `posted` \| `partial` \| `failed` \| `reconciled` |
| `error` | `{ message }` or null |
| `reconciledWith` | ID of the receipt that already posted this story |
| `attempts[]` | Audit trail: `{ at, actor, action, ok, detail }`, last 20 kept |

`posted`, `partial` and `reconciled` all count as "this story went out."
`pending` and `failed` do not.

## Dedupe

Three tiers, most trustworthy first:

1. **Canonical URL** — authoritative. Returns `match: "url"`, `posted: true`.
2. **Normalized content hash** — authoritative. Returns `match: "hash"`, `posted: true`.
3. **Headline + time window** (default 36h) — **advisory only**. Returns
   `match: "likely"`, `posted: false`, plus up to 5 `candidates`.

Tier 3 never asserts that a story was posted, deliberately. A false positive
there would silently suppress a real story forever, which is worse than the
occasional duplicate the ledger exists to prevent. Treat `"likely"` as
"a human should glance at this," not as "skip."

## Authentication

Every endpoint requires a key, presented as any of:

- `x-broadcast-key: <key>`
- `Authorization: Bearer <key>`
- `x-admin-key: <key>`

`BROADCAST_LEDGER_API_KEY` is the intended key; `ADMIN_API_KEY` is accepted as
a fallback so an existing deploy keeps working before the new variable is set.

Use a **separate** `BROADCAST_LEDGER_API_KEY`. This key has to live on a phone
and in an agent config, and one that can only write broadcast receipts is a far
smaller blast radius than one that can also spend OpenAI credits and fire
Telegram broadcasts.

If neither key is set, the endpoints return `503` rather than being left open.

The one exception is the `/manual` form, which also accepts a `?key=` parameter
or an owner site session — see its section below for why.

> **Site login interaction.** The dashboard's site password guard runs before
> every `/api/*` route and normally only accepts the session cookie. The ledger
> paths are explicitly exempted for requests carrying a valid ledger key —
> without that, every machine caller would get `401 Login required` before
> reaching its own key check. This is handled in `src/middleware/site-auth.js`;
> it's worth knowing about if you ever add another machine-called endpoint.

Requests are rate limited to `BROADCAST_LEDGER_RATE_LIMIT_PER_MIN` (default 60)
per client IP per minute, returning `429` with a `Retry-After` header.

## Endpoints

Base path: `/api/broadcast-ledger`

### `POST /receipts` — create or update (idempotent)

```jsonc
{
  "source": "shortcut",
  "kind": "story",
  "title": "Fed holds rates steady",
  "url": "https://example.com/news/fed",
  "text": "optional body — hashed, not stored",
  "idempotencyKey": "shortcut-2026-08-19-fed",
  "status": "posted",
  "destinations": [
    { "channel": "telegram", "chatId": "-1001234", "status": "posted", "messageId": "8842" }
  ]
}
```

→ `201 { receipt, created: true }` on first write, `200 { receipt, created: false }`
on any repeat of the same `idempotencyKey`.

Always send an `idempotencyKey`. It is what makes retries free.

A receipt needs at least one of `title`, `text`, `contentHash`, or a valid
`url`. A malformed `url` is rejected with `400` rather than stored — it would
produce a receipt no lookup could ever match.

### `PATCH /receipts/:id` — record results

```jsonc
{
  "source": "sharebot67",
  "destinations": [
    { "channel": "telegram", "chatId": "-1001", "status": "posted", "messageId": "31" },
    { "channel": "telegram", "chatId": "-1002", "status": "failed", "error": "bot was blocked" }
  ]
}
```

Destinations merge by `channel:chatId:threadId`, so results can be reported
one channel at a time. Status is re-derived from them (the example above
yields `partial`). A receipt that already reached `posted` is never walked
back to `pending` by a late arrival.

### `GET|POST /lookup` — preflight

Query params (`GET`) or JSON body (`POST`): `url`, `headline`, `text`, `hash`,
`windowMs`.

```jsonc
{
  "posted": true,
  "match": "url",
  "receipt": { "id": "rcpt_...", "source": "shortcut", "status": "posted" },
  "candidates": []
}
```

### `GET /receipts` — history

`?limit` (≤500, default 50) `&status=` `&source=` `&since=<ISO>`

### `POST /reconcile` — recovery

```jsonc
{ "ids": ["rcpt_a", "rcpt_b"], "windowMs": 172800000 }
```

Both fields optional. With no `ids`, every `pending`/`failed` receipt in the
window is checked. Returns:

```jsonc
{
  "checked": 4,
  "reconciled": [{ "id": "rcpt_a", "reconciledWith": "rcpt_x", "source": "manual" }],
  "outstanding": [{ "id": "rcpt_b", "status": "failed", "title": "...", "url": "..." }]
}
```

`reconciled` = another path already posted it; do **not** repost, do **not**
report failure. `outstanding` = genuinely unsent; safe to retry.

### `GET /status` — Settings card probe

Returns `{ configured, count, latest }`, where `latest` is id/title/source/status/
createdAt for the newest receipt. Shares the manual form's access rules, so its
`401` and `503` responses are as useful as its `200`: they tell the Settings
card whether to ask for a key or report the ledger as unconfigured. No message
content or hashes are returned.

### `GET|POST /manual` — mobile form

A self-contained, dark, mobile-first page for logging a hand-posted story.
`POST` accepts both a form submission and a JSON body, so a shortcut can use
it as a simpler alternative to `/receipts`.

This is the one endpoint a human opens in a phone browser, which cannot set a
custom header, so it accepts three credentials instead of one:

1. `x-broadcast-key` / `Authorization: Bearer` — same as everything else.
2. `?key=<BROADCAST_LEDGER_API_KEY>` in the URL. The form carries it forward
   in a hidden field so the submission is authorized too.
3. An authenticated **owner** site session, when `MARKET_DASHBOARD_LOGIN_PASSWORD`
   is set. No key needed at all — just log into the dashboard first.

The `key` parameter is accepted **only** on this path. Keys in URLs land in
browser history and access logs, so the machine endpoints never take one that
way. Where you have a site login, option 3 is the clean one:

```
https://<your-app>.up.railway.app/api/broadcast-ledger/manual
```

Otherwise bookmark the `?key=` form to your home screen and keep it private.

## Integration 1 — ShareBot67 (`newsreporter`)

### Preflight, before generating or posting anything

```
POST /api/broadcast-ledger/lookup   { "url": "...", "headline": "...", "text": "..." }
```

| Response | Action |
| --- | --- |
| `posted: true` | **Skip.** Already broadcast by another path. Do not generate, do not post, do not report failure. |
| `match: "likely"` | Advisory. Surface the candidates; skip only under an explicit same-story policy. |
| `match: "none"` | Proceed. |

### Then write a pending receipt *before* posting

```
POST /api/broadcast-ledger/receipts
{ "source": "sharebot67", "kind": "story", "title": "...", "url": "...",
  "idempotencyKey": "sharebot67-<run id>-<story id>", "status": "pending" }
```

Writing before posting is what makes a crash mid-broadcast recoverable: it
leaves a trace for reconciliation instead of a silent gap.

### Then record each destination result

```
PATCH /api/broadcast-ledger/receipts/<id>
{ "source": "sharebot67", "destinations": [ ...one entry per channel... ] }
```

### On startup / reconnect, before reporting anything

```
POST /api/broadcast-ledger/reconcile   { "windowMs": 172800000 }
```

Everything in `reconciled` is done — say nothing, repost nothing. Only
`outstanding` items are genuine work.

**The rule this replaces:** never infer failure from a missing gateway
acknowledgment. Ask the ledger. A posted receipt outranks any absent ack.

## Integration 2 — GPT / iOS Shortcut

Add one "Get Contents of URL" action at the end of the shortcut, after the
broadcast succeeds.

| Field | Value |
| --- | --- |
| URL | `https://<your-app>.up.railway.app/api/broadcast-ledger/receipts` |
| Method | `POST` |
| Headers | `x-broadcast-key: <BROADCAST_LEDGER_API_KEY>`, `Content-Type: application/json` |
| Request Body | JSON (below) |

```jsonc
{
  "source": "shortcut",
  "kind": "story",
  "title": "<Shortcut Input / headline variable>",
  "url": "<article URL variable>",
  "text": "<the text you posted>",
  "idempotencyKey": "shortcut-<Current Date, formatted yyyy-MM-dd-HH-mm>",
  "status": "posted",
  "destinations": [{ "channel": "telegram", "status": "posted" }]
}
```

Equivalent as curl, for testing before you build the shortcut:

```bash
curl -sS -X POST "https://<your-app>.up.railway.app/api/broadcast-ledger/receipts" \
  -H "x-broadcast-key: $BROADCAST_LEDGER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "shortcut",
    "title": "Fed holds rates steady",
    "url": "https://example.com/news/fed",
    "idempotencyKey": "shortcut-2026-08-19-1430",
    "status": "posted",
    "destinations": [{ "channel": "telegram", "status": "posted" }]
  }'
```

The `idempotencyKey` matters most here: phone network drops are exactly the
case where a shortcut gets retried, and the key is what stops the retry from
becoming a second receipt.

Optionally, add a *preflight* action at the start of the shortcut too —
`GET /lookup?url=<url>` — and stop if `posted` is true.

## Integration 3 — Manual posting

Two ways, both work with the gateway down:

0. **From Settings.** The dashboard's Settings page has a **Broadcast Ledger**
   card with an "Open Receipt Form" link, a live status pill, and a summary of
   the most recent receipt. It probes the site session first and falls back to
   your stored admin key, appending it to the link only when the session isn't
   what authorized you — so the link works either way.
1. **The form.** Bookmark `https://<your-app>/api/broadcast-ledger/manual` on
   your phone home screen (add `?key=<BROADCAST_LEDGER_API_KEY>` if you don't
   use the dashboard site login). Headline, optional URL, channels, status,
   save. It also lists the last 10 receipts, so you can see at a glance what
   the other two paths have already sent.
2. **A share-sheet shortcut.** A two-action shortcut that POSTs to `/manual`
   or `/receipts` with `source: "manual"`.

## Dashboard broadcasts

The reporter page's own Broadcast button writes a `kind: "digest"` receipt
automatically — a pending one before sending, then the real per-channel
Telegram results including message IDs. Its response now carries `receiptId`,
`status` and `destinations`.

One behavior change worth knowing: a broadcast that reaches some channels but
not others now returns `200` with `status: "partial"` and per-channel detail,
where it previously returned `502` and lost the record of what did land. A
broadcast where *nothing* landed still returns `502` as before.

## Railway variables

| Variable | Required | Notes |
| --- | --- | --- |
| `BROADCAST_LEDGER_API_KEY` | Recommended | The ledger key. Falls back to `ADMIN_API_KEY` if unset. Generate with `openssl rand -hex 32`. |
| `BROADCAST_LEDGER_RATE_LIMIT_PER_MIN` | No | Default `60`. Set `0` to disable. |
| `DATA_DIR` | Yes | Must be the mounted volume path (usually `/app/data`) or the ledger will not survive deploys. |
