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
{ "version": 2, "cycles": [ /* newest first */ ] }
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
| `sectionsGenerated` | one entry per produced section: timestamp, model, prompt hash, whether a custom prompt was used, content length, `reused`, `reusedFromCycleId`, `generationRef`, `sources` |
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

## Cycle-exact delivery

A cycle is retried by *delivering* it again, never by regenerating it. That
makes one question load-bearing: **what did this cycle actually write?**

`peekReport()` cannot answer it. It returns the latest content per section,
which is the right answer for the Daily Reporter page and the wrong one here:

```text
1. Cycle A generates Crypto A.
2. Cycle A's Telegram delivery fails.
3. Cycle B, later, generates Crypto B.
4. Cycle A's delivery is retried.
5. peekReport() now holds Crypto B.
6. Crypto B goes out under cycle A's receipts, message ids and audit trail.
```

Filtering out sections the cycle never generated does not close this: cycle A
*did* generate crypto, so crypto is retained — and the content retained is
still cycle B's. The retained set was right; the content behind it was not.

So each generated section records the generation it *is*:

```json
"generationRef": {
  "cycleId": "cyc_1a2b3c4d5e6f7a8b",
  "generatedAt": "2026-08-26T13:00:04.118Z",
  "section": "crypto"
}
```

Delivery rebuilds the report from those references, section by section, out of
the durable generation log. `ReporterService.getGenerationForReference()` is
the only read it uses, and it resolves on exact identity:

- `section` is required;
- `generatedAt` matches the **exact instant**, never a nearest or latest match;
- `cycleId`, when the reference carries one, must match the log entry's. A
  `null` `cycleId` is meaningful — it says the generation was made outside a
  cycle (a manual studio run, or history written before cycles existed) — and
  identity then rests on section plus exact timestamp alone.

Anything other than a single match fails. Nothing falls back to "latest".

### Reused generations

A cycle that reuses today's existing report writes no new generation log entry,
so its reference points at the **original** generation, under the cycle that
first produced it:

```text
Cycle B -> generationRef { cycleId: cycle A, generatedAt: A's instant } -> A's content + A's sources
```

`reused: true` and `reusedFromCycleId` travel on the same entry, so the
relationship is readable without following the reference. No empty generation
is ever fabricated to give the reusing cycle a log entry of its own.

This is also why `GET /cycles/:id` no longer resolves generations by querying
the log for the cycle's own id: a reused section has no entry under that id, so
the query came back missing it. Cycle detail now resolves every recorded
section through its reference, reused sections included.

### Failing closed

If a cycle says a section was generated and its exact generation cannot be
uniquely recovered, delivery **stops for that section**. It does not substitute
the current report, does not regenerate, and sends no Telegram message. The
cycle records a classified, non-retryable failure:

| Code | Meaning |
| --- | --- |
| `generation_reference_missing` | no stored generation matches the reference — pruned, lost with the volume, or never written |
| `generation_reference_ambiguous` | more than one stored generation matches, so the reference identifies none of them |
| `generation_reference_invalid` | the reference names no known section, or carries no usable timestamp |

The failure is visible where every other cycle failure is: on the cycle record,
in `GET /api/newsroom/health` as `lastError`, and on `GET /cycles/:id`, where
the affected section comes back `resolved: false` with its code rather than
being silently dropped.

With the default `NEWSROOM_ALLOW_PARTIAL_DELIVERY=false`, one unresolvable
section stops the whole delivery — the same rule that already governs a cycle
missing an expected section. With partial delivery on, the sections that *are*
proven go out and the cycle ends `delivery_partial`, never `completed`.

### Older records

Cycle records written before references existed have none, and **nothing
rewrites or deletes them**. They are resolved by what they do carry — the
cycle's own id, the section, and the section's exact generated timestamp —
tried in that order and then by section plus exact timestamp, which is how a
legacy cycle that reused a section resolves, since that text was logged under
the cycle that first wrote it. Both attempts pin an exact instant. Neither
widens to "latest", and an ambiguous or absent match fails closed exactly as a
modern reference does.

Regression coverage: `test/newsroom-cycle-integrity.test.js`.

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
| `GET` | `/health` | site access **or** `x-admin-key` | operational status (below) |
| `GET` | `/preflight` | admin | configuration check; starts nothing, sends nothing |
| `GET` | `/cycles` | site access | recent cycles (`limit`, `status`, `trigger`, `since`) |
| `GET` | `/cycles/:id` | site access | one cycle plus its referenced generations and its receipts |
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

### Machine access to `/health`

Site login runs before every API router, so a caller with no browser session is
answered `401 Login required` before the newsroom router is ever reached. Agent
Office's ShareBot67 panel is exactly that caller: it reads this endpoint from
its **own Node process**, never from browser JavaScript, because the dashboard
key must not reach a browser.

`GET /api/newsroom/health` therefore has a narrow machine-read exemption in
`src/middleware/site-auth.js`, modelled on the Trading Lab one that already
existed:

```bash
curl -s "$BASE/api/newsroom/health" -H "x-admin-key: $ADMIN_API_KEY" | jq
```

The exact boundary:

| | Allowed |
| --- | --- |
| Method | `GET` and `HEAD` only |
| Path | `/api/newsroom/health` exactly (a trailing slash is the same resource) |
| Credential | a valid `x-admin-key` **header** |
| Query authentication | none — `?key=` and friends do not authenticate |

Everything else in the namespace is unchanged and stays behind the owner
session: `/cycles`, `/cycles/:id` (which carries report text), `/preflight`,
`POST /cycles/run` and `POST /cycles/:id/deliver`. The admin key opens none of
them through this route, and the owner/alpha session model is untouched — an
alpha read-only session still cannot read newsroom health.

The endpoint is safe to expose this way because of what it does not carry: no
credential, no prompt body, no report content — identifiers, statuses, counts,
timestamps and the provider's own error message.

Pinned by `test/newsroom-health-machine-read.test.js`.

## Preflight

Before a cycle spends anything it checks, locally and without any network call:
reporter credentials, reporter model, expected sections, category mapping,
Telegram credentials, destination routing for every expected category, and the
presence of the receipt store. A failed preflight produces a cycle record with
`preflight_failed`, the failing checks, and nothing sent.

Checks carry a `status` of `pass`, `warn` or `fail` alongside `ok`, matching the
broadcast preflight's vocabulary. The two differ in exactly one place, below.

### The agent route check

`external-agent-route` is the one question this service cannot answer from its
own configuration: *does the credential the scheduled run carries still resolve
to the agent we think it is?* On August 11 it did not, and the answer came back
from the gateway as `HTTP 401: User not found`.

Set `NEWSROOM_AGENT_PREFLIGHT_URL` to the gateway's identity endpoint and the
check becomes a real gate — a credential the gateway no longer recognizes fails
the cycle *before* it spends anything, instead of surfacing as an unexplained
silence hours later. It is deliberately narrow:

- **GET only.** A preflight must never make the agent do work; a POST to a
  gateway is how a "check" becomes a run.
- **The token never leaves.** It goes out in a header and never appears in the
  result — not even when the gateway echoes it back in an error body.
- **`warn`, not `pass`, when unconfigured.** An unverifiable route is not a
  healthy one, it is an unknown one, and calling it a pass is how the August 11
  failure stayed invisible for as long as it did. The cycle still runs.
- **A wrong identity fails.** With `NEWSROOM_AGENT_PREFLIGHT_EXPECT` set, a
  route that resolves to a *different* agent fails as `identity_mismatch`.
  Without it, the check says plainly that it proved the credential resolves,
  not which agent it resolves to.

`NewsroomService` still accepts any `externalPreflight` async function as the
seam; `createAgentRoutePreflight()` is the built-in implementation. The contract
is `async () => ({ ok, status, detail, code? })`, and it must not post anything.

`GET /api/newsroom/health` lifts the result to `agentRoute: { status, verified,
detail, code }` so a status panel can show it without reading cycle detail.

### Incomplete cycles

By default a cycle missing an expected section delivers **nothing**
(`generation_failed`): a digest that silently drops a category reads as a
complete report to everyone in the room, and the next run of the same slot
generates only what is missing and then delivers.

Set `NEWSROOM_ALLOW_PARTIAL_DELIVERY=true` when a late category is worth less
than a late report. Then what exists goes out, with two guarantees:

- the cycle ends `delivery_partial`, never `completed`, while an expected
  section is missing — including on a delivery *retry*, which recomputes
  completeness from the record rather than trusting the caller;
- **only sections this cycle generated are sent**, and only from this cycle's
  own generations. Delivery never reads the latest cache, so a section today's
  run failed to produce cannot ride along from yesterday's copy, and a section
  whose generation cannot be proven is not sent at all — see
  [Cycle-exact delivery](#cycle-exact-delivery).

## What this does not do

- It does not schedule anything. No timer is started in this repository; the
  cron lives outside it and calls `POST /cycles/run`.
- It does not verify the OpenClaw side of the route. See
  [`newsroom-401-verification.md`](newsroom-401-verification.md).
- It does not change any existing behaviour of the Daily Reporter page, the
  broadcast route, or the ledger's dedupe and receipt rules. The per-category
  send both paths use now lives in `src/services/report-broadcast.js` so there
  is exactly one sender.

## The Agent Office panel

ShareBot67's panel in the `agent-office` repository reads `GET
/api/newsroom/health` **server-to-server** — Agent Office's own Node process
holds the dashboard key and normalizes the response for the browser, so the key
never reaches browser JavaScript. The response is shaped for that compact
panel:

| Panel row | Field |
| --- | --- |
| Last successful report | `lastSuccessfulCycle.completedAt` |
| Next expected cycle | `nextExpectedRunAt` |
| Generation status | `lastAttemptedCycle.status` + `generatedSectionCount` / `sectionsExpected.length` |
| Delivery status | `lastAttemptedCycle.deliverySucceeded` / `deliveryFailed` |
| Failed targets | `lastAttemptedCycle.deliveryFailed`, detail via `GET /cycles/:id` |
| ShareBot health | `status` plus `lastError.code` and `lastError.retryable` |
| Agent route | `agentRoute.status` and `agentRoute.verified` |

The adapter and the panel live in `agent-office`; this side of it is the
endpoint and the machine-read exemption above. The panel is read-only by
design: it offers no run, retry or Telegram control, and nothing on it can
cause this app to generate or send anything.
