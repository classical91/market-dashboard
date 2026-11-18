"use strict";

/**
 * The AI providers the Reporter can write briefings with. Each one gets the
 * same job: run a briefing prompt with live web search and return plain text
 * plus the sources it cited.
 *
 *   openai     ChatGPT — OpenAI Responses API with the web_search tool.
 *   anthropic  Claude  — Anthropic Messages API with the server-side
 *                        web_search tool (official @anthropic-ai/sdk).
 *   xai        Grok    — xAI's Responses API (OpenAI-compatible, api.x.ai)
 *                        with its server-side web_search tool.
 *
 * A provider without its API key is listed as not configured and is never
 * called; the Reporter reports which key is missing instead.
 */

const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const PROVIDERS = [
  { id: "openai", label: "ChatGPT (OpenAI)", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Claude (Anthropic)", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "xai", label: "Grok (xAI)", keyEnv: "XAI_API_KEY" },
];
const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

// Starting points only: Settings → Reporter → Briefing AI can load the models
// each key actually has and pick any of them.
const DEFAULT_MODELS = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-opus-5-5",
  xai: "grok-4.7",
};

const XAI_BASE_URL = "https://api.x.ai/v1";
const MAX_CLAUDE_CONTINUATIONS = 5;

// Claude models with the dynamic-filtering web search tool; older ones keep
// the basic variant.
const CLAUDE_DYNAMIC_SEARCH = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
// Models that take output_config.effort (adaptive thinking families).
const CLAUDE_EFFORT = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[5678]|^claude-sonnet-4-6/;
// Models that support server-side refusal fallbacks with fallbacks: "default".
const CLAUDE_FALLBACKS = /^claude-(fable-5-[12]|opus-5|sonnet-5-5)(?!\d)/;

function providerError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

/** url_citation annotations from an OpenAI/xAI Responses result. */
function responsesSources(response) {
  const seen = new Map();
  const add = (url, title) => {
    const clean = typeof url === "string" ? url.trim() : "";
    if (!clean || seen.has(clean)) return;
    seen.set(clean, { url: clean.slice(0, 2000), title: typeof title === "string" ? title.trim().slice(0, 300) : null });
  };
  (Array.isArray(response?.output) ? response.output : []).forEach((item) => {
    (Array.isArray(item?.content) ? item.content : []).forEach((part) => {
      (Array.isArray(part?.annotations) ? part.annotations : []).forEach((a) => {
        if (a && (!a.type || a.type === "url_citation")) add(a.url, a.title);
      });
    });
  });
  // xAI can also return a flat citation list.
  (Array.isArray(response?.citations) ? response.citations : []).forEach((c) => add(typeof c === "string" ? c : c?.url, c?.title));
  return [...seen.values()];
}

function claudeText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function claudeSources(responses) {
  const seen = new Map();
  const add = (url, title) => {
    if (typeof url !== "string" || !url.trim() || seen.has(url)) return;
    seen.set(url, { url: url.slice(0, 2000), title: typeof title === "string" ? title.slice(0, 300) : null });
  };
  responses.forEach((response) => {
    (response.content || []).forEach((block) => {
      if (block.type === "text" && Array.isArray(block.citations)) {
        block.citations.forEach((c) => add(c.url, c.title));
      }
      // A successful search result is a list; an error is a single object.
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        block.content.forEach((r) => add(r.url, r.title));
      }
    });
  });
  return [...seen.values()];
}

function createAiProviders({ env = process.env, clients = {} } = {}) {
  const keys = {
    openai: env.OPENAI_API_KEY || "",
    anthropic: env.ANTHROPIC_API_KEY || "",
    xai: env.XAI_API_KEY || "",
  };
  const defaultModels = { ...DEFAULT_MODELS, openai: env.REPORTER_MODEL || DEFAULT_MODELS.openai };
  const cache = {};

  function client(id) {
    if (clients[id]) return clients[id];
    if (!keys[id]) throw providerError(`${PROVIDERS.find((p) => p.id === id).label} needs ${PROVIDERS.find((p) => p.id === id).keyEnv} on the server.`, 503);
    if (!cache[id]) {
      if (id === "openai") cache[id] = new OpenAI({ apiKey: keys.openai });
      else if (id === "xai") cache[id] = new OpenAI({ apiKey: keys.xai, baseURL: XAI_BASE_URL });
      else cache[id] = new Anthropic.Anthropic({ apiKey: keys.anthropic });
    }
    return cache[id];
  }

  function isConfigured(id) {
    return Boolean(clients[id] || keys[id]);
  }

  async function generateResponses(id, { model, instructions, input }) {
    const res = await client(id).responses.create({
      model,
      instructions,
      tools: [{ type: "web_search" }],
      input,
    });
    return { content: String(res.output_text || "").trim(), sources: responsesSources(res) };
  }

  async function generateClaude({ model, instructions, input }) {
    const anthropic = client("anthropic");
    const params = {
      model,
      max_tokens: 16000,
      system: `${instructions}\nSearch the web for current reporting first. Reply with the finished briefing only: no preamble, no notes about searching.`,
      tools: [{
        type: CLAUDE_DYNAMIC_SEARCH.test(model) ? "web_search_20260209" : "web_search_20250305",
        name: "web_search",
        max_uses: 10,
      }],
    };
    if (CLAUDE_EFFORT.test(model)) params.output_config = { effort: "medium" };
    const withFallback = CLAUDE_FALLBACKS.test(model);
    if (withFallback) {
      // On a safety decline the API re-runs the request on a fallback model.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const messages = [{ role: "user", content: input }];
    const responses = [];
    for (let turn = 0; turn <= MAX_CLAUDE_CONTINUATIONS; turn += 1) {
      const res = withFallback
        ? await anthropic.beta.messages.create({ ...params, messages })
        : await anthropic.messages.create({ ...params, messages });
      responses.push(res);
      if (res.stop_reason === "refusal") {
        const category = res.stop_details && res.stop_details.category;
        throw providerError(`Claude declined to write this briefing${category ? ` (${category})` : ""}.`, 422);
      }
      // A long server-side search turn pauses; send it back to continue.
      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content });
        continue;
      }
      break;
    }
    const last = responses[responses.length - 1];
    if (last.stop_reason === "pause_turn") throw providerError("Claude's web search did not finish; try again.", 504);
    const content = claudeText(last.content) || responses.map((r) => claudeText(r.content)).join("\n").trim();
    return { content, sources: claudeSources(responses) };
  }

  return {
    list() {
      return PROVIDERS.map((p) => ({ ...p, configured: isConfigured(p.id), defaultModel: defaultModels[p.id] }));
    },
    isConfigured,
    defaultModel(id) {
      return defaultModels[id];
    },
    /** Run one briefing prompt with web search. Resolves { content, sources }. */
    async generate({ provider, model, instructions, input }) {
      if (!PROVIDER_IDS.includes(provider)) throw providerError(`Unknown AI provider "${provider}".`);
      const chosen = model || defaultModels[provider];
      const result = provider === "anthropic"
        ? await generateClaude({ model: chosen, instructions, input })
        : await generateResponses(provider, { model: chosen, instructions, input });
      if (!result.content) throw providerError(`${provider} returned an empty briefing.`, 502);
      return result;
    },
    /** The model ids this provider's key can use, newest first where it says. */
    async listModels(provider) {
      if (!PROVIDER_IDS.includes(provider)) throw providerError(`Unknown AI provider "${provider}".`);
      const ids = [];
      for await (const model of client(provider).models.list()) {
        if (model && typeof model.id === "string") ids.push(model.id);
        if (ids.length >= 200) break;
      }
      const relevant = provider === "openai" ? ids.filter((id) => /^(gpt-|o\d|chatgpt)/.test(id)) : ids;
      return relevant;
    },
  };
}

module.exports = { createAiProviders, PROVIDERS, PROVIDER_IDS, DEFAULT_MODELS, responsesSources, claudeSources, claudeText };
