/* Pure freshness logic for the X Intelligence feed, shared by the browser and
   by the Node tests. It holds the two decisions that decide whether a reader
   can trust what is on screen:

     - decideRefresh(): whether a server response may replace the browser's
       last-known-good payload, or must be held alongside it.
     - describeStatus(): what the reader is told about how current the posts
       are.

   Both are deliberately free of DOM and network access so they can be tested
   directly. Loaded as a plain script before x-posts.js, and required as a
   module by the tests. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XFreshness = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /* Freshness lines need minute resolution ("last checked 4 minutes ago"),
     where post ages are happier rounded to hours. Kept separate on purpose:
     one describes when we last checked, the other how old the content is. */
  function formatRelativeTime(iso, now) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var diffMs = (typeof now === "number" ? now : Date.now()) - date.getTime();
    if (diffMs < 0) diffMs = 0;
    var minute = 60 * 1000;
    var hour = 60 * minute;
    var day = 24 * hour;
    if (diffMs < minute) return "just now";
    if (diffMs < hour) {
      var minutes = Math.floor(diffMs / minute);
      return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    }
    if (diffMs < day) {
      var hours = Math.floor(diffMs / hour);
      return hours + (hours === 1 ? " hour ago" : " hours ago");
    }
    var days = Math.floor(diffMs / day);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  var MAX_NAMED_HANDLES = 3;

  /* Counts the per-account states and collects the handles that failed, so
     the banner can name them. Derived from `accounts` rather than the
     server's `counts` so the numbers and the named handles can never
     disagree. An account with no recognised `dataState` counts as
     unavailable — unknown is not evidence of health. */
  function summarizeAccounts(accounts) {
    var summary = {
      total: accounts.length,
      live: 0,
      degraded: 0,
      stale: 0,
      unavailable: 0,
      unavailableHandles: [],
    };

    accounts.forEach(function (account) {
      var state = account && account.dataState;
      if (state === "live") summary.live += 1;
      else if (state === "degraded") summary.degraded += 1;
      else if (state === "stale") summary.stale += 1;
      else {
        summary.unavailable += 1;
        if (account && account.handle) summary.unavailableHandles.push(account.handle);
      }
    });

    // Confirmed against a provider on this refresh, by either route.
    summary.current = summary.live + summary.degraded;
    return summary;
  }

  /* "@a, @b, @c +2 more" — enough to act on without a banner that wraps
     across the whole pane. */
  function namedHandles(handles) {
    if (!handles.length) return "";
    var shown = handles.slice(0, MAX_NAMED_HANDLES).map(function (handle) { return "@" + handle; });
    var remaining = handles.length - shown.length;
    return shown.join(", ") + (remaining > 0 ? " +" + remaining + " more" : "");
  }

  function accountMeta(feedData, handle) {
    var accounts = (feedData && feedData.accounts) || [];
    for (var i = 0; i < accounts.length; i += 1) {
      if (accounts[i].handle === handle) return accounts[i];
    }
    return null;
  }

  /* Whether a successful server response may replace what the browser is
     holding.

     "preserve" is the case the outage exposed: the server is perfectly
     reachable and answers 200, but every provider is down, so the payload
     carries no posts. Replacing on that response would delete the browser's
     last-known-good history AND overwrite the stored cache with the empty
     result — losing the data at the exact moment it is the only thing left. */
  function decideRefresh(cache, payload) {
    var cacheHasPosts = !!(cache && cache.payload && cache.payload.posts && cache.payload.posts.length);
    var payloadHasPosts = !!(payload && payload.posts && payload.posts.length);
    if (!payloadHasPosts && cacheHasPosts) return { action: "preserve" };
    return { action: "replace" };
  }

  /* The single place that decides what the reader is told about freshness.
     Everything it reports comes from explicit timestamps and states on the
     payload — never from how many posts happen to be present.

     `state` is { loaded, transport:{ok,reason}, cache, serverOutage, feedData }. */
  function describeStatus(state, handle, now) {
    var rel = function (iso) { return formatRelativeTime(iso, now); };

    if (!state.loaded) return null;

    // Anything still coming out of the browser cache is labelled as cached —
    // whether the refresh failed, was answered by a provider outage, or has
    // simply not landed yet. The cached payload's own status is never
    // replayed as if it were current.
    if (state.cache) {
      var savedAgo = rel(state.cache.savedAtIso);
      // The worst case among the accounts whose posts are on screen, not the
      // freshest one: on a mixed feed `mostRecentSuccessfulFetchAt` would let
      // the best-off account speak for all of them, which reads far more
      // reassuring than it should. Absent (a cache written before this field
      // existed) drops the clause rather than substituting the optimistic
      // number.
      var confirmed = rel(state.cache.payload.oldestSuccessfulFetchAt);
      var confirmedPart = confirmed ? "; oldest account confirmation " + confirmed : "";

      if (state.serverOutage) {
        return {
          level: "unavailable",
          message:
            "X providers unavailable. Showing browser-cached posts saved " +
            savedAgo + confirmedPart + ".",
        };
      }

      var lead = state.transport.ok ? "Refreshing…" : state.transport.reason + ".";
      if (state.cache.expired) {
        return {
          level: "unavailable",
          message:
            lead + " Showing expired cached posts saved " + savedAgo + confirmedPart +
            " — treat these as historical, not current.",
        };
      }
      return {
        level: state.transport.ok ? "stale" : "offline",
        message: lead + " Showing cached posts saved " + savedAgo + confirmedPart + ".",
      };
    }

    if (!state.transport.ok) {
      return { level: "unavailable", message: state.transport.reason + ". No posts to show." };
    }

    // When X was last contacted, NOT when this API response was assembled. A
    // response served from the 15-minute feed cache is generated now and
    // checked some time ago; `generatedAt` would report "just now" for a feed
    // nobody has verified since.
    var checked = rel(state.feedData.lastCheckedAt);
    var checkedSuffix = checked ? " — last checked " + checked : "";

    if (handle) {
      var meta = accountMeta(state.feedData, handle);
      if (!meta) return { level: "unavailable", message: "@" + handle + " is not in this feed." };

      // Per-account truth beats the conservative aggregate.
      checked = rel(meta.lastCheckedAt);
      checkedSuffix = checked ? " — last checked " + checked : "";

      if (meta.error) {
        var lastGood = rel(meta.lastSuccessfulFetchAt);
        return {
          level: "unavailable",
          message:
            "Couldn't load @" + handle + checkedSuffix +
            (lastGood ? ". Last successful fetch " + lastGood + "." : "."),
        };
      }
      if (meta.stale) {
        return {
          level: "stale",
          message:
            "The latest check for @" + handle + " did not succeed" + checkedSuffix +
            ". Showing posts last confirmed " +
            (rel(meta.lastSuccessfulFetchAt) || "at an unknown time") + ".",
        };
      }

      // The distinction that matters: a quiet account is not a stale feed.
      var newest = rel(meta.newestPostAt);
      var newestPart = newest ? " @" + handle + "'s latest post is from " + newest + "." : "";
      // Never falls back to "just now": an absent timestamp is unknown, and
      // guessing the optimistic reading is how unchecked data reads as live.
      var checkedPart = "Last checked " + (checked || "at an unknown time") + ".";
      if (meta.dataState === "degraded") {
        return {
          level: "degraded",
          message: checkedPart + " Confirmed via the unofficial fallback source." + newestPart,
        };
      }
      return { level: "live", message: checkedPart + newestPart };
    }

    // The banner level is computed here rather than inherited from the
    // payload's `status`. That field is the worst state across accounts —
    // the right conservative summary for the API — but as a headline it lets
    // one failed account label 21 healthy ones UNAVAILABLE, which overstates
    // the outage as badly as the old code understated staleness.
    var summary = summarizeAccounts(state.feedData.accounts || []);

    if (!summary.total) {
      if (state.feedData.template) {
        return {
          level: "empty",
          message: "No accounts are assigned to this template yet.",
        };
      }
      return { level: "unavailable", message: "No accounts could be loaded" + checkedSuffix + "." };
    }
    if (summary.live === summary.total) {
      return {
        level: "live",
        message: "All " + summary.total + " accounts confirmed current" + checkedSuffix + ".",
      };
    }

    var parts = [];
    if (summary.live) parts.push(summary.live + " live");
    if (summary.degraded) parts.push(summary.degraded + " via fallback");
    if (summary.stale) parts.push(summary.stale + " cached");
    if (summary.unavailable) {
      var named = namedHandles(summary.unavailableHandles);
      parts.push(summary.unavailable + " unavailable" + (named ? " (" + named + ")" : ""));
    }
    var breakdown = parts.join(", ") + " of " + summary.total + " accounts" + checkedSuffix + ".";

    // Something was confirmed on this refresh, so the feed is usable — just
    // not whole.
    if (summary.current) return { level: "degraded", message: breakdown };
    // Nothing current, but cached posts are still on screen.
    if (summary.stale) return { level: "stale", message: breakdown };
    return { level: "unavailable", message: breakdown };
  }

  return {
    formatRelativeTime: formatRelativeTime,
    accountMeta: accountMeta,
    decideRefresh: decideRefresh,
    describeStatus: describeStatus,
  };
});
