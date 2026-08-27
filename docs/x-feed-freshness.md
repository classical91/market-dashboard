# X feed: the freshness contract

The incident this addresses was not simply "the X API stopped working". It was
that an upstream failure left old intelligence on screen looking current. Three
failures stacked:

1. Official X authentication was rejected, disabling recent search, user lookup
   and timelines at once.
2. The syndication fallback was rate limited, so the per-account fallback path
   failed too.
3. The frontend turned both into an innocent-looking empty result, and then
   deliberately kept the previously cached browser feed on screen — a cache
   that carried no timestamp at all.

The invariant that prevents a recurrence:

> **An old post may be perfectly valid. Old *unchecked* data may not be
> presented as live.**

## Freshness is not post age

These are tracked separately and must never be conflated:

| Field | Means |
| --- | --- |
| `lastCheckedAt` | When we last *attempted* this account. |
| `lastSuccessfulFetchAt` | When a provider last *confirmed* the data. |
| `newestPostAt` | How old the newest post is. Content, not health. |
| `provider` | Which upstream answered: `x-api`, `x-api-timeline`, `syndication`, `cache`. |
| `providerState` | `ok`, `auth_failed`, `forbidden`, `rate_limited`, `timeout`, `parse_error`, `network_error`, `circuit_open`, `not_configured`, `no_data`. |
| `dataState` | What the data is worth: `live`, `degraded`, `stale`, `unavailable`. |
| `schemaVersion` | Provenance marker. Absent = written before this contract existed. |
| `archival` | Newest post older than 45 days. A label, never a downgrade. |

An account that genuinely has not posted in ten days, checked successfully
today, is `live` with an old `newestPostAt`. The UI says "Last checked 4
minutes ago. @example's latest post is from 10 days ago" — not "stale".

Conversely, cached posts from an hour ago are `stale` no matter how recent the
posts themselves are, because the latest check did not succeed.

## Circuit breakers

A `401` from official X is a configuration fault: it cannot resolve itself
inside a refresh, and every further call spends quota to be told the same
thing. It opens the official circuit for 15 minutes, which skips **all**
remaining official calls — including the per-account timeline fallback that
previously turned one bad credential into 22 doomed requests. A `429` opens
the same circuit for the window the response asks for (`Retry-After` /
`x-rate-limit-reset`), defaulting to 15 minutes.

A `403` is **not** classified by status alone. X uses it both for app-level
access problems and for a resource this app may not see, and only the first
is a reason to disable the provider for everyone:

| Failure | Scope |
| --- | --- |
| `401` invalid credential | global |
| `403` `client-forbidden` / app not enrolled | global |
| `429` usage or rate cap | global |
| `403` `not-authorized-for-resource` (protected, suspended) | that account only |
| `404` account not found | that account only |

The structured error body (`type`, `title`, `detail`) decides. When it cannot
be read, the request shape does: a recent-search batch spanning many handles
cannot be about one protected account, so it is treated as app-level, while a
single-account timeline is treated as account-level. Without this, one account
going private would take the whole feed down.

A breaker that simply times out stops reporting the failure that opened it:
`state`/`reason` describe the circuit *now* and read `null` once it closes,
while `lastFailure` still names what opened it. The next successful request to
that provider clears `lastFailure` too — a provider that answers is healthy,
and diagnostics should not keep describing a problem that is over.

Syndication is best-effort only. It is capped at 3 concurrent requests, and a
`429` puts the whole endpoint in a 10-minute cooldown — checked again inside
the concurrency slot, since with 22 accounts most queue before the first 429
lands.

## API contract

`GET /api/x/accounts` is authoritative about freshness. The client never infers
provider health from `posts.length`.

```
status                 live | degraded | stale | unavailable   (worst of all accounts)
generatedAt            when this response was assembled — NOT when X was checked
lastCheckedAt          the OLDEST per-account check; null if any was never checked
mostRecentSuccessfulFetchAt   the NEWEST per-account confirmation
oldestSuccessfulFetchAt       the OLDEST, among accounts that confirmed anything
newestPostAt
counts                 { live, degraded, stale, unavailable }
providers              official/syndication circuit state
posts[]
accounts[]             per-account fields from the table above
failedFeeds[]          accounts that could not be loaded
staleFeeds[]           accounts served from cache
```

## Migration fails closed

Freshness metadata never fails open. Cached feeds carry `schemaVersion`, and
an entry written before this contract has no provenance at all — the
persistent cache outlives a deploy, so such an entry could otherwise be served
as `live` on the strength of having no metadata to contradict it. Instead:

- a `x:feed:*` entry without the current `schemaVersion` is treated as a cache
  miss and refetched;
- a legacy `x:feed:latest:*` entry may still be served, but only as explicitly
  stale, with `lastSuccessfulFetchAt: null`;
- an unrecognised or absent `dataState` resolves to `stale` when posts are
  present and `unavailable` when they are not — never `live`;
- `worstDataState()` treats an unknown state as `unavailable`.

## Browser cache

`xIntelligence:feedCache:v4` stores `{ savedAt, payload }` with a 45-minute
TTL. The v3 entries it replaces had no saved-at time, so they could be shown
indefinitely with nothing to say how old they were; they cannot be repaired in
place, only stranded — which the new key does. v3 is deleted on sight.

Expired cached data is still shown when the server is unreachable, but only
under an explicit `Unavailable` banner telling the reader to treat it as
historical. A transport failure never becomes an empty successful feed.

There is a second outage shape the cache has to survive: the dashboard server
is perfectly reachable and answers `200`, but every provider is down, so the
payload carries no posts. Replacing on that response would delete the browser's
last-known-good history *and* overwrite the stored cache with the empty
result — losing the data at the moment it is the only thing left. When a
successful response carries no posts and the browser holds some, the cached
payload is kept and the banner says so:

> X providers unavailable. Showing browser-cached posts saved 3 hours ago;
> oldest account confirmation 6 hours ago.

That figure is `oldestSuccessfulFetchAt`, not the newest one. On a mixed feed
the freshest account would otherwise speak for all of them and the banner
would read far more reassuring than the data deserves. Accounts that never
confirmed anything are excluded rather than counted as infinitely old: they
contribute no cards, so they cannot make the visible posts any staler. A cache
written before this field existed drops the clause instead of substituting the
optimistic number.

A response that carries posts always replaces the cache. Partial outages
(some accounts live, some not) count as carrying posts: the server is
authoritative and its per-account states describe the rest.

`decideRefresh()` and `describeStatus()` live in
`public/assets/js/x-freshness.js`, loaded by the page and required directly by
`test/x-freshness.test.js`, so the tests exercise the code the browser runs.

## Operational checks

Code cannot do these — they belong to whoever holds the credential:

1. **Replace the credential.** Copy the App Bearer Token from the X Developer
   Console, set `X_API_BEARER_TOKEN` in Railway, redeploy.
2. **Smoke-test it** against `/2/tweets/search/recent`, user lookup and
   timelines with the production credential.
3. **Clear the breaker** if the token was repaired inside the cooldown:
   `POST /api/x/diagnostics/reset-circuits` with `x-admin-key`.
4. **Confirm the volume is mounted.** `GET /api/x/diagnostics` reports
   `cache.storageSource` (`railway-volume` | `data-dir` | `default`) and
   `cache.file`. Note that this says which setting *chose* the directory, not
   that a volume is really mounted there — confirming the mount is still a
   manual check against Railway. `default` is the one that must never appear
   in production. Without
   `RAILWAY_VOLUME_MOUNT_PATH` (or `DATA_DIR`) the last-known-good cache lives
   on container-local disk and is lost on every deploy, so the feed has no
   offline fallback at the moment it most needs one. `cache.loadState`
   distinguishes `absent` (normal first boot) from `corrupt` / `unreadable`,
   which previously looked identical to a legitimate expiry.

## Deliberately out of scope

Scheduled background ingestion is a worthwhile upgrade but a much larger
change, and this repair does not depend on it. If it is added later, put it
behind a feature flag.
