"use strict";

// Only FarmBot's persisted receipt establishes Queue intake. Never derive it
// from delivery status or accept a queue id supplied by the source/agent.
function createFarmclawQueueStatus({ env = process.env, fetcher = fetch } = {}) {
  const cache = new Map();
  return async function queueStatus(record) {
    try {
      const url = new URL(record.url);
      const match = /^\/(?:[a-zA-Z0-9_]{1,30}\/status|i\/status|i\/web\/status)\/([1-9]\d{0,24})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(url.pathname);
      if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname) || !match) return null;
      const statusId = match[1], old = cache.get(statusId);
      if (old && old.until > Date.now()) return old.result;
      if (!env.FARMBOT_NEWS_API_URL || !env.FARMBOT_NEWS_READER_TOKEN || env.FARMBOT_NEWS_READER_TOKEN.length < 32) return null;
      const api = new URL(env.FARMBOT_NEWS_API_URL);
      if (api.protocol !== "https:" || api.username || api.password) return null;
      const response = await fetcher(`${api.origin}/farmclaw/v1/x-links/${statusId}`, {
        headers: { Authorization: `Bearer ${env.FARMBOT_NEWS_READER_TOKEN}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      });
      let result = null;
      if (response.ok) {
        const r = await response.json();
        if (r.persisted === true && r.statusId === statusId && /^\d+$/.test(r.queueItemId) && /^sha256:[a-f0-9]{64}$/.test(r.payloadHash)) {
          if (r.queued === true && r.queue?.id === r.queueItemId) result = { confirmed: true, queueItemId: r.queueItemId,
            dispatchActive: r.queue.dispatchActive, dispatchStatus: r.queue.dispatchStatus, xPublishedUrl: r.queue.xPublishedUrl || null };
          else if (r.removed === true && r.queued === false) result = { confirmed: false, removed: true, queueItemId: r.queueItemId };
        }
      }
      if (cache.size >= 500) cache.clear();
      cache.set(statusId, { result, until: Date.now() + 15000 });
      return result;
    } catch { return null; }
  };
}
module.exports = { createFarmclawQueueStatus };
