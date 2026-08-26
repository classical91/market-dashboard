# Production verification — ShareBot `HTTP 401: User not found`

The ShareBot cron failed on **August 11** with `HTTP 401: User not found`.

**This failure is not reproduced or fixed by anything in this repository.** The
audit behind this document was carried out in a sandbox with no network access
to Railway, OpenClaw, OpenAI or Telegram, and no production secret. Every
external service in the test suite is mocked.

What follows is the checklist for someone who *does* have that access. Every
command below is read-only or explicitly non-delivering: **nothing here posts
publicly or sends a Telegram message.**

---

## What was searched, and what was found

A full search of this repository for the failure's possible in-repo causes:

| Looked for | Result |
| --- | --- |
| The string `User not found` anywhere in source, config, tests or docs | **Not present.** The app never generates this message. |
| OpenClaw / ShareBot model or provider configuration | **Not present.** The only references are comments, a ledger `source` label (`"sharebot67"`) and the ledger API contract in `AGENTS.md`. No agent route, gateway URL or provider identity is configured here. |
| Reporter provider configuration | `OPENAI_API_KEY` and `REPORTER_MODEL` (`src/config/env.js`), used directly against the OpenAI SDK. No gateway indirection. |
| A code path that could turn a valid credential into a 401 | None found. The reporter passes the configured key straight to the OpenAI client. |
| Anything that retries an authentication failure on a loop | **Was** possible before this change; now classified `non_retryable` and stopped. See below. |

**Conclusion: the cause is not in this repository.** `HTTP 401` with a
`User not found` body is a gateway/provider identity response — the credential
authenticated far enough to be looked up, and the identity behind it was not
found. That points at OpenClaw's agent registration, the Railway environment
the ShareBot cron runs with, or the provider account behind it. Do not treat the
issue as resolved on the strength of this repository's tests.

## What *was* fixed here

Not the 401 itself — the way this system responds to it:

- `HTTP 401: User not found` is now classified `non_retryable` with its own code
  `provider_user_not_found`, distinct from a plain wrong-key `auth` failure, and
  is no longer retried in a loop.
- The failure is persisted on the newsroom cycle with its phase, class, code and
  the provider's own message, so the next occurrence is visible in
  `GET /api/newsroom/health` rather than being inferred from silence.
- A preflight now runs before any generation or delivery, so a missing
  credential produces a readable cycle record instead of a half-finished run.
- **The agent route can now be checked automatically.** Set
  `NEWSROOM_AGENT_PREFLIGHT_URL` (plus `_TOKEN`, and `_EXPECT` for the agent
  identity) and every cycle verifies the gateway identity read-only before
  spending anything: a `User not found` fails the cycle at preflight, with the
  right code, instead of surfacing hours later as silence. Until that URL is
  set the route reports `warn: not verified` — never a pass.

Regression coverage: `test/newsroom-cycle.test.js` —
*"HTTP 401 \"User not found\" is classified as a provider identity failure"* and
*"an authentication failure is recorded as non-retryable"*;
`test/newsroom-agent-preflight.test.js` —
*"HTTP 401 \"User not found\" fails the check as a provider identity failure"*,
*"a rejected agent route fails preflight and the cycle spends nothing"* and
*"the token never appears in the result"*.

---

## Configuration to inspect

Collect these before running anything. Record **which** value is set, never the
value itself.

**In OpenClaw (outside this repo):**

1. The ShareBot/`newsreporter` agent's registered **agent id** and its owning
   user/account — this is the identity the 401 says was not found.
2. The **model route** the scheduled agent resolves to, and the provider account
   that route bills to.
3. Whether the agent's credential is a per-user key, an org key or a gateway
   token, and whether it was rotated, expired or moved between accounts on or
   before **August 11**.
4. The cron's own credentials, if the scheduled run authenticates differently
   from an interactive run. A route that works by hand and fails on a schedule
   is almost always this.

**In Railway (this app's service):**

5. `OPENAI_API_KEY` — set? which account?
6. `REPORTER_MODEL` — expected `gpt-5.4-mini` unless deliberately changed.
7. `ADMIN_API_KEY`, `BROADCAST_LEDGER_API_KEY` — set (needed for the checks below).
8. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` / `NEWS_TELEGRAM_*` — set.
9. `DATA_DIR` — pointing at the mounted volume, so cycles and receipts persist.

**Expected identity:** the scheduled ShareBot run should resolve to the same
agent, model route and provider account as an interactive `newsreporter` run. If
those differ, that difference is the finding.

---

## Safe dry runs

Run in order. None of these post publicly or send a Telegram message.

### 1. Local configuration preflight — sends nothing, spends nothing

```bash
curl -s "$BASE/api/newsroom/preflight" -H "x-admin-key: $ADMIN_API_KEY" | jq
```

**Expected success:** `"ok": true`, with `reporter-credentials`,
`reporter-model`, `telegram-credentials` and `news-routing` all `true`.
`external-agent-route` will report `skipped: true` — that is correct, not a
pass: this app cannot verify OpenClaw.

**Failure meaning:** any `ok: false` check is a configuration problem in *this*
service, and it is fixable in Railway without touching OpenClaw.

### 2. Provider credential and model route — read-only

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://api.openai.com/v1/models/gpt-5.4-mini \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

**Expected success:** `200`.

**Failure meaning:**
- `401` with `Incorrect API key provided` → the key itself is wrong or revoked.
- `401`/`403` with a *user or account* message → the key is valid but the
  identity behind it is not, which is the August 11 shape.
- `404` → the model route does not exist for this account. Check `REPORTER_MODEL`.

### 3. The same check against the OpenClaw route the cron actually uses

This repository does not know that gateway's base URL, so no exact command can
be given here. Ask OpenClaw for its identity endpoint (a `whoami`/agent-lookup
read, not a run) and call it **with the credentials the scheduled cron uses, not
an interactive session's**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$OPENCLAW_BASE/<identity-endpoint>" -H "Authorization: Bearer $SHAREBOT_CRON_TOKEN"
```

**Expected success:** `200` naming the ShareBot agent id and the account from
step 1–2.

**Failure meaning:** a `401: User not found` here reproduces the August 11
failure and localizes it to OpenClaw's identity for the cron's credential —
which is the answer this whole checklist is looking for. Nothing further in
this app needs changing.

**Once you have that endpoint, wire it in.** Set `NEWSROOM_AGENT_PREFLIGHT_URL`
to it, `NEWSROOM_AGENT_PREFLIGHT_TOKEN` to the cron's credential and
`NEWSROOM_AGENT_PREFLIGHT_EXPECT` to the agent id from step 1. Every cycle then
runs this exact check itself, read-only, before spending anything — so the next
time the identity breaks it fails at preflight with `provider_user_not_found`
rather than becoming another silent morning. Verify with step 1's preflight
call: `external-agent-route` should move from `warn` to `pass`.

### 4. Telegram credentials — read-only, sends nothing

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | jq '.ok, .result.username'
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=-1001841650798" | jq '.ok'
```

**Expected success:** `true` for both.

**Failure meaning:** a failure here is a *delivery* problem, not the reporter
401. `getMe` failing means the bot token is wrong; `getChat` failing means the
bot is not in that chat or the chat id is wrong.

### 5. Ledger read — no send

```bash
curl -s "$BASE/api/broadcast-ledger/lookup" -H "x-broadcast-key: $BROADCAST_LEDGER_API_KEY" \
  -H 'content-type: application/json' -d '{"headline":"verification probe"}' | jq
```

**Expected success:** `200` with `posted: false, match: "none"` — proof the
ledger is reachable and authenticating, with nothing written and nothing sent.

### 6. Optional: generate without delivering

This one **spends OpenAI credits**. It still sends nothing.

```bash
curl -s -X POST "$BASE/api/newsroom/cycles/run" \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"cycleKey":"manual:verification-401","trigger":"manual","deliver":false}' | jq '.cycle.status, .cycle.lastError'
```

**Expected success:** `"generated"` and `null`.

**Failure meaning:** `"generation_failed"` with
`lastError.code == "provider_user_not_found"` reproduces the August 11 failure
through this app's own path. `lastError.code == "auth"` means an ordinary bad
key instead.

Note: sections generated by this probe count as today's generation for those
sections, so the next scheduled cycle will reuse them rather than paying to
remake them. That is intended, but run it on a day where that is acceptable.

---

## Telling an auth failure from a delivery failure

Both end a cycle, and they are not the same problem:

| | Authentication / configuration | Delivery |
| --- | --- | --- |
| Cycle status | `generation_failed` (or `preflight_failed`) | `delivery_partial` / `delivery_failed` |
| `lastError.phase` | `generation` / `preflight` | `delivery` |
| `lastError.code` | `provider_user_not_found`, `auth`, `invalid_route`, `bad_request`, `missing_credentials` | `server_error`, `network`, `timeout`, `rate_limited` |
| `lastError.retryable` | `false` | usually `true` |
| Report text | does not exist | **exists** — never regenerate it |
| Ledger receipts | none written | receipts exist, some `failed`, with per-destination errors |
| Fix | credentials / agent route, outside this app | retry delivery: `POST /api/newsroom/cycles/:id/deliver` |

Read it with:

```bash
curl -s "$BASE/api/newsroom/health" | jq '.status, .lastError, .lastAttemptedCycle'
curl -s "$BASE/api/newsroom/cycles/<cycleId>" | jq '.receipts[] | {newsType, status, destinations}'
```

---

## Still requires production verification

- [ ] The ShareBot/`newsreporter` agent id and owning account in OpenClaw.
- [ ] The model route the *scheduled* agent resolves to, versus an interactive run.
- [ ] Whether the cron's credential was rotated, expired or reassigned on or
      before August 11.
- [ ] Steps 2–4 above against live credentials.
- [ ] Whether the 401 still reproduces at all — it may have been fixed
      incidentally by a later credential change, which the cycle history will
      show once cycles are being recorded in production.
