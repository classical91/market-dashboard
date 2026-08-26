# Newsroom Cycles

One durable record per scheduled reporting run, linking the reporter's
generation log to the broadcast ledger's receipts.

Companion documents: [`broadcast-ledger.md`](broadcast-ledger.md) for the
receipt contract, [`newsroom-401-verification.md`](newsroom-401-verification.md)
for the production checks this repository cannot perform on its own.

---

## Why a cycle exists

Three durable records already existed before this:

- the **reporter generation log** (`reporter-generation-log.json`) — what was
  written, per section, with its content and prompt;
- the **broadcast ledger** (`broadcast-ledger.json`) — what was sent, per
  category, with destinations, Telegram message ids and attempt history;
- the **reporter cache** — the latest report the page renders.

None of them answers the question an operator actually has when a cron fires
into silence: *did the 13:00 run happen, and how far did it get?* A run that
failed before generating anything leaves no log entry and no receipt, so it is
indistinguishable from a run that never fired.

A cycle is that missing spine. It is deliberately thin — it stores no report
text and no message bodies, only identity, state, timings, links and
classified failures.

## Storage

`<DATA_DIR>/newsroom-cycles.json`, written whole under an exclusive lock and
via an atomic rename — the same `json-file-lock` primitives the broadcast
ledger and the reporter log use.

```json
{ "version": 1, "cycles": [ /* newest first */ ] }
```

No database was introduced. The reporter has no database layer to extend, the
existing locked/atomic JSON persistence was built for exactly this
fan-out-then-write pattern, and a cycle record is small enough that the default
200-cycle cap holds months of history. Adding PostgreSQL here would have meant
a new dependency, a new failure mode and a migration, in exchange for
properties this workload does not need. Revisit only if the app runs on more
than one replica — file locking is per-filesystem, and that is the assumption
the whole store inherits.

## Shape

| Field | Meaning |
| --- | --- |
| `id` | `cyc_<hash of cycleKey>` — deterministic, so the same slot yields the same id |
| `cycleKey` | `scheduled:<ISO minute>` for a scheduled run |
| `status` | see the state table below |
| `trigger` | `cron`, `manual`, `api`, `backfill` |
| `scheduledAt` / `startedAt` / `completedAt` / `updatedAt` | timings |
| `reporter` | `{ model, provider }` as configured at start |
| `sectionsExpected` | sections this run should produce |
| `sectionsGenerated` | one entry per produced section: timestamp, model, prompt hash, whether a custom prompt was used, content length, `reused`, `sources` |
| `receiptIds` | broadcast ledger receipts this cycle wrote |
| `destinations` | `{ newsType, chatId, threadId, messageId, status }` per target |
| `preflight` | the last preflight result and its checks |
| `failures` | classified failures, newest last, capped at 30 |
| `lastError` | the newest failure, duplicated for cheap health reads |

## States

```
queued -> generating -> generated -> delivering -> completed
```

Failure states:

| Status | Meaning |
| --- | --- |
| `preflight_failed` | configuration is wrong; nothing was generated and nothing was sent |
| `generation_failed` | at least one expected section could not be produced; **nothing is delivered** |
| `delivery_partial` | some categories landed, some did not |
| `delivery_failed` | the report exists, nothing landed |

Generation failures and delivery failures are deliberately different statuses.
**A cycle that generated its report and failed to deliver is redelivered, never
regenerated** — the text already exists, remaking it costs money and would
change what gets published.

Resuming is by design: re-running a `generation_failed` slot generates only the
sections that are still missing, then delivers. Re-running a `completed` slot
does nothing.

## Idempotency

A scheduled cycle's identity is derived from its slot, floored to the minute:
`scheduled:2026-08-26T13:00:00.000Z`. Find-or-create runs inside the store's
exclusive lock, so two cron invocations for the same slot — a retry, an
overlapping worker, a replayed webhook — either see one another's cycle or wait
for the lock and then see it. A second invocation that lands on an in-flight
cycle attaches to it and reports `skipped: "already-running"` rather than
starting a parallel run.

A cycle abandoned mid-run (a restart, a killed container) stops looking
in-flight after 15 minutes untouched, and the next invocation resumes it.

Category-level idempotency is unchanged and still enforced by the ledger: each
delivery writes a `pending` receipt before sending, under the key
`newsroom:<cycleId>:<newsType>`, and a category that already posted is
recognized rather than re-sent. That is what makes delivery retry safe.

## Failure classification

`src/services/failure-classification.js` labels every failure before it is
stored, so "was this worth retrying?" survives in the record rather than only
in the code path that decided at the time.

| Class | Examples |
| --- | --- |
| `retryable` | 429, 5xx, 408, `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`, aborts and timeouts |
| `non_retryable` | 401/403 (`auth`), 404 (`invalid_route`), 400/422 (`bad_request`), missing credentials, `provider_user_not_found` |
| `unknown` | anything unreadable — treated as *not* automatically retryable, so a repeating fault stays visible instead of looping |

`provider_user_not_found` is its own code because `HTTP 401: User not found`
means something different from a wrong API key: the identity behind the agent
route is not recognized. It points the operator at
[`newsroom-401-verification.md`](newsroom-401-verification.md) instead of
prompting another attempt with the same rejected credential.

## Source and evidence metadata

Each generated section records the citations the provider actually returned.
The Responses API attaches `url_citation` annotations to output text when the
`web_search` tool contributed to it; `extractSources()` reads exactly those.

**Known limitation.** When a response carries no annotations, the section is
recorded with `sources: []` and
`sourceMetadata: { available: false, reason: "The provider response exposed no
citations for this section." }`. No URL is ever inferred from the report text,
and none is reconstructed from the prompt. A model that summarizes without
citing leaves a cycle with no evidence trail beyond its content and timestamp,
and the record says so rather than implying coverage it does not have. If
stronger provenance is needed, it has to come from the provider — for example
by requiring citations in the section prompts and rejecting a response without
them, which is a product decision, not a storage one.

## API

Mounted at `/api/newsroom`. Reads sit behind the normal website access control;
writes additionally require `ADMIN_API_KEY`, because they spend provider credits
and push messages to real channels.

| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | site access | operational status (below) |
| `GET` | `/preflight` | admin | configuration check; starts nothing, sends nothing |
| `GET` | `/cycles` | site access | recent cycles (`limit`, `status`, `trigger`, `since`) |
| `GET` | `/cycles/:id` | site access | one cycle plus its generations and receipts |
| `POST` | `/cycles/run` | admin | start or resume a slot (`scheduledAt`, `trigger`, `deliver`) |
| `POST` | `/cycles/:id/deliver` | admin | retry delivery only — never regenerates |

`GET /health` returns the last successful cycle, the last attempted cycle, the
current cycle if one is running, the next expected run (when
`NEWSROOM_EXPECTED_RUN_TIMES_UTC` is set), the most recent classified error,
generated-section and delivery counts, and the reporter model. It carries no
credential, no prompt body and no report text.

`POST /cycles/run` is safe to call twice for the same slot — that is the point
of the deterministic key. An external cron should call it with the slot's
`scheduledAt`, so a retry of the same firing lands on the same cycle:

```bash
curl -X POST "$BASE/api/newsroom/cycles/run" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"scheduledAt":"2026-08-26T13:00:00.000Z","trigger":"cron"}'
```

## Preflight

Before a cycle spends anything it checks, locally and without any network call:
reporter credentials, reporter model, expected sections, category mapping,
Telegram credentials, destination routing for every expected category, and the
presence of the receipt store. A failed preflight produces a cycle record with
`preflight_failed`, the failing checks, and nothing sent.

One check is deliberately not a pass: `external-agent-route`. The
ShareBot/OpenClaw agent and its model route are configured outside this
repository, so the check reports "unverified here" rather than a verdict it did
not earn. `NewsroomService` accepts an `externalPreflight` async function as the
seam — supply one that queries the gateway and its verdict joins the preflight
under the same check name. The expected contract is
`async () => ({ ok: boolean, detail: string })`, and it must not post anything.

## What this does not do

- It does not schedule anything. No timer is started in this repository; the
  cron lives outside it and calls `POST /cycles/run`.
- It does not verify the OpenClaw side of the route. See
  [`newsroom-401-verification.md`](newsroom-401-verification.md).
- It does not change any existing behaviour of the Daily Reporter page, the
  broadcast route, or the ledger's dedupe and receipt rules. The per-category
  send both paths use now lives in `src/services/report-broadcast.js` so there
  is exactly one sender.

## Agent Office follow-up (not done here)

ShareBot's existing countdown/status area in the `agent-office` repository can
consume `GET /api/newsroom/health` directly — the response is shaped for a
compact panel:

| Panel row | Field |
| --- | --- |
| Last successful report | `lastSuccessfulCycle.completedAt` |
| Next expected cycle | `nextExpectedRunAt` |
| Generation status | `lastAttemptedCycle.status` + `generatedSectionCount` / `sectionsExpected.length` |
| Delivery status | `lastAttemptedCycle.deliverySucceeded` / `deliveryFailed` |
| Failed targets | `lastAttemptedCycle.deliveryFailed`, detail via `GET /cycles/:id` |
| ShareBot health | `status` plus `lastError.code` and `lastError.retryable` |

That change belongs in `agent-office`, which is a separate repository and was
not in scope for this work. Nothing here blocks it: the endpoint is live and
read-only, and no field it needs requires an admin key.
