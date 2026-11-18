"use strict";

// ChatGPT, Claude or Grok per desk, with a prompt per desk, saved on the
// server (Settings → Reporter → Briefing AI).

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { createAiProviders } = require("../src/services/ai-providers");
const { BriefingAiSettingsStore } = require("../src/services/briefing-ai-settings");
const { ReporterService } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { createBriefingAiRouter } = require("../src/routes/briefing-ai");

const BRIEFING = Array.from({ length: 10 }, (_, i) => `**#${i + 1} Region — Story ${i + 1}**\n- fact (https://news.example/${i})`).join("\n\n");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-briefing-ai-"));
}

// ── Settings ────────────────────────────────────────────────────────────

test("settings default to ChatGPT, inherit per desk and refuse bad values", () => {
  const store = new BriefingAiSettingsStore({ dataDir: tmp(), logger: { error() {} } });
  const defaults = (p) => ({ openai: "gpt-x", anthropic: "claude-opus-5-5", xai: "grok-x" }[p]);
  assert.deepEqual(store.resolve("crypto", { defaultModel: defaults }), { provider: "openai", model: "gpt-x", prompt: "" });

  store.update({
    default: { provider: "anthropic", model: "" },
    desks: { geopolitics: { provider: "xai", model: "grok-4.7", prompt: "  Cover {date}\r\nonly  " }, crypto: { provider: "", model: "ignored" } },
  });
  assert.deepEqual(store.resolve("geopolitics", { defaultModel: defaults }), { provider: "xai", model: "grok-4.7", prompt: "Cover {date}\nonly" });
  assert.deepEqual(store.resolve("crypto", { defaultModel: defaults }), { provider: "anthropic", model: "claude-opus-5-5", prompt: "" },
    "a desk without its own AI follows the default, model included");

  assert.throws(() => store.update({ default: { provider: "gemini" } }), /provider must be one of/);
  assert.throws(() => store.update({ default: { provider: "openai" }, desks: { crypto: { provider: "openai", model: "bad model!" } } }), /not a model id/);
  assert.throws(() => store.update({ default: { provider: "openai" }, desks: { crypto: { prompt: "x".repeat(12001) } } }), /longer than/);
  assert.equal(store.get().default.provider, "anthropic", "a refused save changes nothing");
});

// ── Providers ───────────────────────────────────────────────────────────

test("Claude searches the web, continues paused turns and returns the briefing with its sources", async () => {
  const calls = [];
  const replies = [
    { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] },
    {
      stop_reason: "end_turn",
      content: [
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.example/1", title: "A" }] },
        { type: "text", text: BRIEFING, citations: [{ type: "web_search_result_location", url: "https://b.example/2", title: "B" }] },
      ],
    },
  ];
  const fakeClaude = {
    beta: { messages: { create: async (req) => { calls.push({ beta: true, req: structuredClone(req) }); return replies.shift(); } } },
    messages: { create: async (req) => { calls.push({ beta: false, req: structuredClone(req) }); return replies.shift(); } },
  };
  const providers = createAiProviders({ env: {}, clients: { anthropic: fakeClaude } });
  const out = await providers.generate({ provider: "anthropic", model: "claude-opus-5-5", instructions: "Be a newsroom.", input: "Write it" });

  assert.equal(out.content, BRIEFING);
  assert.deepEqual(out.sources.map((s) => s.url).sort(), ["https://a.example/1", "https://b.example/2"]);
  assert.equal(calls.length, 2);
  const first = calls[0].req;
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }]);
  assert.deepEqual(first.output_config, { effort: "medium" });
  assert.equal(calls[0].beta, true, "refusal fallbacks go through the beta endpoint");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  assert.match(first.system, /^Be a newsroom\./);
  assert.equal(calls[1].req.messages.length, 2, "the paused turn is sent back to continue");
  assert.equal(calls[1].req.messages[1].role, "assistant");
});

test("older Claude models use basic web search and no fallbacks; a refusal is an error, never a briefing", async () => {
  const calls = [];
  const fakeClaude = {
    beta: { messages: { create: async () => assert.fail("no beta call for older models") } },
    messages: { create: async (req) => { calls.push(req); return { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }; } },
  };
  const providers = createAiProviders({ env: {}, clients: { anthropic: fakeClaude } });
  await assert.rejects(
    providers.generate({ provider: "anthropic", model: "claude-sonnet-4-5", instructions: "i", input: "p" }),
    (err) => err.statusCode === 422 && /declined.*cyber/.test(err.message),
  );
  assert.equal(calls[0].tools[0].type, "web_search_20250305");
  assert.equal(calls[0].output_config, undefined);
  assert.equal(calls[0].fallbacks, undefined);
});

test("Grok uses xAI's Responses API with web search; models are listed from each key", async () => {
  const seen = [];
  const fakeXai = {
    responses: { create: async (req) => { seen.push(req); return { output_text: BRIEFING, output: [], citations: ["https://x.example/1"] }; } },
    models: { list: async function* () { yield { id: "grok-4.7" }; yield { id: "grok-4.5" }; } },
  };
  const fakeOpenAi = { models: { list: async function* () { yield { id: "gpt-5.4-mini" }; yield { id: "whisper-1" }; yield { id: "o4" }; } } };
  const providers = createAiProviders({ env: {}, clients: { xai: fakeXai, openai: fakeOpenAi } });
  const out = await providers.generate({ provider: "xai", model: "grok-4.7", instructions: "i", input: "p" });
  assert.equal(out.content, BRIEFING);
  assert.deepEqual(out.sources, [{ url: "https://x.example/1", title: null }]);
  assert.deepEqual(seen[0].tools, [{ type: "web_search" }]);
  assert.deepEqual(await providers.listModels("xai"), ["grok-4.7", "grok-4.5"]);
  assert.deepEqual(await providers.listModels("openai"), ["gpt-5.4-mini", "o4"], "only chat models from OpenAI");
});

test("a provider without its key is not configured and says which key it needs", async () => {
  const providers = createAiProviders({ env: { OPENAI_API_KEY: "k" } });
  assert.deepEqual(providers.list().map((p) => [p.id, p.configured]), [["openai", true], ["anthropic", false], ["xai", false]]);
  await assert.rejects(providers.generate({ provider: "anthropic", model: "", instructions: "", input: "" }), /ANTHROPIC_API_KEY/);
});

// ── Reporter ────────────────────────────────────────────────────────────

function reporterWith({ dataDir = tmp(), settings, keys = { anthropic: true, xai: true } } = {}) {
  const generated = [];
  const providers = {
    list: () => [{ id: "openai", configured: true }, { id: "anthropic", configured: keys.anthropic }, { id: "xai", configured: keys.xai }],
    isConfigured: (id) => id === "openai" || Boolean(keys[id]),
    defaultModel: (id) => ({ anthropic: "claude-opus-5-5", xai: "grok-4.7" }[id]),
    generate: async (req) => { generated.push(req); return { content: BRIEFING, sources: [{ url: "https://news.example/0" }] }; },
  };
  const aiSettings = new BriefingAiSettingsStore({ dataDir, logger: { error() {} } });
  if (settings) aiSettings.update(settings);
  const service = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "openai-key", model: "gpt-test", dataDir, providers, aiSettings,
  });
  return { service, generated, aiSettings };
}

test("a desk set to Claude is written by Claude with the house instructions, and logged as such", async () => {
  const { service, generated } = reporterWith({ settings: { default: { provider: "openai" }, desks: { geopolitics: { provider: "anthropic" } } } });
  const report = await service.generateReport(0, "geopolitics", "");
  assert.equal(report.geopolitics, BRIEFING);
  assert.equal(generated[0].provider, "anthropic");
  assert.equal(generated[0].model, "claude-opus-5-5");
  assert.match(generated[0].instructions, /web_search tool/, "same grounding as ChatGPT gets");
  assert.match(generated[0].input, /GEOPOLITICAL/i);
  const logged = service.listGenerations({ section: "geopolitics" })[0];
  assert.equal(logged.provider, "anthropic");
  assert.equal(logged.model, "claude-opus-5-5");
});

test("switching a desk's AI allows a fresh run that day; the same choice reuses the run", async () => {
  const dataDir = tmp();
  const { service, generated, aiSettings } = reporterWith({ dataDir, settings: { default: { provider: "anthropic" } } });
  await service.generateReport(0, "economics", "");
  const again = await service.generateReport(0, "economics", "");
  assert.equal(again.generationSkippedReason, "already-generated-today");
  assert.equal(generated.length, 1);

  aiSettings.update({ default: { provider: "xai" } });
  const fresh = await service.generateReport(0, "economics", "");
  assert.notEqual(fresh.generationSkipped, true);
  assert.equal(generated.length, 2);
  assert.equal(generated[1].provider, "xai");
});

test("a saved prompt replaces a page's built-in prompt, but not the Reporter Room's own", async () => {
  const { service, generated } = reporterWith({
    settings: { default: { provider: "anthropic" }, desks: { crypto: { prompt: "SAVED crypto prompt for {date}" } } },
  });
  await service.generateReport(0, "crypto", "PAGE crypto-news prompt", { promptIsFallback: true });
  assert.match(generated[0].input, /SAVED crypto prompt for \w+/);
  assert.doesNotMatch(generated[0].input, /\{date\}/);

  await service.generateReport(0, "markets", "");
  assert.match(generated[1].input, /markets|stocks/i, "no saved prompt: the built-in one");

  const { service: room, generated: roomCalls } = reporterWith({
    settings: { default: { provider: "anthropic" }, desks: { crypto: { prompt: "SAVED" } } },
  });
  await room.generateReport(0, "crypto", "ROOM library prompt");
  assert.match(roomCalls[0].input, /ROOM library prompt/);
});

test("a desk set to an AI without a key says which key is missing and spends nothing", async () => {
  const { service, generated } = reporterWith({ settings: { default: { provider: "xai" } }, keys: { anthropic: true, xai: false } });
  const report = await service.generateReport(0, "crypto", "");
  assert.equal(report.configured, false);
  assert.equal(report.missingKey, "XAI_API_KEY");
  assert.match(report.error, /Grok \(xAI\) needs XAI_API_KEY/);
  assert.equal(generated.length, 0);
  assert.equal(service.configured, false, "the newsroom preflight sees the default AI's key is missing");
});

// ── Route ───────────────────────────────────────────────────────────────

test("the settings API shows providers without keys, saves with the admin key and lists models", async () => {
  const dataDir = tmp();
  const { service, aiSettings } = reporterWith({ dataDir });
  const providers = createAiProviders({
    env: { OPENAI_API_KEY: "sk-secret-value", ANTHROPIC_API_KEY: "sk-ant-secret" },
    clients: { anthropic: { models: { list: async function* () { yield { id: "claude-opus-5-5" }; } } } },
  });
  let admin = false;
  const app = express();
  app.use("/api/briefing-ai", createBriefingAiRouter({
    aiSettings, providers, reporterService: service,
    requireAdmin: (req, res, next) => (admin ? next() : res.status(401).json({ error: "admin key required" })),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/briefing-ai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const info = await (await fetch(`${base}/api/briefing-ai`)).json();
    assert.doesNotMatch(JSON.stringify(info), /secret/, "keys never leave the server");
    assert.deepEqual(info.providers.map((p) => [p.id, p.configured]), [["openai", true], ["anthropic", true], ["xai", false]]);
    assert.match(info.builtInPrompts.geopolitics, /^.*\{date\}/);
    assert.equal(info.effective.crypto.provider, "openai");

    assert.equal((await put({ default: { provider: "anthropic" } })).status, 401);
    admin = true;
    assert.equal((await put({ default: { provider: "gemini" } })).status, 400);
    assert.equal((await put({ default: { provider: "anthropic" }, desks: { crypto: { provider: "xai", prompt: "P" } } })).status, 200);
    const after = await (await fetch(`${base}/api/briefing-ai`)).json();
    assert.deepEqual(after.effective.crypto, { provider: "xai", model: "grok-4.7", customPrompt: true });
    assert.equal(after.effective.economics.provider, "anthropic");

    assert.deepEqual((await (await fetch(`${base}/api/briefing-ai/models?provider=anthropic`)).json()).models, ["claude-opus-5-5"]);
    const noKey = await fetch(`${base}/api/briefing-ai/models?provider=xai`);
    assert.equal(noKey.status, 503);
    assert.match((await noKey.json()).error, /XAI_API_KEY/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
