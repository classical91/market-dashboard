"use strict";

// The Live Now widget's view of the YouTube Intelligence feed.
//
// `getIntelligence` already answers the hard question — which tracked videos are
// actually live right now, and which are scheduled — by reading
// `liveStreamingDetails` off the Data API. This file does not ask it again. It
// takes that answer and narrows it to what a player and a row of cards need,
// which is a much smaller thing than the intelligence page renders.
//
// Narrowing rather than forwarding is the whole point, and it is the same rule
// the rest of this server follows at a trust boundary. The feed payload carries
// every video of every tracked channel, per-channel failure reasons, and the
// service's own quota state; Main Hub is a different app on a different origin
// and needs none of it. Each field below is named on purpose, so a field added
// upstream cannot start travelling by accident.
//
// Two things are deliberately absent:
//
//   `apiConfigured` and `quotaCoolingDown` are this server's internal health,
//   not the stream's. A widget that knew our quota was cooling down could not
//   do anything useful with it, and it tells a caller how to time a probe.
//
//   `failedFeeds` names channels that failed and why. The widget shows what is
//   live; a channel that could not be read is not a stream it can play, and the
//   reason belongs on the intelligence page that can act on it.
//
// `liveDetection` does travel, because it is the difference between "nothing is
// live" and "we could not check" — and a widget that cannot tell those apart
// will confidently claim an empty sky.

/** How many of each the widget can actually use. A player shows one. */
const MAX_LIVE = 12;
const MAX_UPCOMING = 5;

function isoOrNull(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * A count, or null.
 *
 * `concurrentViewers` arrives from the Data API as a string and is already
 * coerced upstream, but a negative or fractional viewer count is not a number
 * this widget should render — it is a sign the field did not mean what we
 * think, and "" is better than "-1 watching".
 */
function viewerCount(value) {
  if (value == null) return null;
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

/**
 * One stream, as a card and a player need it.
 *
 * Returns null for a video with no id: the watch URL and the embed are both
 * built from it, so a row without one is a card that cannot be clicked and a
 * player that cannot load.
 */
function narrowVideo(video, expectedStatus) {
  const videoId = String(video?.id || "").trim();
  if (!videoId) return null;

  return {
    videoId,
    title: String(video?.title || "Untitled"),
    channelName: video?.channelLabel || video?.channelHandle || null,
    channelHandle: video?.channelHandle || null,
    thumbnail: video?.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    status: expectedStatus,
    scheduledStartTime: isoOrNull(video?.scheduledStartTime),
    actualStartTime: isoOrNull(video?.actualStartTime),
    viewerCount: viewerCount(video?.concurrentViewers),
    watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  };
}

/**
 * The live feed, narrowed.
 *
 * `state` is re-checked rather than trusted from the array it arrived in. The
 * two lists are built one line apart upstream, so this cannot currently differ
 * — but an ordinary upload rendered under a LIVE badge is the one failure this
 * widget must never have, and the check costs nothing.
 */
function narrowLiveFeed(payload) {
  const live = Array.isArray(payload?.live) ? payload.live : [];
  const upcoming = Array.isArray(payload?.upcoming) ? payload.upcoming : [];

  const detection = payload?.meta?.liveDetection;

  return {
    live: live
      .filter((video) => video?.state === "live")
      .slice(0, MAX_LIVE)
      .map((video) => narrowVideo(video, "live"))
      .filter(Boolean),
    upcoming: upcoming
      .filter((video) => video?.state === "upcoming")
      .slice(0, MAX_UPCOMING)
      .map((video) => narrowVideo(video, "upcoming"))
      .filter(Boolean),
    meta: {
      // "api" means we checked. "degraded" means the status lookup failed and
      // an empty list proves nothing. "unavailable" means there is no API key,
      // so live state was never knowable.
      liveDetection: ["api", "degraded", "unavailable"].includes(detection) ? detection : "unavailable",
      generatedAt: isoOrNull(payload?.meta?.generatedAt) || new Date().toISOString(),
    },
  };
}

module.exports = { narrowLiveFeed, MAX_LIVE, MAX_UPCOMING };
