"use strict";

/**
 * Which AI writes each Reporter desk, and with what prompt. Saved on the
 * server so it applies everywhere a desk is generated: the desk pages' Run,
 * Today's Top 10 Run News, the Reporter Room and the scheduled newsroom.
 *
 * File shape (DATA_DIR/briefing-ai-settings.json):
 *   {
 *     "version": 1,
 *     "default": { "provider": "openai", "model": "" },
 *     "desks": { "<section>": { "provider": "", "model": "", "prompt": "" } }
 *   }
 *
 * An empty provider/model inherits the default; an empty model means that
 * provider's default model; an empty prompt means the built-in prompt.
 */

const path = require("path");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");
const { PROVIDER_IDS } = require("./ai-providers");

const SECTIONS = ["geopolitics", "economics", "markets", "crypto"];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MAX_PROMPT_LEN = 12000;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.expose = true;
  return err;
}

function emptySettings() {
  return {
    version: 1,
    default: { provider: "openai", model: "" },
    desks: Object.fromEntries(SECTIONS.map((s) => [s, { provider: "", model: "", prompt: "" }])),
  };
}

/** Validate a saved or incoming document. `strict` throws on the first bad field. */
function normalize(input, { strict = false } = {}) {
  const out = emptySettings();
  const fail = (message) => {
    if (strict) throw badRequest(message);
  };
  const provider = (value, where, allowInherit) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v && allowInherit) return "";
    if (PROVIDER_IDS.includes(v)) return v;
    fail(`${where}: provider must be one of ${PROVIDER_IDS.join(", ")}${allowInherit ? " (or empty to use the default)" : ""}`);
    return allowInherit ? "" : "openai";
  };
  const model = (value, where) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) return "";
    if (MODEL_PATTERN.test(v)) return v;
    fail(`${where}: "${v.slice(0, 40)}" is not a model id`);
    return "";
  };
  const src = input && typeof input === "object" ? input : {};
  out.default.provider = provider(src.default?.provider, "Default", false);
  out.default.model = model(src.default?.model, "Default");
  SECTIONS.forEach((section) => {
    const desk = src.desks?.[section] || {};
    out.desks[section].provider = provider(desk.provider, section, true);
    out.desks[section].model = model(desk.model, section);
    const prompt = typeof desk.prompt === "string" ? desk.prompt.replace(/\r\n?/g, "\n").trim() : "";
    if (prompt.length > MAX_PROMPT_LEN) fail(`${section}: prompt is longer than ${MAX_PROMPT_LEN} characters`);
    out.desks[section].prompt = prompt.slice(0, MAX_PROMPT_LEN);
  });
  return out;
}

class BriefingAiSettingsStore {
  constructor({ dataDir, file, logger = console } = {}) {
    this.file = file || path.join(dataDir, "briefing-ai-settings.json");
    this.logger = logger;
    this.lockState = { depth: 0 };
  }

  get() {
    return normalize(readJsonStore(this.file, this.logger, "Briefing AI settings"));
  }

  update(input) {
    const next = normalize(input, { strict: true });
    return withExclusiveLock(this.file, this.lockState, () => {
      if (!writeJsonAtomic(this.file, next, this.logger, "Briefing AI settings")) {
        const err = new Error("Could not save the Briefing AI settings; retry.");
        err.statusCode = 503;
        err.expose = true;
        throw err;
      }
      return next;
    }, { busyMessage: "Briefing AI settings are busy; retry." });
  }

  /**
   * What a desk generates with: { provider, model, prompt }. `model` is
   * filled from `defaultModel(provider)` when nothing more specific is set;
   * `prompt` is "" for the built-in prompt.
   */
  resolve(section, { defaultModel = () => "" } = {}) {
    const settings = this.get();
    const desk = settings.desks[section] || { provider: "", model: "", prompt: "" };
    const provider = desk.provider || settings.default.provider;
    // A desk's own model applies to its own provider; with an inherited
    // provider the default model applies.
    const model = desk.provider
      ? desk.model || defaultModel(provider)
      : settings.default.model || defaultModel(provider);
    return { provider, model, prompt: desk.prompt };
  }
}

module.exports = { BriefingAiSettingsStore, normalizeBriefingAiSettings: normalize, BRIEFING_SECTIONS: SECTIONS };
