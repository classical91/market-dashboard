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

The loop above needs somewhere durable for step 2. Without one, FarmClaw can
claim items but must never acknowledge them, so they bounce between `claimed`
and `pending` forever. `scripts/farmclaw-collector.js` is that consumer. Run it
on FarmClaw's host, not on the dashboard:

```bash
export BROADCAST_LEDGER_API_KEY=...                 # the machine key
export FARMCLAW_INTAKE_FILE=~/.farmclaw/intake.json  # default shown
# FARMCLAW_DASHBOARD_URL defaults to the production dashboard.

node scripts/farmclaw-collector.js watch --interval 60   # the recurring collector
node scripts/farmclaw-collector.js run                   # one pass, e.g. from cron
```

Each pass claims, writes every item to FarmClaw's task store
(`FARMCLAW_INTAKE_FILE`), and only then sends the receipt. The `receiptId` is
the task id (`fct_...`).

- The task file is written atomically and fsynced, then read back before the
  receipt is sent. A receipt therefore always names a task that is on disk.
- Intake is idempotent on the handoff id. If the receipt is lost (network,
  crash, 5xx), the task is kept. The lease expires, the item is handed out
  again, and the same receipt id is re-sent. No duplicate task is created.
- If the store can't be written (disk error, or a corrupt file that it refuses
  to overwrite), the collector calls `/fail` with
  `FarmClaw intake store write failed: <error>` and sends no receipt.
- A `409` on the receipt (another receipt already exists) is recorded on the
  task as `receiptError` and is never retried with a different id.
- `run` exits `2` if any item had an error. `watch` logs a failed pass and
  tries again on the next tick. Overlapping runs are safe, because leases
  prevent double claims and the store is locked.

FarmClaw works its tasks from the same file:

```bash
node scripts/farmclaw-collector.js tasks --status open        # add --json for machines
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
