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
| `archival` | Newest post older than 45 days. A label, never a downgrade. |

An account that genuinely has not posted in ten days, checked successfully
today, is `live` with an old `newestPostAt`. The UI says "Checked 4 minutes
ago. @example's latest post is from 10 days ago" — not "stale".

Conversely, cached posts from an hour ago are `stale` no matter how recent the
posts themselves are, because the latest check did not succeed.

## Circuit breakers

A `401` or `403` from official X is a configuration fault: it cannot resolve
itself inside a refresh, and every further call spends quota to be told the
same thing. The first such response opens the official circuit for 15 minutes,
which skips **all** remaining official calls — including the per-account
timeline fallback that previously turned one bad credential into 22 doomed
requests. A `429` opens the same circuit for the window the response asks for
(`Retry-After` / `x-rate-limit-reset`), defaulting to 15 minutes.

Syndication is best-effort only. It is capped at 3 concurrent requests, and a
`429` puts the whole endpoint in a 10-minute cooldown — checked again inside
the concurrency slot, since with 22 accounts most queue before the first 429
lands.

## API contract

`GET /api/x/accounts` is authoritative about freshness. The client never infers
provider health from `posts.length`.

```
status                 live | degraded | stale | unavailable   (worst of all accounts)
generatedAt
lastSuccessfulFetchAt
newestPostAt
counts                 { live, degraded, stale, unavailable }
providers              official/syndication circuit state
posts[]
accounts[]             per-account fields from the table above
failedFeeds[]          accounts that could not be loaded
staleFeeds[]           accounts served from cache
```

## Browser cache

`xIntelligence:feedCache:v4` stores `{ savedAt, payload }` with a 45-minute
TTL. The v3 entries it replaces had no saved-at time, so they could be shown
indefinitely with nothing to say how old they were; they cannot be repaired in
place, only stranded — which the new key does. v3 is deleted on sight.

Expired cached data is still shown when the server is unreachable, but only
under an explicit `Unavailable` banner telling the reader to treat it as
historical. A transport failure never becomes an empty successful feed.

## Operational checks

Code cannot do these — they belong to whoever holds the credential:

1. **Replace the credential.** Copy the App Bearer Token from the X Developer
   Console, set `X_API_BEARER_TOKEN` in Railway, redeploy.
2. **Smoke-test it** against `/2/tweets/search/recent`, user lookup and
   timelines with the production credential.
3. **Clear the breaker** if the token was repaired inside the cooldown:
   `POST /api/x/diagnostics/reset-circuits` with `x-admin-key`.
4. **Confirm the volume is mounted.** `GET /api/x/diagnostics` must report
   `cache.volumeConfigured: true` and a `cache.file` under the volume. Without
   `RAILWAY_VOLUME_MOUNT_PATH` (or `DATA_DIR`) the last-known-good cache lives
   on container-local disk and is lost on every deploy, so the feed has no
   offline fallback at the moment it most needs one. `cache.loadState`
   distinguishes `absent` (normal first boot) from `corrupt` / `unreadable`,
   which previously looked identical to a legitimate expiry.

## Deliberately out of scope

Scheduled background ingestion is a worthwhile upgrade but a much larger
change, and this repair does not depend on it. If it is added later, put it
behind a feature flag.
