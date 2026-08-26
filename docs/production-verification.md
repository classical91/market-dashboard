# Broadcast Ledger — Production Verification

Companion to `docs/broadcast-ledger.md`. That document describes the contract;
this one separates what the repository can prove on its own from what only a
live Railway deployment, a real bot token and a real Telegram chat can answer.

The audit behind this document was carried out **entirely in a sandbox with no
network access to Railway, Telegram, OpenClaw, iOS Shortcuts or any production
secret.** Nothing below marked "requires production verification" was tested;
every external service was mocked.

---

## VERIFIED LOCALLY

Proven by repository inspection plus the automated suite (`npm test`). External
APIs are doubled in every case — no test touches Telegram, Railway or OpenClaw.

### Canonical ledger contract

- The six statuses (`pending`, `posted`, `partial`, `failed`, `blocked`,
  `reconciled`) round-trip through the store, the API and the operator page.
- `posted`, `partial` and `reconciled` all count as "this story went out" in
  lookup, reconcile, the `broadcasted` filter and the daily summary;
  `pending`, `failed` and `blocked` do not.
- A `failed` receipt is not evidence of a broadcast, and a receipt that reached
  `posted` is never walked back to `pending` by a late-arriving result.
- Receipts survive a new store instance over the same directory, and the file
  is capped so it cannot grow without bound.
- Message bodies are hashed, never stored.

### Category handling

- A supported sender-supplied category is recorded exactly as sent. There is no
  keyword inference anywhere in the send path — a story about Bitcoin with no
  label stays `Unclassified` rather than becoming `Crypto`.
- A missing category becomes `Unclassified` and raises the `missingCategory`
  notification, so the gap is visible rather than silently filled.
- An unsupported category is refused with `400` while `requireExactCategory` is
  on, rather than being rewritten.
- `Stock`, `Crypto`, `Geopolitics` and `Economics` are all present in the
  server's default allowed set and in the Ledger Settings UI.

### Destination routing

- One routing table (`src/services/news-routing.js`) serves first delivery,
  retry and the Daily Reporter. `Stock` / `Crypto` / `Economics` route only to
  the two finance topics, `Geopolitics` only to the War Room topic, and every
  other category keeps the general news fan-out.
- The locked targets **replace** the configured chat list rather than adding to
  it, so a broader `TELEGRAM_CHAT_IDS` cannot widen news routing.
- The routing decision reads the persisted `financeTopicRoutingEnabled`
  setting, so disabling it in Ledger Settings changes first delivery and retry
  together.
- The receipt records the destinations the send actually used, with the
  Telegram message ids from the real `sendMessage` response, and thread/topic
  ids are preserved through normalization, storage and retry.

### Idempotency and duplicates

- The same `idempotencyKey` advances one receipt instead of forking it, over
  the store API and over HTTP.
- Canonical-URL and content-hash matches are authoritative; the headline/time
  match is advisory (`match: "likely"`, `posted: false`) and never suppresses a
  story on its own.
- The channel watch attaches its message id to a receipt a sending path already
  owns rather than writing a second one, and re-reading the same update never
  creates a duplicate.
- A daily category limit reserves capacity through the guard's pending receipt,
  under an exclusive file lock, so two simultaneous attempts cannot both claim
  the last slot.

### Attempt history

- Every mutation appends `{ at, actor, action, ok, detail }`, capped at the last
  20 entries.
- Blocked attempts are stored as visible receipts (when
  `recordBlockedAttempts` is on) and stay distinguishable from failed
  deliveries by status and by attempt detail.
- Retry appends to history and preserves the original failure; reconciliation
  records `reconciledWith` without erasing the trail.

### Authentication

- Machine endpoints are key-only: an owner site cookie is not enough.
- The `?key=` parameter is honoured on the operator page path only, never on the
  machine endpoints.
- Unset keys return `503` (endpoints disabled), never an open ledger.
- Keys are compared with a timing-safe equality check.
- `/status` returns counts and receipt metadata only — no message content, no
  hashes, no bot token.
- Requests are rate limited per caller, not globally.

### Fixed during this audit

| Fix | What was wrong |
| --- | --- |
| Unclassified exempted from category-window blocking | One Channel Watch record of unrelated room chatter refused **every** category-less broadcast for the whole duplicate window. |
| Timestamp-safe day comparison | A receipt with no `createdAt` threw a `RangeError` and took the whole operator page down. |
| Retry honours `parseMode` | A story sent as plain text was retried as HTML, reproducing the failure it was meant to clear. |
| `?key=` no longer reflected unless it authorized the request | A crafted link rendered an owner's ledger with an attacker-chosen value pre-filled into every form. |
| Per-update error isolation in the channel watch | One unusable Telegram update aborted the batch before the offset saved, so it was re-read forever and everything behind it stayed unrecorded. |
| Resolved-category consistency in `/broadcast` | Daily limit and duplicate window read the raw supplied string while the receipt was filed under the resolved category. |
| `Stock` added to the Ledger Settings category list | Unchecking `Stock` removed its row, leaving no way to re-enable it from the UI. |

---

## RUN THIS FIRST — the automated half

Most of the environment, persistence and routing checks below can be answered
by the deployment itself. Two ways to get them:

```bash
node scripts/verify-broadcast-ledger.js \
  --url https://<your-app>.up.railway.app \
  --key "$BROADCAST_LEDGER_API_KEY"
```

or open `GET /api/broadcast-ledger/preflight` in a browser signed in as owner.

It reports pass/warn/fail per check with the reason, and ends with a verdict.
It **sends nothing** — no secret is ever echoed back, and delivery is never
exercised, so it is safe to run against production at any time.

What it cannot answer is listed under "Still requires a human" in its own
output, and marked below.

## REQUIRES PRODUCTION VERIFICATION

Anything the preflight covers is marked *(automated)*. The rest needs a person,
because each one puts a real message in a real room.

### Environment and persistence

- [ ] `DATA_DIR` points at the **mounted Railway volume** (usually `/app/data`), *(automated)*
      not ephemeral container storage. On ephemeral storage every deploy wipes
      the ledger.
- [ ] `BROADCAST_LEDGER_API_KEY` is set and is **not** the same value as *(automated)*
      `ADMIN_API_KEY`. The fallback exists for continuity, not as the target
      state.
- [ ] `NEWS_TELEGRAM_BOT_TOKEN` and `NEWS_TELEGRAM_CHAT_IDS` are set — these, *(automated)*
      not `TELEGRAM_*`, are what `/broadcast` and its retry send through.
- [ ] `BROADCAST_LEDGER_NOTIFICATION_CHAT_IDS` points at a **private** *(automated: set/unset only — only you can confirm it is private)*
      chat/topic. Blocked/failed/missing-category alerts go wherever this
      points; unset means alerts silently do not send.
- [ ] Confirm the app runs on a **single replica**. The store is a whole-file
      JSON writer with a file lock; it is safe across processes sharing one
      mounted volume, not across separate volumes.

### Telegram

- [ ] Confirm the destination ids and topic ids are still correct: *(automated: the report prints the resolved ids to eyeball)*
      `-1001841650798` topic `6297` and `-1001941064823` topic `984` for
      Stock/Crypto/Economics, and `-1001841650798` topic `75972` (the War Room)
      for Geopolitics. The repository does not prove these are right — it only
      proves the code routes to exactly these and nowhere else. All three now
      come from one shared table in `src/services/news-routing.js`, so the
      ledger and the Daily Reporter cannot drift apart.
- [ ] Confirm the news bot is an admin in both chats and may post to those
      topics.
- [ ] Confirm **only one consumer polls each bot token.** A second consumer *(automated: a shared token and an active 409 are both reported)*
      gets `409 Conflict` from Telegram. If `BROADCAST_LEDGER_INGEST_ENABLED`
      is `true`, the dashboard polls the `TELEGRAM_BOT_TOKEN` bot — verify
      nothing else does.
- [ ] Note the deliberate asymmetry: the channel watch polls the **dashboard** *(automated: the report says whether watched rooms overlap the news rooms)*
      bot while news is sent through the **news** bot. That keeps the news
      token free for its own consumer, but it means the watch only sees rooms
      listed in `TELEGRAM_CHAT_IDS`. Confirm the watched rooms are the ones you
      actually want audited, or accept that the watch covers nothing and every
      path must report itself.

### One controlled end-to-end test

- [ ] Send one real broadcast with an exact category through
      `POST /api/broadcast-ledger/broadcast`.
- [ ] Confirm a receipt appears on `/api/broadcast-ledger/manual`.
- [ ] Confirm the receipt carries the real destination **and** Telegram message
      id — not just a channel name.
- [ ] Confirm the daily summary and the Settings card both reflect it.

### Deliberately trigger the guard rails

- [ ] Send a second `Geopolitics` attempt on the same Vancouver day. Expect
      `409`, a visible `blocked` receipt, and (if enabled) a Telegram alert to
      the private notification target.
- [ ] Send a story with no category. Expect it to be recorded `Unclassified`
      and to raise a `missingCategory` alert.
- [ ] Send a second story in an already-used category inside its duplicate
      window. Expect `409` with `match: "category-window"`. Confirm
      `"force": true` overrides it when you genuinely intend a resend.

### A safe failed / retry scenario

- [ ] Temporarily point one destination at an invalid chat id, send, and
      confirm the receipt reads `partial` (or `failed` if nothing lands) with
      the per-destination error recorded.
- [ ] Restore the chat id and use the ledger page's **Retry** control. Confirm
      the retry goes to the same destinations, the receipt flips to broadcast,
      the attempt history shows both the failure and the retry, and no second
      receipt was created.

### Restart and reconnect

- [ ] Redeploy, then confirm the receipts from before the deploy are still
      there. If they are gone, `DATA_DIR` is not on the volume.
- [ ] Call `POST /reconcile` with `{ "windowMs": 172800000 }` after a gateway
      reconnect and confirm outstanding work is reported honestly rather than
      resolved away.

### iOS Shortcut / OpenClaw

- [ ] Confirm the Shortcut points at `/api/broadcast-ledger/broadcast` and not
      at `api.telegram.org`, so the bot token is no longer on the phone.
- [ ] Confirm the Shortcut sends an exact `newsType` and a stable
      `idempotencyKey`.
- [ ] Confirm ShareBot67 calls `/broadcast/guard` before every Geopolitics
      attempt and `/lookup` before other news, per `AGENTS.md`.

---

## Known limitations, stated rather than hidden

- **The channel watch cannot see this bot's own posts.** Telegram never returns
  a bot's outgoing messages through `getUpdates`. This is a protocol limit; any
  path sending through the bot must record itself.
- **The store is single-volume.** It is a whole-file JSON writer guarded by a
  lock file. Correct on one replica over one mounted volume; not a substitute
  for a database across independent instances.
- **The rate limiter is per instance.** The window resets on restart and the
  count is not shared. It stops a stuck client, it is not a security control —
  the API key is.
- **The category duplicate window is strict by design.** Default `42h` per
  category means a second story in the same category is refused for most of two
  days unless `force: true` is passed or the window is changed in Ledger
  Settings.
  This is intentional policy, not a bug; it is now documented in
  `docs/broadcast-ledger.md` so it stops surprising operators.
