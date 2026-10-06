# FarmClaw Handoff

How the **FarmClaw** button on X Intelligence cards gets a post to the FarmClaw
agent, and how the dashboard knows it got there.

## Why it is a queue

The button used to send the post link through the dashboard's Telegram bot
(`TELEGRAM_BOT_TOKEN`) to `FARMCLAW_TELEGRAM_CHAT` and show `FarmClaw ✓` as soon
as Telegram accepted the message. That proved only that the message was
delivered to Telegram. A message the dashboard bot sends is outbound, so it is
never an inbound event that the FarmClaw bot or agent acts on. The relay failed
in one of two ways:

1. Telegram rejected the send because the bot couldn't reach that chat, and the
   button showed `FarmClaw failed`.
2. Telegram accepted the send, the button showed `FarmClaw ✓`, and FarmClaw
   never saw it.

Now the dashboard only queues, FarmClaw pulls with its machine key, and the
button shows success only after FarmClaw's own receipt.

```
pending ──claim──▶ claimed ──receipt──▶ received
   └──────────────────┴──────fail──────▶ failed ──re-tap──▶ pending
```

Storage: `DATA_DIR/farmclaw-handoffs.json`. It uses the same locked, atomic
JSON-file pattern as the reporter news log and is safe on a single replica.

## Auth

- **Dashboard side** (create): an owner session or `x-admin-key`.
- **FarmClaw side** (claim, receipt, fail): `x-broadcast-key:
  $BROADCAST_LEDGER_API_KEY`, the key the OpenClaw agents already carry for the
  broadcast ledger and the reporter news log. `Authorization: Bearer` also
  works. This path is exempt from the site login, like the ledger.
- **Reads** (`GET`): either side.

## FarmClaw's loop

Poll on a schedule. Once a minute is plenty.

1. `POST /api/farmclaw/handoffs/claim` with `{ "agent": "farmclaw", "limit": 10 }`.
   It returns `{ records: [...] }`: pending items, oldest first, plus any whose
   claim lease (10 minutes) expired without a receipt. Every call records
   `lastPollAt`, including an empty one, and the button shows it. A FarmClaw
   that stops polling is therefore visible on the dashboard.
2. Take each item into FarmClaw's own workflow, for example by creating its task
   or queue entry from `record.url`.
3. Acknowledge each one with
   `POST /api/farmclaw/handoffs/:id/receipt` and
   `{ "receiptId": "<FarmClaw's own id for that task>", "agent": "farmclaw" }`.
   Only send this after FarmClaw has the item durably. The receipt is the
   dashboard's only definition of success.
   - Re-sending the same `receiptId` is idempotent (`200`).
   - A different `receiptId` for an already-received handoff returns `409`.
4. If FarmClaw can't take an item, report it with
   `POST /api/farmclaw/handoffs/:id/fail` and `{ "error": "<exact error>" }`.
   The button shows the error. The next tap re-queues the item. A received
   handoff can't be failed afterwards (`409`).

If FarmClaw crashes between claiming and acknowledging, do nothing. The lease
runs out and the next claim hands the item out again. Its `attempts` count goes
up. A receipt for a handoff whose lease expired is still accepted.

## FarmClaw's collector and task store

`scripts/farmclaw-collector.js` is the consumer. Run it on FarmClaw's host,
not on the dashboard. Each pass does four things, in order:

1. **Claim** pending handoffs.
2. **Write a task** for each one to FarmClaw's task store
   (`FARMCLAW_INTAKE_FILE`).
3. **Deliver** the task to the FarmClaw OpenClaw agent, through the gateway's
   `POST /hooks/agent` (built in) or a custom `FARMCLAW_DELIVER_CMD`.
4. **Send the receipt** (`receiptId` = the task id `fct_...`, `note` = the
   delivery id, e.g. `openclaw-run:<runId>`).

The collector owns the claim and receipt payloads. The delivery step never
talks to the dashboard, so it can't send them wrong.

A task file on its own is not FarmClaw's workflow, because nothing reads it.
An earlier version stopped at step 2: it claimed links and wrote local tasks
that the FarmClaw agent never saw. `run` and `watch` therefore refuse to start
without a delivery configured, unless `--local-only` is passed explicitly.

### Delivering to the FarmClaw OpenClaw agent (gateway hook)

The OpenClaw gateway accepts external agent turns on `POST <hooks.path>/agent`.
Hooks are off by default. On FarmClaw's gateway host, enable them for the
FarmClaw agent only, with a dedicated token (not the gateway auth token):

```json5
// openclaw config
{
  hooks: {
    enabled: true,
    token: "<long-random-hook-token>",
    path: "/hooks",
    allowedAgentIds: ["farmclaw"],     // the FarmClaw agent's configured id
    allowRequestSessionKey: false,
  },
}
```

Then run `openclaw config validate` and `openclaw gateway restart`. Start the
collector on the same host:

```bash
export BROADCAST_LEDGER_API_KEY=...                                  # dashboard machine key
export FARMCLAW_OPENCLAW_HOOKS_URL=http://127.0.0.1:18789/hooks      # gateway port + hooks.path
export FARMCLAW_OPENCLAW_HOOK_TOKEN=<long-random-hook-token>         # same as hooks.token
export FARMCLAW_OPENCLAW_AGENT_ID=farmclaw                           # default shown
# Optional: also announce the run's result to a chat (both or neither):
# export FARMCLAW_OPENCLAW_CHANNEL=telegram FARMCLAW_OPENCLAW_TO=<chat id>

node scripts/farmclaw-collector.js deliver-test --link https://x.com/...   # starts one TEST run; check FarmClaw saw it
node scripts/farmclaw-collector.js watch --interval 60                     # the recurring collector
```

Each delivery is one isolated FarmClaw agent turn whose message is the handoff
text below. With no announce destination, OpenClaw posts the completion to the
FarmClaw agent's main session (`deliver: true`). The gateway answers
`200 { ok: true, runId }` once the run is admitted. That `runId` becomes the
delivery id, and only then is the dashboard receipt sent. Admission means the
agent has the link, not that its turn finished. FarmClaw's own next steps, such
as its FarmBot intake, are not tracked by the dashboard.

Duplicates: each request carries `Idempotency-Key: farmclaw-<taskId>` and an
identical body, so the gateway replays the same run for a repeated request.
It keeps that replay entry while the run is active and for 5 minutes after it
settles, and forgets it on restart. A lost response is therefore retried right
away (3 attempts in total). If none is answered, the outcome is **unknown** and
the collector does not re-send it later; see Outcomes.

| Gateway answer | Outcome |
| --- | --- |
| `200 { ok: true, runId }` | delivered |
| `400` (bad agent id or destination), `401` (token), `404` (hooks off or wrong path), `409`, `413`, `429`, `502`, `503` | failed: the run was not admitted. Retried on lease expiry, then reported with the gateway's error |
| No response after 3 attempts, or a `200` without `runId` | unknown: reported and not re-sent |

### Other runtimes: a delivery command

Instead of the hook, `FARMCLAW_DELIVER_CMD` can be any command that posts the
item into the agent. Setting both is an error.

```bash
export BROADCAST_LEDGER_API_KEY=...                  # the machine key
export FARMCLAW_DELIVER_CMD='...'                    # posts into the FarmClaw session
export FARMCLAW_INTAKE_FILE=~/.farmclaw/intake.json  # default shown
# FARMCLAW_DASHBOARD_URL defaults to the production dashboard.

node scripts/farmclaw-collector.js deliver-test --link https://x.com/...   # try delivery alone first
node scripts/farmclaw-collector.js watch --interval 60                     # the recurring collector
node scripts/farmclaw-collector.js run                                     # one pass, e.g. from cron
```

### Delivery command contract

`FARMCLAW_DELIVER_CMD` is a shell command, for example the OpenClaw call that
posts a message into FarmClaw's Telegram session. For each task:

- **stdin** gets one JSON object:
  `{ version, handoffId, taskId, url, canonicalUrl, handle, text, attempt, message }`.
  `message` is ready to post:

  ```
  FarmClaw handoff from X Intelligence
  <url>
  @handle: <post text>
  Ref: fct_... (handoff fch_...)
  ```

- The environment gets `FARMCLAW_HANDOFF_ID`, `FARMCLAW_TASK_ID`,
  `FARMCLAW_URL` and `FARMCLAW_MESSAGE`.
- **Exit 0** means delivered. The last stdout line must be
  `{"deliveryId": "<the session's message or run id>"}`.
- **Non-zero exit** means nothing was sent. The last stderr line is the error.

`deliver-test` runs only this command, with a payload marked `"test": true`. It
makes no dashboard calls and writes no task. Use it to check a command before
`watch` uses it.

### Outcomes

| What happened | Collector does | Dashboard shows |
| --- | --- | --- |
| Delivered, receipt accepted | Records `deliveryId`, sends the receipt | `received` |
| Command exited non-zero | No receipt. Retried after each lease expiry, 3 attempts in total | `claimed`, then `failed` with `Delivery to the FarmClaw session failed 3 times: <stderr>` |
| Timed out (`FARMCLAW_DELIVER_TIMEOUT_MS`, default 60s), or exit 0 without a `deliveryId` | Reports `/fail` and **never re-sends on its own**, because the message may already be in the session | `failed` with "unknown outcome … Not re-sent" |
| Delivered, receipt lost | Next claim skips delivery and re-sends the same receipt | `received` |
| Task file can't be written | `/fail` with `FarmClaw intake store write failed: <error>` | `failed` |
| Receipt `409` | Recorded on the task as `receiptError`; never retried with another id | unchanged |

A re-tap of a `failed` handoff starts a fresh round of delivery attempts. The
one exception is an unknown outcome: check the FarmClaw session first, then
resolve it:

```bash
# It did arrive: record it and send the receipt now (the dashboard flips to received).
node scripts/farmclaw-collector.js task fct_... --delivery delivered --delivery-id <session msg id>
# It did not arrive: clear the in-flight mark, then tap FarmClaw on the post again.
node scripts/farmclaw-collector.js task fct_... --delivery retry
```

Network errors keep their cause, for example
`fetch failed (ENOTFOUND getaddrinfo ENOTFOUND host)` instead of a bare
`fetch failed`.

The task file is written atomically and fsynced, then read back. Intake is
idempotent on the handoff id. `run` exits `2` if any item had an error. `watch`
logs a failed pass and tries again on the next tick. Overlapping runs are safe,
because leases prevent double claims and the store is locked.

### Working tasks

```bash
node scripts/farmclaw-collector.js tasks --status open --json
node scripts/farmclaw-collector.js task fct_... --status in_progress
node scripts/farmclaw-collector.js task fct_... --status done --note "drafted"
```

Task statuses are `open`, `in_progress`, `done` and `dropped`. `task` also
accepts the handoff id. These statuses are FarmClaw's own and are not reported
back to the dashboard. The dashboard's contract ends at the receipt.

To keep `watch` running, use a process manager, for example a systemd user
unit or `pm2 start scripts/farmclaw-collector.js -- watch`. Alternatively, run
`run` every minute from cron. Only one of the two is needed.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/farmclaw/handoffs` | dashboard | Queue `{ url, handle?, text? }`. `201` new, `200` existing. |
| `POST` | `/api/x/farmclaw` | dashboard | Alias of the above, kept for older pages. |
| `GET` | `/api/farmclaw/handoffs/:id` | either | One handoff plus `agent: { lastPollAt, lastPollAgent }`. |
| `GET` | `/api/farmclaw/handoffs?status=pending` | either | Recent handoffs, newest first. |
| `POST` | `/api/farmclaw/handoffs/claim` | FarmClaw | Lease pending/expired items. |
| `POST` | `/api/farmclaw/handoffs/:id/receipt` | FarmClaw | Mark received with `receiptId`. |
| `POST` | `/api/farmclaw/handoffs/:id/fail` | FarmClaw | Mark failed with the exact `error`. |

Creating a handoff is idempotent on the canonical URL, using the same
canonicalizer as the broadcast ledger. Tracking params, `www.` and a trailing
slash don't create a second handoff.
