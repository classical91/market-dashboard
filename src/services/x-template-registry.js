"use strict";

/**
 * Persistent X Intelligence template registry.
 *
 * Templates organize references to globally tracked X handles. Account
 * metadata remains owned by XAccountRegistry, so one handle can be reused by
 * several templates without duplicating feed work or cached data.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { normalizeHandle, sameHandle } = require("./x-account-registry");
const { createServiceError } = require("../utils/errors");

const REGISTRY_VERSION = 1;
const DEFAULT_TEMPLATE_ID = "markets";
const MAX_TEMPLATES = 50;
const MAX_SECTIONS = 40;
const MAX_NAME_LEN = 60;
const MAX_DESCRIPTION_LEN = 240;
const MAX_SECTION_LEN = 60;
const MAX_ACCENT_LEN = 24;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clamp(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function slugify(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueStrings(values, max, limit) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = clamp(value, max);
    if (!normalized) continue;
    if (!result.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
      result.push(normalized);
    }
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Validates and normalizes one template.
 *
 * `strict` is used for anything that arrives from the API: a payload naming
 * one account twice is refused with a 409 rather than quietly saved with the
 * second mention dropped, so an admin is never told "saved" about a template
 * that is not what they submitted. Reading a stored file stays lenient — a
 * legacy or hand-edited file must still load, with the repeat merged away.
 */
function normalizeTemplate(input, { requireId = true, strict = false } = {}) {
  const id = slugify(input?.id || input?.name);
  if (requireId && (!id || !ID_PATTERN.test(id))) {
    throw createServiceError("A template id is required (letters, numbers and hyphens only)", 400);
  }

  const name = clamp(input?.name, MAX_NAME_LEN);
  if (!name) throw createServiceError("A template name is required", 400);

  const sections = uniqueStrings(input?.sections, MAX_SECTION_LEN, MAX_SECTIONS);
  const memberships = [];
  for (const entry of Array.isArray(input?.memberships) ? input.memberships : []) {
    const handle = normalizeHandle(entry?.handle);
    const section = clamp(entry?.section, MAX_SECTION_LEN);
    if (!handle || !section) continue;
    let canonicalSection = sections.find((name) => name.toLowerCase() === section.toLowerCase());
    if (!canonicalSection) {
      if (sections.length >= MAX_SECTIONS) continue;
      sections.push(section);
      canonicalSection = section;
    }
    const duplicate = memberships.find((member) => sameHandle(member.handle, handle));
    if (duplicate) {
      if (strict) {
        throw createServiceError(
          `@${duplicate.handle} is already in this template (under ${duplicate.section})`,
          409,
        );
      }
      continue;
    }
    memberships.push({ handle, section: canonicalSection });
  }

  return {
    id,
    name,
    description: clamp(input?.description, MAX_DESCRIPTION_LEN),
    accent: slugify(input?.accent || "market").slice(0, MAX_ACCENT_LEN) || "market",
    sections,
    memberships,
  };
}

function seedMarkets(accounts) {
  const sections = [];
  const memberships = [];
  for (const account of accounts || []) {
    const section = clamp(account.category || "Other", MAX_SECTION_LEN) || "Other";
    if (!sections.includes(section)) sections.push(section);
    memberships.push({ handle: normalizeHandle(account.handle), section });
  }
  return normalizeTemplate({
    id: DEFAULT_TEMPLATE_ID,
    name: "Crypto & Stocks",
    description: "Crypto, stocks, macro and technical analysis",
    accent: "market",
    sections,
    memberships,
  });
}

class XTemplateRegistry {
  constructor({ dataDir, seedAccounts = [], logger = console } = {}) {
    this._file = path.join(dataDir, "x-templates.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._seedAccounts = seedAccounts;
    this._loadState = "unread";
    this._loadError = null;
    this._corruptBackedUp = false;
  }

  _seed() {
    const accounts = typeof this._seedAccounts === "function"
      ? this._seedAccounts()
      : this._seedAccounts;
    return [seedMarkets(accounts || [])];
  }

  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._loadState = "seeded";
        this._loadError = null;
        return this._seed();
      }
      this._loadState = "unreadable";
      this._loadError = err.message;
      this._logger.error?.(`[XTemplates] Could not read ${this._file}: ${err.message}`);
      return this._seed();
    }

    try {
      const parsed = JSON.parse(raw);
      const source = Array.isArray(parsed) ? parsed : parsed?.templates;
      if (!Array.isArray(source)) throw new SyntaxError("no templates array");
      const templates = [];
      let dropped = 0;
      for (const entry of source) {
        try {
          const template = normalizeTemplate(entry);
          if (!templates.some((item) => item.id === template.id)) templates.push(template);
          else dropped += 1;
        } catch {
          dropped += 1;
        }
      }
      if (!templates.length) throw new SyntaxError("no valid templates");
      this._loadState = dropped ? "partial" : "loaded";
      this._loadError = dropped ? `${dropped} malformed template${dropped === 1 ? "" : "s"} skipped` : null;
      return templates;
    } catch (err) {
      this._loadState = "corrupt";
      this._loadError = err.message;
      this._logger.error?.(`[XTemplates] ${this._file} is unreadable; serving the markets seed`);
      return this._seed();
    }
  }

  _write(templates) {
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try {
        fs.copyFileSync(this._file, `${this._file}.corrupt`);
        this._corruptBackedUp = true;
      } catch {
        /* best effort */
      }
    }
    const written = writeJsonAtomic(
      this._file,
      { version: REGISTRY_VERSION, templates: templates.slice(0, MAX_TEMPLATES) },
      this._logger,
      "[XTemplates]",
    );
    if (written) {
      this._loadState = "loaded";
      this._loadError = null;
    }
    return written;
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "The X template registry is busy; retry the request.",
    });
  }

  ensureSeeded() {
    return this._withLock(() => {
      if (fs.existsSync(this._file)) {
        this._read();
        return false;
      }
      this._write(this._seed());
      return true;
    });
  }

  list() {
    return this._read().map((template) => ({
      ...template,
      sections: template.sections.slice(),
      memberships: template.memberships.map((entry) => ({ ...entry })),
    }));
  }

  get(id = DEFAULT_TEMPLATE_ID) {
    const wanted = slugify(id || DEFAULT_TEMPLATE_ID);
    const template = this.list().find((entry) => entry.id === wanted);
    if (!template) throw createServiceError(`X template "${wanted}" was not found`, 404);
    return template;
  }

  create(input) {
    return this._withLock(() => {
      const templates = this._read();
      if (templates.length >= MAX_TEMPLATES) {
        throw createServiceError(`At most ${MAX_TEMPLATES} templates can be saved`, 400);
      }
      const template = normalizeTemplate(input, { strict: true });
      if (templates.some((entry) => entry.id === template.id)) {
        throw createServiceError(`A template with id "${template.id}" already exists`, 409);
      }
      const next = templates.concat(template);
      if (!this._write(next)) throw createServiceError("Could not save the template registry", 500);
      return template;
    });
  }

  update(id, input) {
    return this._withLock(() => {
      const wanted = slugify(id);
      const templates = this._read();
      const index = templates.findIndex((entry) => entry.id === wanted);
      if (index < 0) throw createServiceError(`X template "${wanted}" was not found`, 404);
      const template = normalizeTemplate({ ...input, id: wanted }, { strict: true });
      const next = templates.slice();
      next[index] = template;
      if (!this._write(next)) throw createServiceError("Could not save the template registry", 500);
      return template;
    });
  }

  duplicate(id, input = {}) {
    const source = this.get(id);
    const name = clamp(input.name, MAX_NAME_LEN) || `${source.name} Copy`;
    let candidate = slugify(input.id || name) || `${source.id}-copy`;
    const ids = new Set(this.list().map((entry) => entry.id));
    let suffix = 2;
    while (ids.has(candidate)) {
      candidate = `${slugify(input.id || name).slice(0, 36) || source.id}-${suffix}`;
      suffix += 1;
    }
    return this.create({ ...source, id: candidate, name });
  }

  remove(id) {
    return this._withLock(() => {
      const wanted = slugify(id);
      if (wanted === DEFAULT_TEMPLATE_ID) {
        throw createServiceError("The default Crypto & Stocks template cannot be deleted", 400);
      }
      const templates = this._read();
      const existing = templates.find((entry) => entry.id === wanted);
      if (!existing) throw createServiceError(`X template "${wanted}" was not found`, 404);
      if (!this._write(templates.filter((entry) => entry.id !== wanted))) {
        throw createServiceError("Could not save the template registry", 500);
      }
      return existing;
    });
  }

  reorder(ids) {
    return this._withLock(() => {
      const templates = this._read();
      const wanted = Array.isArray(ids) ? ids.map(slugify) : [];
      if (wanted.length !== templates.length || new Set(wanted).size !== templates.length) {
        throw createServiceError("Template order must contain every template exactly once", 400);
      }
      const byId = new Map(templates.map((entry) => [entry.id, entry]));
      if (wanted.some((id) => !byId.has(id))) {
        throw createServiceError("Template order contains an unknown template", 400);
      }
      const next = wanted.map((id) => byId.get(id));
      if (!this._write(next)) throw createServiceError("Could not save the template registry", 500);
      return next;
    });
  }

  addHandleToDefault(handle, section = "Other") {
    return this._withLock(() => {
      const templates = this._read();
      const index = templates.findIndex((entry) => entry.id === DEFAULT_TEMPLATE_ID);
      if (index < 0) return false;
      if (templates[index].memberships.some((entry) => sameHandle(entry.handle, handle))) return false;
      const next = templates.slice();
      const updated = normalizeTemplate({
        ...templates[index],
        sections: templates[index].sections.concat(section),
        memberships: templates[index].memberships.concat({ handle, section }),
      });
      next[index] = updated;
      if (!this._write(next)) throw createServiceError("Could not update the default template", 500);
      return true;
    });
  }

  removeHandle(handle) {
    return this._withLock(() => {
      const templates = this._read();
      let changed = false;
      const next = templates.map((template) => {
        const memberships = template.memberships.filter((entry) => !sameHandle(entry.handle, handle));
        if (memberships.length === template.memberships.length) return template;
        changed = true;
        return { ...template, memberships };
      });
      if (changed && !this._write(next)) throw createServiceError("Could not remove the account from templates", 500);
      return changed;
    });
  }

  resolveAccounts(id, accounts) {
    const template = this.get(id);
    const byHandle = new Map((accounts || []).map((account) => [account.handle.toLowerCase(), account]));
    return template.memberships.flatMap((membership) => {
      const account = byHandle.get(membership.handle.toLowerCase());
      return account ? [{ ...account, category: membership.section }] : [];
    });
  }

  describe() {
    const templates = this._read();
    return {
      file: this._file,
      loadState: this._loadState,
      loadError: this._loadError,
      templates: templates.length,
      defaultTemplateId: DEFAULT_TEMPLATE_ID,
    };
  }
}

module.exports = {
  XTemplateRegistry,
  DEFAULT_TEMPLATE_ID,
  normalizeTemplate,
  seedMarkets,
  slugify,
};
