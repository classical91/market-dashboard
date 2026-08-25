# Learning-journal recovery — binding constraints

Amendments to the recovery plan, verified against
`traderclaw/journal-recovery` @ `ed20197e315ae71ce78d95fc68660984fad4cf85`.

These are acceptance conditions, not suggestions. Where a condition says
*fail closed*, the planner must exit non-zero with an explicit reason and
emit no manifest. A recovery that cannot be proven complete must not be
presented as complete.

The read-only boundary is unchanged: investigate, patch, test, query
read-only data, commit. No production writes until the manifests are
reviewed and approved.

---

## 1. Capture the production API contract before writing any code

The checked-out source returns strategy-account history as a **plain array**
(`src/services/trading/trading-lab.js:646`):

```js
history: history.slice(-limit).reverse(),
totalTrades: history.length,
```

The planner consumes it as one (`scripts/plan-learning-journal-recovery.js`):

```js
["closed", detail.history || []]
```

Before touching the planner, do a read-only capture of the real production
response for `/api/trading-lab/strategy-accounts/:id` and record, verbatim:

- the concrete type of `history` (array vs. object)
- `totalTrades`
- the number of rows actually returned
- any pagination/cursor fields present
- whether the response matches the checked-out source

Do not infer the shape. Do not invent pagination parameters.

### 1a. `history: { items: [...] }` is a stop condition, not a schema to support

**No branch in this repository has ever produced that shape.** `main` and
`traderclaw/journal-recovery` both return the plain array above, and
`git log -S'history: {'` over that file matches no commit on any ref.

The `{ items, total, returned, truncated, openingBalance }` envelope belongs
to a *different* endpoint — `/api/trading-lab/history`
(`src/routes/trading-lab.js:143-167`). Two readings follow, and they need
different responses:

- **The observation came from `/history`.** Then the endpoints were
  conflated, the detail endpoint is fine, and no shape-compatibility work is
  needed. Confirm which URL produced the sample.
- **`/strategy-accounts/:id` really does nest `{items}` in production.** Then
  the deployed artifact is running code that exists on no committed branch.
  That is not deployment lag — lag serves *older* committed code. Stop and
  report it. Do not write a compatibility shim that normalizes both shapes:
  a shim would make an unexplained divergence invisible, which is the
  opposite of what an incident recovery is for.

### 1b. There is no pagination to implement — assert completeness instead

`/strategy-accounts/:id` exposes no offset and no cursor. The only knob is
`limit`, clamped to 1000 (`src/routes/trading-lab.js:347`) and anchored to
the tail via `history.slice(-limit)`. Trades older than the last 1000 are
unreachable through this endpoint at any parameter combination.

So the plan's "implement pagination" step is not achievable read-only, and
is not needed. `totalTrades` already carries the ground truth. Require:

```
returned === totalTrades   →  complete, proceed
returned <  totalTrades    →  fail closed, report the shortfall per account
```

Fail closed names the account, `returned`, and `totalTrades`. Extending the
endpoint's window is a source change and a separate, approved piece of work.

---

## 2. Freeze the incident window at both ends

The known fact — *56 executions opened since 2026-08-20T00:00:00Z* — is only
an acceptance criterion against a fixed end timestamp. The strategies keep
running, so an open-ended "since August 20" drifts to 57, 58, 59 while the
work is in progress.

The planner currently applies no date filter at all: it collects every open
position and every history row it receives.

Require explicit bounds:

```
--from 2026-08-20T00:00:00Z --through <audit-snapshot-time>
```

Both are mandatory; neither gets a default. The planner filters on the
position's opening timestamp, and asserts that **exactly 56 distinct position
IDs** fall inside the frozen window. Any other count is a fail-closed
condition reported with the actual count and the boundary rows.

Record the snapshot time in the manifest so the run is reproducible.

---

## 3. Duplicate position IDs abort; they are never collapsed

The planner currently does:

```js
const byId = new Map(executions.map((row) => [row.positionId, row]));
```

Two records sharing a `positionId` silently collapse to one, last-write-wins.
`byId.size` then feeds `reconciliation.matched`, so a collapse quietly
corrupts the count the whole recovery is judged on.

This is not theoretical. Position IDs are not UUIDs
(`src/services/trading/paper-trader.js:410`):

```js
id: `PT${Date.now()}${Math.floor(Math.random() * 1000)}`
```

Millisecond timestamp plus one of 1000 random values. Two positions opened in
the same millisecond — routine when the scanner opens across strategies in a
single tick — collide with probability 1/1000. Each account keeps its own
ledger, so nothing prevents a cross-account collision, and a collision
between accounts would report a genuinely missing trade as matched.

Required behaviour, for both execution rows and journal
`trade_state.position_id` entries:

| Case | Action |
|---|---|
| Identical duplicate records | Report, deduplicate, continue |
| Conflicting duplicate records | **Abort.** Emit both records in full |

Last-write-wins is prohibited as a conflict resolution anywhere in the
planner. Duplicate and conflict counts appear in the manifest even when zero.

---

## 4. Synthesized attribution is not evidence

`normalizeEntry()` in `src/services/trading/signal-action-store.js` manufactures
attribution for legacy rows on read: it derives a
`legacy-signal-action-<hash>` ID, sets `source = "signal-bot"` and
`strategy = signal-bot:<interval>`, and marks `attributionRecovered = true`.
A test on the branch asserts exactly this behaviour.

The planner then counts those flags as a finding:

```js
recoveredLegacyAttribution: actions.filter((row) => row.attributionRecovered === true).length
```

`/signal-actions` reads through `SignalActionStore.recent()`, which normalizes.
So the API view of the 167 Signal Bot rows already contains the inference that
the repair is supposed to be auditing. Counting it as evidence would prove the
attribution using the very heuristic under audit.

The rule *never guess missing attribution* governs. Therefore:

- Do **not** treat `attributionRecovered` as authoritative support for
  repairing the 167 rows, regardless of the field's name or the branch's
  framing of it as "recovered".
- Base the repair analysis on the **raw persisted rows** —
  `_read({ normalize: false })` bypasses normalization — or on sanitized
  fixtures derived from them, not on the normalized API view alone.
- Classify every field into exactly one of four buckets, and carry the bucket
  into the manifest:

  1. **raw persisted** — present in the stored bytes
  2. **derived at read time** — synthesized by `normalizeEntry()`
  3. **authoritative linked evidence** — corroborated by an independent record
  4. **unresolved** — everything else

Only bucket 3 justifies a repair. Bucket 2 is a hypothesis to be tested
against bucket 3, never a substitute for it. Anything that cannot be placed
in bucket 3 goes to `unresolved` and stays there.

---

## 5. Repairs bind to a source snapshot

The plan stops before production writes; keep that. Design the *eventual*
write path so it cannot repair a moving target:

```
expected source hash + row count  →  apply  →  verify
```

If the Signal Bot store changes between the dry run and approval, the repair
command aborts rather than applying a manifest built against different bytes.

Each repairable row in the manifest carries:

- stable selector
- original values
- proposed additions
- evidence source
- evidence reason

Any ambiguity routes to `unresolved`. A manifest entry with no bucket-3
evidence is malformed.

---

## 6. External file boundary

Read-only inspection of `workspace-trader/learning-journal/journal_cycle.py`
is permitted where accessible, to identify its owning runtime.

Do not modify, create, or recreate any file outside `market-dashboard`. If the
file is outside the available workspace, report what could not be verified.
Do not reconstruct it from inference.

---

## Testing

`test/learning-journal-recovery.test.js` currently holds three small tests,
and its fixture models `history` as an array — which is why a shape mismatch
would not be caught. Expand coverage to include:

- the production response shape, exactly as captured in §1
- `returned < totalTrades` truncation → fail closed
- window filtering, including rows on both boundaries
- the 56-count assertion passing and failing
- identical duplicates → reported; conflicting duplicates → abort
- raw vs. normalized attribution, asserting synthesized values never reach
  bucket 3

Run all three project checks before commit:

```
npm test
npm run lint
npm run build
```
