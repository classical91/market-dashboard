# Learning-journal recovery — plan and binding constraints

Consolidates the recovery plan with the acceptance conditions previously held
in `docs/journal-recovery-constraints.md` (merged in #229, replaced by this
document).

Code claims are verified against `traderclaw/journal-recovery` @
`ed20197e315ae71ce78d95fc68660984fad4cf85`.

---

## Approval gate

**Approved:** local code edits, tests, commits, branch creation, PR creation,
read-only production queries, read-only inspection of external files.

**Stop before:** deploys, Railway restarts, production writes, backfills,
attribution updates, journal inserts, cron/schedule changes.

The gate is not advisory. Reaching it with complete dry-run artifacts is a
successful outcome; crossing it is not.

## Scope

- Work only in `market-dashboard` (local checkout:
  `C:\Users\JAson\Documents\codex\market-dashboard`).
- Target Railway service: `market-dashboard`.
- Do **not** use the legacy `trading-strategy` repo or the Railway
  `traderclaw` service.
- Do not modify any file outside `market-dashboard`.

---

## Incident facts, by verification status

The `{items}` episode is why this table has a status column. A fact's
provenance determines what may be built on it — treat the three tiers
differently, and never promote a fact between tiers without new evidence.

### Verified in committed code

| Fact | Anchor |
|---|---|
| Recovery branch head is `ed20197` | `git rev-parse` |
| `strategyAccount()` returns `history` as a plain array plus `totalTrades` | `src/services/trading/trading-lab.js:646` |
| `/strategy-accounts/:id` has no offset and no cursor; `limit` clamped to 1000, tail-anchored | `src/routes/trading-lab.js:347`, service `:646` |
| `/api/trading-lab/history` returns `{ items, total, returned, truncated, openingBalance }` | `src/routes/trading-lab.js:143-167` |
| No commit on any ref produces `history: {` | `git log -S'history: {' --all` |
| Planner collapses duplicate position IDs last-write-wins | `scripts/plan-learning-journal-recovery.js` |
| Position IDs are `PT${Date.now()}${Math.floor(Math.random() * 1000)}` | `src/services/trading/paper-trader.js:410` |
| `normalizeEntry()` synthesizes `source`/`strategy` and sets `attributionRecovered` | `src/services/trading/signal-action-store.js` |
| Planner counts `attributionRecovered` as a finding | `scripts/plan-learning-journal-recovery.js` |
| `learning-journal-recovery.test.js` holds 3 tests; fixture models `history` as an array | `test/learning-journal-recovery.test.js` |

### Asserted by the audit, not independently verified

Source: `output/market-dashboard-incident-audit-2026-08-25.md`. Every figure
here is a hypothesis until step 2 reproduces it from primary data. None may
gate an acceptance criterion before then.

- Exactly **56** strategy-account paper executions opened since
  `2026-08-20T00:00:00Z` are absent from the learning journal by stable
  `positionId`.
- Exactly **167** of **1,149** Signal Bot action rows lack
  symbol/direction/strategy attribution.
- All 1,149 actions carry terminal statuses; the 167 are legacy attribution
  gaps, not unfinished evaluations.
- Journal capture is external: `workspace-trader/learning-journal/journal_cycle.py`.
- Journal writes stopped after Aug 20 because no durable trigger invokes
  `run_cycle`.

### Known unverified — must be re-established before use

- **The `{items}` production-shape observation.** Its source URL was never
  independently confirmed against a specific endpoint. It entered the plan
  through the incident-facts handoff, and no production capture behind it has
  been identified. See §2.1 — it may not be an observation of production at
  all.

---

## 1. Preserve the workspace

- Inspect all worktrees, branches, and dirty files before changing anything.
- Branch from **current `main`**.
- Do not reopen a merged PR. New branch, new PR.
- Do not overwrite or mix in unrelated changes.

## 2. Evidence reconstruction — mandatory phase before any planner change

**The invariant: reconstruct and freeze the evidence first; only then modify
recovery code.**

All four checks below must complete before step 3 begins. Not one of them —
all four. No parsing, pagination, filtering, or reconciliation logic may be
modified while any check is open, and no manifest may be built.

The counts this recovery is judged on are hypotheses until reproduced from
primary data. An unverified constant is more dangerous than a missing one: a
missing constant blocks, while an unverified one silently becomes an
acceptance gate and certifies whatever it was derived from.

| # | Check | Resolves |
|---|---|---|
| 2.1 | `{items}` provenance | Which endpoint, if any, produced the observed shape |
| 2.2 | Re-derived journal-gap count | Whether **56** reproduces |
| 2.3 | Re-derived attribution-gap count | Whether **167 / 1,149** reproduces from raw persisted data |
| 2.4 | Snapshot metadata and hashes | What exact inputs the above were computed from |

### 2.1 Establish the `{items}` provenance

The committed contract returns a plain array. The planner consumes one. So on
committed code there is no mismatch — the mismatch exists only if production
diverges, and that is exactly what is unverified.

Re-establish provenance from the original production capture / audit:

1. **Identify the exact URL that produced the observed `{items}` response.**
   Start from `output/market-dashboard-incident-audit-2026-08-25.md`.
2. Distinguish `/api/trading-lab/history` from
   `/api/trading-lab/strategy-accounts/:id`. They are different routes with
   legitimately different shapes.

Then take exactly one branch:

| Finding | Action |
|---|---|
| Sample came from `/api/trading-lab/history` | **No schema drift.** The `{items}` envelope is that route's correct contract. Drop the concern; do not add shape-handling to the planner. |
| No capture backs the claim at all | **The claim is unfounded.** Record it as withdrawn. Do not investigate drift that was never observed, and do not write defensive code for it. |
| `/strategy-accounts/:id` genuinely returns a shape no committed code produces | **Separate blocker.** Production is running an uncommitted artifact — deployment lag serves *older* committed code, so this is not lag. Document and stop; do not fold it into the recovery. |

A compatibility shim that accepts both shapes is prohibited under every
branch. A shim converts an unexplained divergence into a silent one.

Throughout: do not guess response shapes, and do not invent pagination
parameters.

### 2.2 Re-derive the journal-gap population

Re-derive the set of strategy-account executions absent from the learning
journal, keyed on stable `positionId`, inside the window bounded by
`2026-08-20T00:00:00Z` and the §2.4 snapshot timestamp. Produce the **set of
IDs**, not just a count — a count that matches by coincidence over a different
population is a false confirmation.

Completeness of the execution read is a precondition, and it is asserted
rather than paginated. On the committed contract there is nothing to
paginate — no offset, no cursor, only a tail-anchored `limit` clamped to 1000.
Trades older than the last 1000 are unreachable at any parameter combination,
so traversal cannot be built read-only. `totalTrades` already carries the
ground truth:

```
returned === totalTrades   →  complete, proceed
returned <  totalTrades    →  fail closed
```

Fail closed names the account, `returned`, and `totalTrades`. Widening the
endpoint's window is a source change and separate approved work. Follow real
pagination to exhaustion **only** if 2.1 proved the live endpoint offers it.

An incomplete read cannot produce a trustworthy gap population, so a
truncation here halts the phase — it is not a partial result to carry forward.

### 2.3 Re-derive the attribution-gap population from raw persisted data

Re-derive the rows lacking symbol/direction/strategy attribution, and the
total row count, from the **raw persisted Signal Bot store** —
`_read({ normalize: false })`. Never from `/signal-actions` or any other
normalized read.

This ordering is load-bearing. `normalizeEntry()` synthesizes the very
attribution under audit (§5a), so a population derived through it would be
smaller than the true gap by exactly the rows the heuristic guessed — and
would appear to confirm whatever number the audit reported.

Produce the set of row identities, the gap count, and the total.

### 2.4 Record the reconstruction snapshot

Freeze what the above was computed from, so every later step and every
manifest ties back to identified inputs:

- snapshot timestamp (this becomes `--through` in §3a)
- content hash and row count of the raw Signal Bot store
- per-account `totalTrades` and `returned`
- endpoint URLs and response shapes exactly as observed in 2.1
- commit SHA of the code the reconstruction ran against

This record is the evidence base. Manifests reference it; §5c's apply-time
precondition checks against it.

### 2.5 Stop rule

**Any material discrepancy stops the run.** If a re-derived population or
count does not reproduce the audit's figure — 56, or 167 of 1,149 — halt
before planner changes, before manifests, and before any recovery logic.
Report the audit's figure, the re-derived figure, and the difference in
membership, not merely in magnitude.

Do not reconcile a discrepancy by adjusting the expected number to match, and
do not proceed on the larger or smaller of the two. A figure that does not
reproduce is a finding about the incident, and it is the user's call how to
proceed.

### Exit criteria

The phase completes when all four checks resolve without discrepancy. The
re-derived populations then become hard acceptance gates for the rest of the
work, and the recorded snapshot becomes the reference every manifest cites.

Only at that point may step 3 begin.

## 3. Fix the recovery planner locally

- Consume only the response shape verified in 2.1.
- Validate schemas; fail closed on malformed, partial, truncated, or
  contradictory responses.
- Key on the stable Dashboard `positionId` / journal
  `trade_state.position_id`.
- Deterministic ordering and output; reruns on unchanged inputs are no-ops.

### 3a. Freeze the incident window at both ends

The 56-count is only an acceptance criterion against a fixed end timestamp.
The strategies keep running, so an open-ended "since Aug 20" drifts to 57, 58,
59 mid-task. The planner applies no date filter today.

```
--from 2026-08-20T00:00:00Z --through <audit-snapshot-time>
```

Both mandatory, neither defaulted; `--through` is the snapshot timestamp
recorded in §2.4. Filter on the position's opening timestamp.

Assert against the **population re-derived in §2.2** — the exact ID set, not
the bare number 56. Any divergence fails closed with the actual count, the
symmetric difference in membership, and the boundary rows. Record the snapshot
time in the manifest so the run reproduces.

### 3b. Duplicate position IDs abort; they are never collapsed

Today:

```js
const byId = new Map(executions.map((row) => [row.positionId, row]));
```

`byId.size` feeds `reconciliation.matched`, so a silent collapse corrupts the
count the recovery is judged on.

This is not theoretical. IDs are not UUIDs — a millisecond stamp plus one of
1000 random values. Two positions opened in the same millisecond, routine when
the scanner opens across strategies in one tick, collide at 1/1000. Each
account keeps its own ledger, so nothing prevents a cross-account collision,
and one would report a genuinely missing trade as matched.

| Case | Action |
|---|---|
| Identical duplicate records | Report, deduplicate, continue |
| Conflicting duplicate records | **Abort.** Emit both records in full |

Last-write-wins is prohibited as conflict resolution anywhere in the planner.
Duplicate and conflict counts appear in the manifest even when zero. Same rule
for duplicate journal `trade_state.position_id` entries.

## 4. Strengthen tests

Current coverage is three tests over a fixture that models `history` as an
array — which is why a shape mismatch would not be caught either way.

Add:

- fixtures matching the exact shape verified in §2.1
- `returned < totalTrades` → fail closed
- multiple pages, and empty pages, **only if** §2.1 proved pagination exists
- window filtering, including rows on both boundaries
- the 56-count assertion passing and failing
- identical duplicates → reported; conflicting duplicates → abort
- malformed and truncated responses → fail closed
- rerun / no-op determinism
- exactly 56 proposed journal inserts against sanitized production-derived
  fixtures for the frozen window
- the 167-row plan targets only rows missing required fields, and never
  rewrites terminal status or outcome data
- raw vs. normalized attribution, asserting synthesized values never count as
  evidence

Run and report all three:

```
npm test
npm run lint
npm run build
```

## 5. Design the 167-row repair conservatively

### 5a. Synthesized attribution is not evidence

`normalizeEntry()` manufactures a `legacy-signal-action-<hash>` ID, sets
`source = "signal-bot"` and `strategy = signal-bot:<interval>`, and marks
`attributionRecovered = true`. A test on the branch asserts this. The planner
counts those flags as a finding.

`/signal-actions` reads through `SignalActionStore.recent()`, which
normalizes. So the API view of the 167 rows already contains the inference the
repair is meant to audit. Counting it as evidence would prove the attribution
using the very heuristic under audit.

*Never guess missing attribution* governs. Therefore:

- Do not treat `attributionRecovered` as authoritative support for a repair,
  regardless of the field's name or the branch framing it as "recovered".
- Work from the **raw persisted rows** — `_read({ normalize: false })` bypasses
  normalization — or from sanitized fixtures derived from them, not from the
  normalized API view alone. §2.3 has already established that population;
  this step classifies it.
- Classify every field into exactly one bucket, and carry the bucket into the
  manifest:

  1. **raw persisted** — present in the stored bytes
  2. **derived at read time** — synthesized by `normalizeEntry()`
  3. **authoritative linked evidence** — corroborated by an independent record
  4. **unresolved** — everything else

Only bucket 3 justifies a repair. Bucket 2 is a hypothesis to test against
bucket 3, never a substitute for it. Anything not placeable in bucket 3 goes
to `unresolved` and stays there.

### 5b. Repair mechanics

- Derive `symbol`, `direction`, `strategy` only from authoritative linked
  payloads/IDs or persisted evidence.
- Idempotent and conditional: fill only null/missing fields; never overwrite
  existing attribution; never touch terminal status or outcome data.
- Split into repairable and unresolved, with stable IDs and explicit reasons.
- Each repairable row carries: stable selector, original values, proposed
  additions, evidence source, evidence reason. An entry with no bucket-3
  evidence is malformed.

### 5c. Repairs bind to a source snapshot

Design the eventual write path so it cannot repair a moving target:

```
expected source hash + row count  →  apply  →  verify
```

The expected values are the ones recorded in §2.4. If the Signal Bot store
changes between reconstruction and approval, the apply command aborts rather
than applying a manifest built against different bytes.

## 6. Produce dry-run artifacts before any write

- the exact 56 journal IDs proposed for insertion
- repairable and unresolved manifests for the 167 legacy rows
- duplicate/conflict report
- before/after projected counts
- recovery commands, batch sizes, rollback procedure, acceptance queries,
  source-snapshot precondition checks

Redact credentials and sensitive payloads.

## 7. Restore durable capture — design only

- Identify the correct owner/runtime for `journal_cycle.py`.
- Read-only inspection of
  `workspace-trader/learning-journal/journal_cycle.py` is permitted where
  accessible. If it is outside the available workspace, report what could not
  be verified — do not reconstruct it from inference.
- Propose a durable schedule with locking, timeout, retry/backoff, structured
  logs, stale-capture alerting, and overlap prevention.
- Keep credentials out of scheduler payloads.
- **Do not create or modify the scheduler yet.**

## 8. Commit and report

Commit on a new branch from current `main`; open a new PR. Report:

- commit SHA and files changed
- test/lint/build commands and their results
- exact dry-run counts
- unresolved IDs and count
- proposed deployment command, recovery commands, rollback
- **the step 2 reconstruction**, stated explicitly: which branch of the §2.1
  table applied and on what evidence; whether the §2.2 and §2.3 populations
  reproduced; and the §2.4 snapshot record
- any unresolved production/code drift
