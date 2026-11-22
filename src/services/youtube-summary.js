"use strict";

/**
 * Gemini video summaries for YouTube Intelligence.
 *
 * Gemini is the one provider whose API accepts a public YouTube URL as video
 * input: it watches the video itself (audio and frames), so there is no
 * transcript scraping — which YouTube blocks from datacenter IPs — and videos
 * without captions still work. OpenAI, Claude and Grok cannot open a YouTube
 * link, which is why this feature does not go through ai-providers.js.
 *
 * Summaries are cached per video ID on disk: a published video's content does
 * not change, so a summary is generated once and every later open is free.
 * Concurrent requests for the same video share one Gemini call.
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CACHE_PREFIX = "yt-summary:";
const MAX_SUMMARY_CHARS = 20000;

const SUMMARY_PROMPT = [
  "You are summarizing a YouTube video for a market intelligence dashboard.",
  "Watch the whole video, then write a concise briefing in exactly this format:",
  "",
  "TL;DR: one or two sentences on what the video is about and its main takeaway.",
  "",
  "## Key points",
  "- 4 to 8 bullets. Start each with the [mm:ss] timestamp (or [h:mm:ss]) where the point is made.",
  "",
  "## Market calls",
  "- Every ticker, asset, price level, target, or buy/sell/hold view, with who made it and the [mm:ss] timestamp.",
  "- Write \"- None\" if the video makes no market calls.",
  "",
  "## Notable quotes",
  "- Up to 3 short direct quotes with [mm:ss] timestamps. Leave this section out if none are worth quoting.",
  "",
  "Rules: report only what the video says. Do not add outside facts, prices or your own opinion.",
  "Make clear which statements are the speaker's opinion or prediction rather than fact.",
  "Plain text with the headings and \"- \" bullets above only: no tables, no bold, no links.",
].join("\n");

function summaryError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  err.code = code;
  return err;
}

function normalizeVideoId(value) {
  const id = String(value == null ? "" : value).trim();
  if (!VIDEO_ID_PATTERN.test(id)) throw summaryError("Invalid YouTube video ID", 400, "invalid-video-id");
  return id;
}

function responseText(body) {
  const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts
    // Thinking models can return thought parts; only the answer is shown.
    .filter((part) => part && typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
  return { text, finishReason: candidate?.finishReason || null };
}

/**
 * Turns a Gemini HTTP error into something the page can show. The upstream
 * message is logged by the caller, never returned: it can quote the request.
 */
function upstreamError(status, body) {
  const reason = String(body?.error?.status || "");
  const message = String(body?.error?.message || "");
  if (status === 429 || reason === "RESOURCE_EXHAUSTED") {
    return summaryError("Gemini's rate limit or quota is used up. Try again in a minute.", 429, "rate-limited");
  }
  if (/api key/i.test(message) || reason === "UNAUTHENTICATED" || status === 401) {
    return summaryError("Gemini rejected the API key. Check GEMINI_API_KEY on the server.", 502, "bad-key");
  }
  if (status === 404 && /model/i.test(message)) {
    return summaryError("The configured Gemini model was not found. Check GEMINI_MODEL on the server.", 502, "bad-model");
  }
  if (status === 400 || status === 403 || status === 404) {
    return summaryError(
      "Gemini could not open this video. It may be private, age-restricted, region-locked, too long, or still streaming live.",
      422,
      "video-unavailable",
    );
  }
  return summaryError("Gemini is unavailable right now. Try again shortly.", 502, "upstream-error");
}

class YoutubeSummaryService {
  /**
   * @param {object} options
   * @param {string} options.apiKey     GEMINI_API_KEY. Blank disables summaries.
   * @param {string} options.model      Gemini model ID or alias.
   * @param {object} options.cache      PersistentReporterCache (get/set/delete/getOrLoad).
   * @param {number} options.cacheTtlMs How long a summary is kept.
   * @param {number} options.timeoutMs  Per-request timeout; long videos are slow.
   * @param {Function} [options.fetchImpl]
   */
  constructor({ apiKey, model, cache, cacheTtlMs, timeoutMs, fetchImpl } = {}) {
    this.apiKey = String(apiKey || "").trim();
    const requestedModel = String(model || "").trim();
    this.model = MODEL_PATTERN.test(requestedModel) ? requestedModel : "gemini-flash-latest";
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs > 0 ? cacheTtlMs : 30 * 24 * 60 * 60 * 1000;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : 180000;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  describe() {
    return { provider: "gemini", configured: this.isConfigured(), model: this.model };
  }

  /** The cached summary for a video, or null. Never calls Gemini. */
  getCached(videoId) {
    const id = normalizeVideoId(videoId);
    return this.cache.get(CACHE_PREFIX + id) || null;
  }

  /**
   * Returns the summary for a video, generating it with Gemini when it is not
   * cached (or when `refresh` is set).
   */
  async summarize(videoId, { refresh = false } = {}) {
    const id = normalizeVideoId(videoId);
    if (!this.isConfigured()) {
      throw summaryError("Video summaries need GEMINI_API_KEY on the server.", 503, "not-configured");
    }
    const key = CACHE_PREFIX + id;
    if (refresh) this.cache.delete(key);
    const cachedBefore = this.cache.get(key);
    if (cachedBefore) return { ...cachedBefore, cached: true };
    const value = await this.cache.getOrLoad(key, this.cacheTtlMs, () => this._generate(id));
    return { ...value, cached: false };
  }

  async _generate(videoId) {
    const fetchImpl = this.fetchImpl || global.fetch;
    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
              { text: SUMMARY_PROMPT },
            ],
          }],
          generationConfig: {
            temperature: 0.3,
            // Thinking models spend part of this budget before answering.
            maxOutputTokens: 8192,
            // Low resolution is ~1/3 the tokens per second of video, and a
            // summary needs the speech and slides, not fine detail.
            mediaResolution: "MEDIA_RESOLUTION_LOW",
          },
        }),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw summaryError("Gemini took too long on this video. Try again, or try a shorter video.", 504, "timeout");
      }
      console.error(`[YoutubeSummary] Gemini request failed for ${videoId}: ${error.message}`);
      throw summaryError("Could not reach Gemini. Try again shortly.", 502, "network-error");
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      console.error(`[YoutubeSummary] Gemini ${res.status} for ${videoId}: ${String(body?.error?.message || "").slice(0, 300)}`);
      throw upstreamError(res.status, body);
    }

    const blocked = body?.promptFeedback?.blockReason;
    const { text, finishReason } = responseText(body);
    if (!text) {
      console.error(`[YoutubeSummary] Empty Gemini answer for ${videoId} (finish ${finishReason}, block ${blocked || "none"})`);
      throw summaryError(
        blocked || finishReason === "SAFETY"
          ? "Gemini declined to summarize this video."
          : "Gemini returned an empty summary. Try again.",
        502,
        "empty-summary",
      );
    }

    return {
      videoId,
      summary: text.slice(0, MAX_SUMMARY_CHARS),
      truncated: finishReason === "MAX_TOKENS",
      model: body?.modelVersion || this.model,
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = { YoutubeSummaryService, SUMMARY_PROMPT, normalizeVideoId };
