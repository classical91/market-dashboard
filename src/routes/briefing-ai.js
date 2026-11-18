"use strict";

const express = require("express");
const { promptForSection } = require("../services/reporter");
const { BRIEFING_SECTIONS } = require("../services/briefing-ai-settings");

/**
 * Settings → Reporter → Briefing AI.
 *
 *   GET  /api/briefing-ai          providers (with whether each key is set),
 *                                  the saved choices, each desk's built-in
 *                                  prompt and the prompt presets. No keys.
 *   PUT  /api/briefing-ai          (admin key) save { default, desks }.
 *   GET  /api/briefing-ai/models?provider=   (admin key) the model ids that
 *                                  provider's key can use, from its own API.
 */
function createBriefingAiRouter({ aiSettings, providers, reporterService, requireAdmin }) {
  const router = express.Router();
  const json = express.json({ limit: "128kb" });

  router.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      providers: providers.list().map((p) => ({ ...p, defaultModel: reporterService._defaultModelFor(p.id) })),
      settings: aiSettings.get(),
      effective: Object.fromEntries(BRIEFING_SECTIONS.map((section) => {
        const engine = reporterService.engineFor(section);
        return [section, { provider: engine.provider, model: engine.model, customPrompt: Boolean(engine.prompt) }];
      })),
      builtInPrompts: Object.fromEntries(BRIEFING_SECTIONS.map((section) => [section, promptForSection(section, "{date}")])),
      // The desk pages and Today's Top 10 send this for Crypto unless a
      // Crypto prompt is saved here; the Reporter Room uses the built-in one.
      websiteDefaults: { crypto: "crypto news (sent by the desk pages and Today's Top 10)" },
    });
  });

  router.put("/", requireAdmin, json, (req, res, next) => {
    try {
      res.json({ settings: aiSettings.update(req.body || {}) });
    } catch (err) {
      if (err.expose) {
        res.status(err.statusCode || 400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/models", requireAdmin, async (req, res) => {
    const provider = String(req.query.provider || "");
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ provider, models: await providers.listModels(provider) });
    } catch (err) {
      res.status(err.expose ? err.statusCode || 400 : 502).json({
        error: err.expose ? err.message : `Could not list ${provider} models (${err.status || err.message}).`,
      });
    }
  });

  return router;
}

module.exports = { createBriefingAiRouter };
