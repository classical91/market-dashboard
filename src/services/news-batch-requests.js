"use strict";

const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, readJsonStore, writeJsonAtomic } = require("./json-file-lock");

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

function options(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw requestError("Request options must be an object.");
  const windowHours = input.windowHours === undefined ? 24 : input.windowHours;
  if (![24, 48].includes(windowHours)) throw requestError("Choose a 24 or 48 hour research window.");
  if (input.instructions !== undefined && typeof input.instructions !== "string") throw requestError("Instructions must be text.");
  const instructions = (input.instructions || "").trim();
  if (instructions.length > 2000) throw requestError("Instructions must be 2,000 characters or fewer.");
  return { windowHours, instructions };
}

class NewsBatchRequestStore {
  constructor({ dataDir, logger = console }) {
    this.file = path.join(dataDir, "news-batch-requests.json");
    this.logger = logger;
    this.lockState = { depth: 0 };
  }
  _read() {
    const data = readJsonStore(this.file, this.logger, "News batch requests");
    if (data && (data.version !== 1 || !Array.isArray(data.requests))) throw requestError("News request storage needs repair.", 503);
    return data?.requests || [];
  }
  _write(rows) {
    if (!writeJsonAtomic(this.file, { version: 1, requests: rows }, this.logger)) throw requestError("Could not save the news request. Retry with the same request key.", 503);
  }
  list() { return this._read(); }
  get(id) { return this._read().find(row => row.id === id) || null; }
  create(input, key, owner, now = new Date()) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw requestError("A stable Idempotency-Key of 16–128 letters, digits, underscores or hyphens is required.");
    const value = options(input);
    return withExclusiveLock(this.file, this.lockState, () => {
      const rows = this._read();
      const prior = rows.find(row => row.keys.includes(key));
      if (prior) {
        if (JSON.stringify(prior.options) !== JSON.stringify(value)) throw requestError("This request key already belongs to different options.", 409);
        return { request: prior, created: false };
      }
      // One active research job across all tabs, even with different keys.
      const active = rows.find(row => !["failed", "preview_ready"].includes(row.status));
      if (active) {
        if (JSON.stringify(active.options) !== JSON.stringify(value)) throw requestError("A news request is already active. Review it before requesting another batch.", 409);
        active.keys.push(key);
        this._write(rows);
        return { request: active, created: false };
      }
      const id = crypto.randomUUID();
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const request = { id, keys: [key], owner, options: value, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        clientBatchId: `dashboard-top10-${date}-ondemand-${id.replace(/-/g, "")}`, status: "requested", goalId: null,
        generation: 0, execution: null, preview: null, error: null };
      rows.unshift(request);
      this._write(rows);
      return { request, created: true };
    });
  }
  update(id, generation, patch) {
    return withExclusiveLock(this.file, this.lockState, () => {
      const rows = this._read(), row = rows.find(item => item.id === id);
      // A late poll cannot overwrite newer evidence or a verified preview.
      if (!row || row.generation !== generation || row.status === "preview_ready") return row;
      Object.assign(row, patch, { generation: generation + 1, updatedAt: new Date().toISOString() });
      this._write(rows);
      return row;
    });
  }
}

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid server URL");
  return url.origin;
}

function matchesResearchWindow(payload, request) {
  if (payload?.batchId !== request.clientBatchId || !Array.isArray(payload.candidates) || !payload.candidates.length ||
      !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 10) return false;
  const anchor = Date.parse(request.createdAt);
  return payload.candidates.every(candidate => {
    const age = anchor - Date.parse(candidate.publishedAt);
    return Number.isFinite(age) && age >= -60000 && age <= request.options.windowHours * 3600000 &&
      (age <= 24 * 3600000 || (typeof candidate.extendedWindowReason === "string" && Boolean(candidate.extendedWindowReason.trim())));
  });
}

class NewsBatchRequestService {
  constructor({ store, env = process.env, fetcher = fetch }) {
    this.store = store;
    this.env = env;
    this.fetcher = fetcher;
    this.inflight = new Map();
    this.timer = null;
    this.sweeping = false;
  }
  start() {
    if (this.timer) return;
    // Like the other workers, start only from server.js, never createApp().
    const tick = () => this.sweep().catch(() => {});
    this.timer = setInterval(tick, 15000);
    this.timer.unref?.();
    tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async sweep() {
    if (this.sweeping || !this.configured()) return;
    this.sweeping = true;
    try {
      const active = this.store.list().filter(row => !["failed", "preview_ready"].includes(row.status));
      for (const row of active) await this.sync(row.id);
    } finally { this.sweeping = false; }
  }
  configured() {
    try {
      httpsOrigin(this.env.NEWS_BATCH_AGENT_OFFICE_URL);
      httpsOrigin(this.env.FARMBOT_NEWS_API_URL);
      httpsOrigin(this.env.FARMBOT_NEWS_APPROVAL_BASE_URL);
      return (this.env.NEWS_BATCH_SERVICE_TOKEN || "").length >= 32 && (this.env.FARMBOT_NEWS_READER_TOKEN || "").length >= 32;
    } catch { return false; }
  }
  public(row) {
    const { keys, generation, ...safe } = row;
    return safe;
  }
  async _json(url, token, method = "GET", body) {
    const response = await this.fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Service returned ${response.status}`);
    return response.json();
  }
  sync(id) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const job = this._sync(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }
  async _sync(id) {
    const row = this.store.get(id);
    if (!row || row.status === "preview_ready") return row;
    if (!this.configured()) return this.store.update(id, row.generation, { status: "blocked", error: "News request integration is not configured. Your ticket is saved; retry after server setup." });
    try {
      // Replaying this PUT-like POST is safe after an ambiguous response or restart.
      const ticket = await this._json(`${httpsOrigin(this.env.NEWS_BATCH_AGENT_OFFICE_URL)}/api/integrations/news-batches/${id}`,
        this.env.NEWS_BATCH_SERVICE_TOKEN, "POST", { clientBatchId: row.clientBatchId, requestedAt: row.createdAt, ...row.options });
      if (ticket.requestId !== id || ticket.clientBatchId !== row.clientBatchId || ticket.goalId !== `goal-news-${id}` ||
          !["queued", "running", "completed", "failed", "needs_approval", "reference"].includes(ticket.status)) throw new Error("Invalid ticket receipt");
      const execution = ticket.execution;
      const claimed = execution?.goalId === ticket.goalId && Number.isInteger(execution.attempt) && execution.attempt > 0 &&
        Number.isFinite(Date.parse(execution.claimedAt)) && typeof execution.sessionKey === "string" && execution.sessionKey.startsWith("agent:oss:");
      const patch = { goalId: ticket.goalId, execution: claimed && ticket.status !== "queued" ? execution : null, error: null,
        status: ticket.status === "failed" ? "failed" : ["needs_approval", "reference"].includes(ticket.status) ? "blocked" : ticket.status === "queued" ? "assigned" : claimed ? "running" : "blocked" };
      if (ticket.status === "failed") patch.error = "Penny could not complete this request. Review the execution in Agent Office before retrying.";
      if (patch.status === "blocked") patch.error = "Penny needs attention in Agent Office before this request can continue.";
      if (ticket.status === "running" && claimed && Date.now() - Date.parse(execution.claimedAt) > 20 * 60000) {
        patch.status = "blocked";
        patch.error = "Penny’s claim needs reconciliation in Agent Office. Research will not restart automatically.";
      }
      if (ticket.status === "completed") {
        const receipt = ticket.result;
        if (!claimed || receipt?.attempt !== execution.attempt || receipt?.farmclaw?.agentId !== "commentfarm" ||
          typeof receipt.farmclaw.executionId !== "string" || !receipt.farmclaw.executionId.trim() || receipt.farmclaw.executionId.length > 300 || receipt?.clientBatchId !== row.clientBatchId) {
          patch.status = "blocked";
          patch.error = "Penny finished without a matching FarmClaw execution receipt. Review the task in Agent Office.";
        } else {
          const saved = await this._json(`${httpsOrigin(this.env.FARMBOT_NEWS_API_URL)}/news/v1/batches/lookup?clientBatchId=${encodeURIComponent(row.clientBatchId)}`, this.env.FARMBOT_NEWS_READER_TOKEN);
          if (saved.clientBatchId !== row.clientBatchId || saved.persisted !== true || saved.validated !== true ||
            !/^fnb_[a-f0-9-]{36}$/.test(saved.batchId) || !Number.isInteger(saved.revision) || saved.revision < 1 ||
            !/^sha256:[a-f0-9]{64}$/.test(saved.payloadHash) || saved.batchId !== receipt.batchId || saved.revision !== receipt.revision || saved.payloadHash !== receipt.payloadHash) throw new Error("Preview receipt mismatch");
          if (!matchesResearchWindow(saved.payload, row)) return this.store.update(id, row.generation, {
            ...patch, status: "blocked", error: "The saved preview does not match the requested research window or is missing an explanation for older stories. Ask Penny to reconcile the same batch." });
          patch.status = "preview_ready";
          patch.preview = { batchId: saved.batchId, revision: saved.revision, payloadHash: saved.payloadHash,
            approvalUrl: `${httpsOrigin(this.env.FARMBOT_NEWS_APPROVAL_BASE_URL)}/news-batches/${saved.batchId}`,
            farmclaw: { agentId: "commentfarm", executionId: receipt.farmclaw.executionId } };
        }
      }
      return this.store.update(id, row.generation, patch);
    } catch {
      return this.store.update(id, row.generation, { status: "blocked", error: "Could not verify the handoff or saved preview. Your ticket is retained; retry checks without starting another task." });
    }
  }
}

module.exports = { NewsBatchRequestStore, NewsBatchRequestService, requestError };
