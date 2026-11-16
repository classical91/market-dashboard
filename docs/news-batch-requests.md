# On-demand FarmClaw Top 10

Today's Top 10 (`/top-news.html`) includes a request panel above the existing
manual Run News / Send to FarmBot controls. Requests ask Penny (`oss`) to route
research and preview preparation to FarmClaw (`commentfarm`). They do not call
OpenAI directly, approve content, create queue rows, start timers or publish.

## Deployment dependencies

1. Ship the companion Agent Office news integration and update the OpenClaw host's
   `scripts/openclaw-heartbeat.js` relay. Older relay versions omit the required
   claim attempt and cannot complete these news goals.
2. Set `NEWS_BATCH_SERVICE_TOKEN` to the same dedicated 32+ character secret on
   both servers. Set `NEWS_BATCH_AGENT_OFFICE_URL` to Agent Office's HTTPS origin
   on the dashboard. Never substitute the gateway token or a browser credential.
3. The dashboard needs the existing FarmBot HTTPS API and approval origins and
   `FARMBOT_NEWS_READER_TOKEN`. FarmClaw needs its existing Top 10-capable FarmBot
   helper, research workflow and server-side preparer token. FarmBot PR #179
   added this intake. No FarmBot code changes are needed here.
4. Mount persistent storage at `DATA_DIR` or `RAILWAY_VOLUME_MOUNT_PATH`. Requests
   live in `news-batch-requests.json` using the existing exclusive lock, atomic
   rename and fsync helpers. All request keys are retained; do not truncate the
   store or share it among replicas without a filesystem supporting these locks.
   Back it up like the other dashboard JSON stores. No SQL migration is needed.

The panel accepts the signed owner session or the existing admin-key fallback.
Alpha/read-only users cannot read or mutate requests. Tokens never enter page
HTML or API responses. With missing integration settings the ticket remains
durably **Blocked**, with an explanation.

## API and idempotency

- `GET /api/news-batch-requests`: newest 30 receipts and configuration readiness.
- `POST /api/news-batch-requests`: JSON `{ windowHours: 24|48, instructions?: string }`;
  a stable `Idempotency-Key` (16–128 letters/digits/underscores/hyphens) is required.
- `POST /api/news-batch-requests/:id/check`: retry handoff/status verification for
  that exact ticket. It does not reset the goal or start a second research task.

The browser retains uncertain submissions in session storage. Repeated clicks,
HTTP retries and another tab's identical active request return the same request;
a different active request returns 409. Changing the options under the same key
also returns 409. No key is discarded when a request completes.

The stable client batch ID is `dashboard-top10-YYYY-MM-DD-ondemand-<request UUID
without hyphens>`, with the day counted in Vancouver as in the existing Top 10
service. Retries and explicit FarmBot revisions retain it. The research window
is relative to the original request timestamp. Forty-eight-hour requests require
an explanation in the research evidence for every story older than 24 hours.

## Evidence and recovery

**Requested** is a local saved ticket; **Assigned** means Agent Office returned
the unique persisted Penny goal, still queued. **Running** requires a recorded
claim timestamp, attempt and Penny session. It does not by itself prove FarmClaw
has finished or that a preview exists.

An interrupted news claim is never automatically reclaimed. After 20 minutes
it appears **Blocked** and needs reconciliation with the existing Penny session
and FarmClaw child run in Agent Office. First look up the stable FarmBot batch
ID and inspect the existing session; never blindly reset the goal or start a new
research run. The same receipt can still be completed after reconciliation.
Failures and missing receipts surface safe messages; no upstream error body or
credential is returned to the browser. If a goal is explicitly failed, the UI
shows **Failed**; review that execution before deliberately making a new request.

**Preview Ready** requires Penny's current-attempt result to name the actual
`commentfarm` child execution and the exact client ID, batch ID, revision and hash.
The dashboard then independently reads FarmBot with its reader token and checks
`persisted`, `validated`, the server batch ID, revision and SHA-256 hash. Missing
or conflicting evidence stays blocked. The saved candidate timestamps must also
fit the requested window, with explanations for stories older than 24 hours.
The saved receipt describes that verified
revision; FarmBot always presents the current revision and determines whether
approval is still possible. A ready receipt never constitutes approval.

There is no callback endpoint. Status checks read authoritative current goal
state; generation checks reject late overlapping reads. Agent Office fences
news results by the active claim attempt. A response lost after intake or after
FarmBot persistence is recovered using the same IDs, without another job.

The server reconciles pending tickets every 15 seconds, including after restart
or an Agent Office outage, even with the page closed. It never starts a second
research job. The UI also checks on page load and every 15 seconds while visible.
Check progress or revisit to see a completed preview. Keep manual news generation,
scheduled FarmClaw jobs and manual imports
on their existing paths.

## Review and validation

Run `node --test test/news-batch-requests.test.js test/farmbot-top10.test.js
test/top-news-intake-route.test.js test/farmclaw-news-previews.test.js`,
`npm run lint`, `npm run build` and the repository's app boot check. The companion
Agent Office tests exercise concurrent intake, restart recovery, claim fencing
and existing orchestration, including PostgreSQL when `DATABASE_URL` is supplied.

No live agent dispatch or production deployment is part of these checks. After
the changes are reviewed and approved for deployment, validate one real request
through Penny and FarmClaw, and inspect the persisted FarmBot preview. Human
approval and timer start remain separate explicit actions.
