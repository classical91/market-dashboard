"use strict";

/**
 * Persistent X Intelligence template registry.
 *
 * A template is a named, flat list of globally tracked X handles — the filter
 * the page's switcher selects. It has no sections: the account sidebar renders
 * the list in order. Account metadata remains owned by XAccountRegistry, so
 * one handle can be reused by several templates without duplicating feed work
 * or cached data.
 *
 * Templates come from two places. Admins create their own through the API, and
 * the built-in themes in src/config/x-themes.js ship with the dashboard. The
 * two are the same shape once stored: a built-in theme is an ordinary template
 * that happened to arrive pre-written, and is editable and deletable like any
 * other. What the file records about them is only which ones have already been
 * installed, so a later deploy adding a theme does not also resurrect one an
 * admin deleted.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { normalizeHandle, sameHandle } = require("./x-account-registry");
const { BUILT_IN_THEMES, X_TEMPLATE_MEMBERSHIP_PACKS } = require("../config/x-themes");
const { createServiceError } = require("../utils/errors");

// 2 added the seededThemes roster. A version 1 file predates every built-in
// theme but markets, so it is read as having seeded none of them and the
// backfill installs them once. 4 replaced each template's sections and
// sectioned memberships with a flat `handles` list; a version 3 file still
// reads, because normalizeTemplate accepts both shapes.
const REGISTRY_VERSION = 4;
const DEFAULT_TEMPLATE_ID = "markets";
const MAX_TEMPLATES = 50;
const MAX_HANDLES = 200;
const MAX_NAME_LEN = 60;
const MAX_DESCRIPTION_LEN = 240;
// Bounds the roster strings in the stored file (theme ids, pack ids), not
// anything a template shows.
const MAX_ID_LEN = 60;
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
 * The handles a template holds, from either shape this file has ever stored.
 *
 * Current shape is `handles: ["Barchart", ...]`. Templates written before
 * sections were removed carry `memberships: [{ handle, section }]` instead;
 * they are read here by taking the handles and discarding the sections, so an
 * existing install upgrades on first read and persists the flat shape on its
 * next write. No separate migration step, because normalizeTemplate is the
 * only way a stored template enters the process.
 */
function readHandles(input) {
  const source = Array.isArray(input?.handles)
    ? input.handles
    : (Array.isArray(input?.memberships) ? input.memberships : []);
  return source.map((entry) => (typeof entry === "string" ? entry : entry?.handle));
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

  const handles = [];
  for (const entry of readHandles(input)) {
    const handle = normalizeHandle(entry);
    if (!handle) continue;
    if (handles.some((existing) => sameHandle(existing, handle))) {
      // One handle, one entry: a template holding an account twice would list
      // it twice in the sidebar and double every one of its posts.
      if (strict) {
        throw createServiceError(`@${handle} is already in this template`, 409);
      }
      continue;
    }
    handles.push(handle);
    if (handles.length >= MAX_HANDLES) break;
  }

  return {
    id,
    name,
    description: clamp(input?.description, MAX_DESCRIPTION_LEN),
    accent: slugify(input?.accent || "market").slice(0, MAX_ACCENT_LEN) || "market",
    handles,
  };
}

function seedMarkets(accounts) {
  return normalizeTemplate({
    id: DEFAULT_TEMPLATE_ID,
    name: "Crypto & Stocks",
    description: "Crypto, stocks, macro and technical analysis",
    accent: "market",
    handles: (accounts || []).map((account) => account.handle),
  });
}

/**
 * Every theme id the current build ships, markets included. Used both as the
 * roster a freshly seeded file starts with and as the list the backfill walks.
 */
function allThemeIds() {
  return [DEFAULT_TEMPLATE_ID].concat(BUILT_IN_THEMES.map((theme) => theme.id));
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
    // Which built-in theme ids this file has already been given. Read from the
    // file, so a theme an admin deleted is not handed back on the next boot.
    this._seededThemes = [];
    this._seededMembershipPacks = [];
  }

  _seed() {
    const accounts = typeof this._seedAccounts === "function"
      ? this._seedAccounts()
      : this._seedAccounts;
    return [seedMarkets(accounts || [])].concat(
      BUILT_IN_THEMES.map((theme) => normalizeTemplate(theme)),
    );
  }

  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._loadState = "seeded";
        this._loadError = null;
        this._seededThemes = allThemeIds();
        this._seededMembershipPacks = X_TEMPLATE_MEMBERSHIP_PACKS.map((pack) => pack.id);
        return this._seed();
      }
      this._loadState = "unreadable";
      this._loadError = err.message;
      this._seededThemes = allThemeIds();
      this._seededMembershipPacks = X_TEMPLATE_MEMBERSHIP_PACKS.map((pack) => pack.id);
      this._logger.error?.(`[XTemplates] Could not read ${this._file}: ${err.message}`);
      return this._seed();
    }

    try {
      const parsed = JSON.parse(raw);
      const source = Array.isArray(parsed) ? parsed : parsed?.templates;
      if (!Array.isArray(source)) throw new SyntaxError("no templates array");
      // A bare array or a version 1 object has no roster: it was written before
      // any theme but markets existed, so none of the rest count as installed.
      this._seededThemes = uniqueStrings(
        Array.isArray(parsed?.seededThemes) ? parsed.seededThemes.map(slugify) : [],
        MAX_ID_LEN,
        MAX_TEMPLATES,
      );
      this._seededMembershipPacks = uniqueStrings(
        Array.isArray(parsed?.seededMembershipPacks) ? parsed.seededMembershipPacks : [],
        MAX_ID_LEN,
        100,
      );
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
      this._seededThemes = allThemeIds();
      this._seededMembershipPacks = X_TEMPLATE_MEMBERSHIP_PACKS.map((pack) => pack.id);
      this._logger.error?.(`[XTemplates] ${this._file} is unreadable; serving the built-in themes`);
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
      {
        version: REGISTRY_VERSION,
        // Carried through every write, not just the seeding one: losing it
        // would make the next boot reinstall a theme the admin deleted.
        seededThemes: this._seededThemes.slice(),
        seededMembershipPacks: this._seededMembershipPacks.slice(),
        templates: templates.slice(0, MAX_TEMPLATES),
      },
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

  /**
   * Writes the seed on a fresh install, and on an existing one installs any
   * built-in theme this file has not been given yet.
   *
   * The backfill is what lets a deploy add a theme: without it a dashboard
   * that has ever booted would keep only the themes that existed the first
   * time. It runs at most once per theme — the id is recorded whether or not
   * the template survives — so deleting a theme is permanent, and an admin who
   * renamed or re-listed one keeps their version.
   *
   * Returns true when the file was written.
   */
  ensureSeeded() {
    return this._withLock(() => {
      if (!fs.existsSync(this._file)) {
        this._seededThemes = allThemeIds();
        this._seededMembershipPacks = X_TEMPLATE_MEMBERSHIP_PACKS.map((pack) => pack.id);
        this._write(this._seed());
        return true;
      }

      const templates = this._read();
      const known = new Set(this._seededThemes);
      const present = new Set(templates.map((entry) => entry.id));
      // An id already in the file is skipped without being installed, but is
      // still recorded: an admin's own "stack" template is theirs to keep, and
      // overwriting it with the built-in would be the one destructive outcome.
      const pending = BUILT_IN_THEMES.filter((theme) => !known.has(theme.id));
      const added = [];
      const installed = [];
      let room = MAX_TEMPLATES - templates.length;
      for (const theme of pending) {
        if (present.has(theme.id)) {
          installed.push(theme.id);
          continue;
        }
        // At the cap, leave the theme unrecorded rather than marking a theme
        // installed that was never written: deleting a template later frees the
        // room, and the next boot picks it up.
        if (room <= 0) continue;
        added.push(normalizeTemplate(theme));
        installed.push(theme.id);
        room -= 1;
      }
      this._seededThemes = this._seededThemes.concat(installed);

      const installedPacks = new Set(this._seededMembershipPacks);
      for (const pack of X_TEMPLATE_MEMBERSHIP_PACKS) {
        if (installedPacks.has(pack.id)) continue;
        const template = templates.concat(added).find((entry) => entry.id === pack.templateId);
        if (template) {
          const removeHandles = new Set((pack.removeHandles || []).map((handle) => normalizeHandle(handle).toLowerCase()));
          if (removeHandles.size) {
            template.handles = template.handles.filter(
              (handle) => !removeHandles.has(handle.toLowerCase()),
            );
          }
          for (const handle of pack.handles || []) {
            if (!template.handles.some((entry) => sameHandle(entry, handle))) {
              template.handles.push(normalizeHandle(handle));
            }
          }
          this._seededMembershipPacks.push(pack.id);
        }
      }

      if (!installed.length && this._seededMembershipPacks.length === installedPacks.size) return false;
      if (!this._write(templates.concat(added))) {
        this._logger.error?.(`[XTemplates] Could not install ${installed.length} built-in theme(s)`);
        return false;
      }
      if (added.length) {
        this._logger.log?.(
          `[XTemplates] Installed built-in theme(s): ${added.map((theme) => theme.id).join(", ")}`,
        );
      }
      return true;
    });
  }

  list() {
    return this._read().map((template) => ({
      ...template,
      handles: template.handles.slice(),
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

  /**
   * Adds a globally tracked handle to one template.
   *
   * This is what "manage accounts for the theme I am looking at" resolves to.
   *
   * Returns true when the handle was added, false when the template already
   * held it. Absent templates throw, because a caller naming a template that
   * is not there has a real bug — only the default-template convenience
   * wrapper below tolerates that, for the pre-template callers it still serves.
   */
  addHandleToTemplate(templateId, handle) {
    return this._withLock(() => {
      const wanted = slugify(templateId || DEFAULT_TEMPLATE_ID);
      const templates = this._read();
      const index = templates.findIndex((entry) => entry.id === wanted);
      if (index < 0) throw createServiceError(`X template "${wanted}" was not found`, 404);
      if (templates[index].handles.some((entry) => sameHandle(entry, handle))) return false;
      const next = templates.slice();
      next[index] = normalizeTemplate({
        ...templates[index],
        handles: templates[index].handles.concat(handle),
      });
      if (!this._write(next)) throw createServiceError("Could not update the template", 500);
      return true;
    });
  }

  addHandleToDefault(handle) {
    // Kept tolerant of a missing default template: it is the fallback path for
    // an add that named no theme, and a 404 there would fail the whole add.
    try {
      this.get(DEFAULT_TEMPLATE_ID);
    } catch (err) {
      return false;
    }
    return this.addHandleToTemplate(DEFAULT_TEMPLATE_ID, handle);
  }

  /**
   * Drops a handle from one template, leaving the global account and every
   * other template alone. The counterpart to removeHandle, which is for an
   * account being deleted everywhere.
   */
  removeHandleFromTemplate(templateId, handle) {
    return this._withLock(() => {
      const wanted = slugify(templateId || DEFAULT_TEMPLATE_ID);
      const templates = this._read();
      const index = templates.findIndex((entry) => entry.id === wanted);
      if (index < 0) throw createServiceError(`X template "${wanted}" was not found`, 404);
      const handles = templates[index].handles.filter((entry) => !sameHandle(entry, handle));
      if (handles.length === templates[index].handles.length) return false;
      const next = templates.slice();
      next[index] = { ...templates[index], handles };
      if (!this._write(next)) throw createServiceError("Could not update the template", 500);
      return true;
    });
  }

  removeHandle(handle) {
    return this._withLock(() => {
      const templates = this._read();
      let changed = false;
      const next = templates.map((template) => {
        const handles = template.handles.filter((entry) => !sameHandle(entry, handle));
        if (handles.length === template.handles.length) return template;
        changed = true;
        return { ...template, handles };
      });
      if (changed && !this._write(next)) throw createServiceError("Could not remove the account from templates", 500);
      return changed;
    });
  }

  /**
   * The tracked accounts this template shows, in the order it lists them.
   *
   * Each account keeps its own category: the sidebar renders a flat list now,
   * so the category is descriptive metadata rather than a grouping key. A
   * handle naming an account that is no longer tracked is dropped — it would
   * otherwise be a row whose feed can never fill.
   */
  resolveAccounts(id, accounts) {
    const template = this.get(id);
    const byHandle = new Map((accounts || []).map((account) => [account.handle.toLowerCase(), account]));
    return template.handles.flatMap((handle) => {
      const account = byHandle.get(handle.toLowerCase());
      return account ? [{ ...account }] : [];
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
  BUILT_IN_THEMES,
  normalizeTemplate,
  seedMarkets,
  slugify,
};
