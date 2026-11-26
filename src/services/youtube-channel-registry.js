"use strict";

// One persisted source of truth for YouTube categories, channels and mixes.
// Version 1 stored category names on every channel; version 2 stores stable
// category IDs and resolves names at the API boundary.
//
// A mix is a named, hand-picked set of channels from any categories, viewed as
// one feed. Unlike a category it does not own its channels: a channel sits in
// exactly one category but in any number of mixes. Mixes store handles, and a
// handle that stops being tracked simply drops out of every mix on read.
const fs = require("fs");
const path = require("path");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { YOUTUBE_CHANNELS, isChannelId } = require("../config/youtube-channels");
const { createServiceError } = require("../utils/errors");

const REGISTRY_VERSION = 2;
const MAX_CHANNELS = 200;
const MAX_CATEGORIES = 100;
const MAX_MIXES = 50;
const UNCATEGORIZED_ID = "uncategorized";
const HANDLE_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;
const CATEGORY_ID_PATTERN = /^category:[a-z0-9][a-z0-9-]{0,63}$/;
const MIX_ID_PATTERN = /^mix:[a-z0-9][a-z0-9-]{0,63}$/;

function clean(value, max) { return String(value == null ? "" : value).trim().slice(0, max); }
function normalizeHandle(value) {
  const raw = String(value == null ? "" : value).trim();
  const url = raw.match(/(?:youtube\.com\/(?:@|c\/|user\/))([^/?#]+)/i);
  return String(url ? url[1] : raw).replace(/^@+/, "").trim();
}
function canonicalHandle(value) { return normalizeHandle(value).toLowerCase(); }
function sameHandle(a, b) { return canonicalHandle(a) === canonicalHandle(b); }
function normalizeCategoryName(value) { return clean(value, 40).replace(/\s+/g, " "); }
function canonicalCategoryName(value) { return normalizeCategoryName(value).toLocaleLowerCase(); }
function categorySlug(value) {
  return normalizeCategoryName(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "category";
}
function uniqueCategoryId(name, categories) {
  const base = `category:${categorySlug(name)}`;
  const ids = new Set(categories.map((item) => item.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
function isMixId(value) { return MIX_ID_PATTERN.test(String(value || "")); }
function uniqueMixId(name, mixes) {
  const base = `mix:${categorySlug(name)}`;
  const ids = new Set(mixes.map((item) => item.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
/**
 * Validates a mix's name and channels against what is tracked. Handles are
 * stored as the registry spells them, de-duplicated, in the order given.
 */
function normalizeMix(input, mixes, channels, exceptId) {
  const name = normalizeCategoryName(input?.name);
  if (!name) throw createServiceError("A mix name is required", 400);
  const duplicate = mixes.find((item) => item.id !== exceptId && canonicalCategoryName(item.name) === canonicalCategoryName(name));
  if (duplicate) throw createServiceError(`The mix "${duplicate.name}" already exists`, 409);
  if (!Array.isArray(input?.handles)) throw createServiceError("Choose the channels for this mix", 400);
  const handles = [];
  for (const raw of input.handles) {
    const tracked = channels.find((channel) => sameHandle(channel.handle, raw));
    if (!tracked) throw createServiceError(`@${normalizeHandle(raw)} is not tracked`, 400);
    if (!handles.some((handle) => sameHandle(handle, tracked.handle))) handles.push(tracked.handle);
  }
  if (!handles.length) throw createServiceError("Choose at least one channel for this mix", 400);
  if (handles.length > MAX_CHANNELS) throw createServiceError(`A mix can hold at most ${MAX_CHANNELS} channels`, 400);
  return { name, handles };
}
function mixView(mix, channels) {
  const handles = mix.handles.filter((handle) => channels.some((channel) => sameHandle(channel.handle, handle)));
  return { id: mix.id, name: mix.name, handles, channelCount: handles.length, createdAt: mix.createdAt || null };
}
function categoryView(category, channelCount = 0) {
  return { id: category.id, name: category.name, slug: category.slug, createdAt: category.createdAt || null, channelCount };
}
function uncategorizedView(channelCount = 0) {
  return { id: UNCATEGORIZED_ID, name: "Uncategorized", slug: UNCATEGORIZED_ID, createdAt: null, channelCount, virtual: true };
}
function normalizeCategory(input, categories = [], keepId = false) {
  const name = normalizeCategoryName(input?.name ?? input);
  if (!name) throw createServiceError("A category name is required", 400);
  const duplicate = categories.find((item) => canonicalCategoryName(item.name) === canonicalCategoryName(name));
  if (duplicate) throw createServiceError(`The category "${duplicate.name}" already exists`, 409);
  const requested = keepId ? String(input?.id || "").trim() : "";
  return {
    id: CATEGORY_ID_PATTERN.test(requested) ? requested : uniqueCategoryId(name, categories),
    name,
    slug: categorySlug(name),
    createdAt: input?.createdAt || new Date().toISOString(),
  };
}
function dedupeChannels(channels) {
  const seen = new Set(); const unique = []; let dropped = 0;
  for (const channel of channels || []) {
    const key = canonicalHandle(channel?.handle);
    if (!key || seen.has(key)) { dropped += 1; continue; }
    seen.add(key); unique.push(channel);
  }
  return { channels: unique, dropped };
}
function normalizeChannelFields(input) {
  const handle = normalizeHandle(input?.handle);
  if (!handle) throw createServiceError("A YouTube handle is required", 400);
  if (!HANDLE_PATTERN.test(handle)) throw createServiceError(`"${handle}" is not a valid YouTube handle`, 400);
  const channelId = String(input?.channelId == null ? "" : input.channelId).trim();
  if (channelId && !isChannelId(channelId)) throw createServiceError(`"${channelId}" is not a valid channel ID (UC followed by 22 characters)`, 400);
  return { handle, label: clean(input?.label ?? input?.displayName, 60) || handle, channelId };
}
function resolveCategoryId(input, categories) {
  const id = String(input?.categoryId == null ? "" : input.categoryId).trim();
  if (id === UNCATEGORIZED_ID) return null;
  if (!id && !input?.category) throw createServiceError("A category is required", 400);
  if (id) {
    if (categories.some((category) => category.id === id)) return id;
    throw createServiceError("Choose an existing category", 400);
  }
  const wanted = canonicalCategoryName(input?.category);
  const match = categories.find((category) => canonicalCategoryName(category.name) === wanted);
  if (!match) throw createServiceError("Choose an existing category", 400);
  return match.id;
}
function normalizeChannel(input, categories = []) {
  return { ...normalizeChannelFields(input), categoryId: resolveCategoryId(input, categories) };
}

class YoutubeChannelRegistry {
  // `categorySeed` names categories a first boot should have beyond the ones its
  // seeded channels are filed under. It defaults to none: the app passes no seed,
  // because a category nothing is filed under is noise in the filter. It stays a
  // constructor option so a deployment can still ask for one deliberately.
  constructor({ dataDir, seed = YOUTUBE_CHANNELS, categorySeed = [], logger = console } = {}) {
    this._file = path.join(dataDir, "youtube-channels.json");
    this._lockState = { depth: 0 }; this._logger = logger;
    this._seed = Array.isArray(seed) ? seed : [];
    this._categorySeed = Array.isArray(categorySeed) ? categorySeed : [];
    this._loadState = "unread"; this._loadError = null;
    this._corruptBackedUp = false; this._needsMigration = false;
  }

  _seedState() {
    const categories = [];
    const addName = (value) => {
      const name = normalizeCategoryName(value);
      if (name && !categories.some((item) => canonicalCategoryName(item.name) === canonicalCategoryName(name))) {
        categories.push(normalizeCategory({ name }, categories));
      }
    };
    this._categorySeed.forEach(addName); this._seed.forEach((channel) => addName(channel?.category));
    const channels = [];
    for (const entry of this._seed) {
      try {
        const category = categories.find((item) => canonicalCategoryName(item.name) === canonicalCategoryName(entry?.category));
        channels.push({ ...normalizeChannelFields(entry), categoryId: category?.id || null, addedAt: entry?.addedAt || null });
      } catch { /* ignore malformed seed row */ }
    }
    return { categories, channels, mixes: [] };
  }

  _normalizeState(parsed) {
    const legacy = Array.isArray(parsed) || Number(parsed?.version || 1) < REGISTRY_VERSION;
    const sourceChannels = Array.isArray(parsed) ? parsed : parsed?.channels;
    if (!Array.isArray(sourceChannels)) throw new SyntaxError("no channels array");
    const categories = [];
    const addLegacyName = (value) => {
      const name = normalizeCategoryName(value);
      if (name && !categories.some((item) => canonicalCategoryName(item.name) === canonicalCategoryName(name))) {
        categories.push(normalizeCategory({ name }, categories));
      }
    };
    if (legacy) {
      this._categorySeed.forEach(addLegacyName);
      sourceChannels.forEach((channel) => addLegacyName(channel?.category));
    } else {
      for (const entry of parsed.categories || []) {
        try {
          const category = normalizeCategory(entry, categories, true);
          if (!categories.some((item) => item.id === category.id)) categories.push(category);
        } catch { /* skip duplicate or malformed category */ }
      }
    }

    const channels = []; let malformed = 0; let duplicates = 0;
    for (const entry of sourceChannels) {
      try {
        const fields = normalizeChannelFields(entry);
        if (channels.some((item) => sameHandle(item.handle, fields.handle))) { duplicates += 1; continue; }
        const categoryId = legacy
          ? categories.find((item) => canonicalCategoryName(item.name) === canonicalCategoryName(entry?.category))?.id || null
          : categories.some((item) => item.id === entry?.categoryId) ? entry.categoryId : null;
        channels.push({ ...fields, categoryId, addedAt: entry?.addedAt || null });
      } catch { malformed += 1; }
    }
    const mixes = [];
    for (const entry of (legacy ? [] : parsed.mixes || [])) {
      const name = normalizeCategoryName(entry?.name);
      if (!name || !isMixId(entry?.id) || mixes.some((item) => item.id === entry.id)) continue;
      const handles = (Array.isArray(entry.handles) ? entry.handles : [])
        .map((handle) => normalizeHandle(handle)).filter((handle) => HANDLE_PATTERN.test(handle));
      mixes.push({ id: entry.id, name, handles, createdAt: entry.createdAt || null });
    }
    this._needsMigration = legacy;
    const notes = [];
    if (legacy) notes.push("version 1 data migrated to category IDs");
    if (malformed) notes.push(`${malformed} malformed entries skipped`);
    if (duplicates) notes.push(`${duplicates} duplicate handles merged`);
    this._loadState = notes.length ? "partial" : "loaded";
    this._loadError = notes.length ? notes.join("; ") : null;
    return { categories, channels, mixes };
  }

  _read() {
    try {
      return this._normalizeState(JSON.parse(fs.readFileSync(this._file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") {
        this._loadState = "seeded"; this._loadError = null; this._needsMigration = false;
        return this._seedState();
      }
      this._loadState = "corrupt"; this._loadError = error.message;
      this._logger.error?.(`[YoutubeChannels] ${this._file} is unreadable (${error.message}); serving the seed list instead`);
      return this._seedState();
    }
  }

  _write(state) {
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try { fs.copyFileSync(this._file, `${this._file}.corrupt`); this._corruptBackedUp = true; } catch { /* best effort */ }
    }
    const { channels, dropped } = dedupeChannels(state.channels);
    if (dropped) this._logger.warn?.(`[YoutubeChannels] Dropped ${dropped} duplicate channel rows before saving`);
    const ok = writeJsonAtomic(this._file, {
      version: REGISTRY_VERSION,
      categories: state.categories.slice(0, MAX_CATEGORIES),
      channels: channels.slice(0, MAX_CHANNELS),
      mixes: (state.mixes || []).slice(0, MAX_MIXES),
    }, this._logger, "[YoutubeChannels]");
    if (ok) { this._loadState = "loaded"; this._loadError = null; this._needsMigration = false; }
    return ok;
  }
  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, { busyMessage: "The YouTube source registry is busy; retry the request." });
  }
  list() {
    const state = this._read(); const byId = new Map(state.categories.map((item) => [item.id, item]));
    return state.channels.map(({ handle, label, channelId, categoryId }) => ({
      handle, label, channelId,
      categoryId: categoryId || UNCATEGORIZED_ID,
      category: byId.get(categoryId)?.name || "Uncategorized",
    }));
  }
  listCategories() {
    const state = this._read(); const counts = new Map(); let other = 0;
    const valid = new Set(state.categories.map((item) => item.id));
    state.channels.forEach((channel) => {
      if (!channel.categoryId || !valid.has(channel.categoryId)) other += 1;
      else counts.set(channel.categoryId, (counts.get(channel.categoryId) || 0) + 1);
    });
    const categories = state.categories.map((item) => categoryView(item, counts.get(item.id) || 0));
    return other ? categories.concat(uncategorizedView(other)) : categories;
  }
  ensureSeeded() {
    return this._withLock(() => {
      if (!fs.existsSync(this._file)) return this._write(this._seedState());
      const state = this._read(); if (this._needsMigration) this._write(state); return false;
    });
  }
  add(input) {
    return this._withLock(() => {
      const state = this._read(); const channel = normalizeChannel(input, state.categories);
      if (state.channels.some((item) => sameHandle(item.handle, channel.handle))) throw createServiceError(`@${channel.handle} is already tracked`, 409);
      if (state.channels.length >= MAX_CHANNELS) throw createServiceError(`At most ${MAX_CHANNELS} channels can be tracked`, 400);
      const stored = { ...channel, addedAt: new Date().toISOString() };
      if (!this._write({ ...state, channels: state.channels.concat(stored) })) throw createServiceError("Could not save the source registry", 500);
      return stored;
    });
  }
  update(handleInput, input) {
    return this._withLock(() => {
      const state = this._read(); const index = state.channels.findIndex((item) => sameHandle(item.handle, handleInput));
      if (index < 0) throw createServiceError(`@${normalizeHandle(handleInput)} is not tracked`, 404);
      const updated = normalizeChannel(input, state.categories);
      if (state.channels.some((item, i) => i !== index && sameHandle(item.handle, updated.handle))) throw createServiceError(`@${updated.handle} is already tracked`, 409);
      const previous = state.channels[index].handle;
      const channels = state.channels.slice(); channels[index] = { ...updated, addedAt: channels[index].addedAt || null };
      // A corrected handle keeps its place in every mix it was in.
      const mixes = (state.mixes || []).map((mix) => ({
        ...mix, handles: mix.handles.map((handle) => sameHandle(handle, previous) ? updated.handle : handle),
      }));
      if (!this._write({ ...state, channels, mixes })) throw createServiceError("Could not save the source registry", 500);
      return channels[index];
    });
  }
  remove(handleInput) {
    return this._withLock(() => {
      const state = this._read(); const existing = state.channels.find((item) => sameHandle(item.handle, handleInput));
      if (!existing) throw createServiceError(`@${normalizeHandle(handleInput)} is not tracked`, 404);
      const mixes = (state.mixes || []).map((mix) => ({ ...mix, handles: mix.handles.filter((handle) => !sameHandle(handle, handleInput)) }));
      if (!this._write({ ...state, channels: state.channels.filter((item) => !sameHandle(item.handle, handleInput)), mixes })) throw createServiceError("Could not save the source registry", 500);
      return existing;
    });
  }
  addCategory(input) {
    return this._withLock(() => {
      const state = this._read();
      if (state.categories.length >= MAX_CATEGORIES) throw createServiceError(`At most ${MAX_CATEGORIES} categories can be created`, 400);
      const category = normalizeCategory(input, state.categories);
      if (!this._write({ ...state, categories: state.categories.concat(category) })) throw createServiceError("Could not save the source registry", 500);
      return categoryView(category);
    });
  }
  updateCategory(categoryId, input) {
    return this._withLock(() => {
      const state = this._read(); const index = state.categories.findIndex((item) => item.id === categoryId);
      if (index < 0) throw createServiceError("Category not found", 404);
      const name = normalizeCategoryName(input?.name);
      if (!name) throw createServiceError("A category name is required", 400);
      if (state.categories.some((item, i) => i !== index && canonicalCategoryName(item.name) === canonicalCategoryName(name))) throw createServiceError(`The category "${name}" already exists`, 409);
      const categories = state.categories.slice(); categories[index] = { ...categories[index], name, slug: categorySlug(name) };
      if (!this._write({ ...state, categories })) throw createServiceError("Could not save the source registry", 500);
      return categoryView(categories[index], state.channels.filter((item) => item.categoryId === categoryId).length);
    });
  }
  removeCategory(categoryId, { reassignToCategoryId } = {}) {
    return this._withLock(() => {
      const state = this._read(); const category = state.categories.find((item) => item.id === categoryId);
      if (!category) throw createServiceError("Category not found", 404);
      const assigned = state.channels.filter((item) => item.categoryId === categoryId).length;
      let replacement = null;
      if (assigned) {
        if (reassignToCategoryId == null) {
          const error = createServiceError(`${category.name} contains ${assigned} channels; choose where to move them`, 409);
          error.code = "CATEGORY_NOT_EMPTY"; error.channelCount = assigned; throw error;
        }
        if (reassignToCategoryId !== UNCATEGORIZED_ID) {
          replacement = state.categories.find((item) => item.id === reassignToCategoryId);
          if (!replacement || replacement.id === categoryId) throw createServiceError("Choose another category or Uncategorized", 400);
        }
      }
      const channels = state.channels.map((item) => item.categoryId === categoryId ? { ...item, categoryId: replacement?.id || null } : item);
      if (!this._write({ ...state, categories: state.categories.filter((item) => item.id !== categoryId), channels })) throw createServiceError("Could not save the source registry", 500);
      return { ...categoryView(category, assigned), reassignedToCategoryId: replacement?.id || UNCATEGORIZED_ID };
    });
  }
  listMixes() {
    const state = this._read();
    return state.mixes.map((mix) => mixView(mix, state.channels));
  }
  /** The tracked channels in a mix, in the same shape list() returns. */
  mixChannels(mixId) {
    const mix = this.listMixes().find((item) => item.id === mixId);
    if (!mix) return null;
    return this.list().filter((channel) => mix.handles.some((handle) => sameHandle(handle, channel.handle)));
  }
  addMix(input) {
    return this._withLock(() => {
      const state = this._read();
      if (state.mixes.length >= MAX_MIXES) throw createServiceError(`At most ${MAX_MIXES} mixes can be saved`, 400);
      const fields = normalizeMix(input, state.mixes, state.channels);
      const mix = { id: uniqueMixId(fields.name, state.mixes), ...fields, createdAt: new Date().toISOString() };
      if (!this._write({ ...state, mixes: state.mixes.concat(mix) })) throw createServiceError("Could not save the source registry", 500);
      return mixView(mix, state.channels);
    });
  }
  updateMix(mixId, input) {
    return this._withLock(() => {
      const state = this._read(); const index = state.mixes.findIndex((item) => item.id === mixId);
      if (index < 0) throw createServiceError("Mix not found", 404);
      const fields = normalizeMix(input, state.mixes, state.channels, mixId);
      const mixes = state.mixes.slice(); mixes[index] = { ...mixes[index], ...fields };
      if (!this._write({ ...state, mixes })) throw createServiceError("Could not save the source registry", 500);
      return mixView(mixes[index], state.channels);
    });
  }
  removeMix(mixId) {
    return this._withLock(() => {
      const state = this._read(); const mix = state.mixes.find((item) => item.id === mixId);
      if (!mix) throw createServiceError("Mix not found", 404);
      if (!this._write({ ...state, mixes: state.mixes.filter((item) => item.id !== mixId) })) throw createServiceError("Could not save the source registry", 500);
      return mixView(mix, state.channels);
    });
  }
  describe() {
    const state = this._read();
    return { file: this._file, version: REGISTRY_VERSION, loadState: this._loadState, loadError: this._loadError, channels: state.channels.length, categories: state.categories.length, mixes: state.mixes.length, seedChannels: this._seed.length };
  }
}

module.exports = {
  YoutubeChannelRegistry, normalizeHandle, canonicalHandle, sameHandle,
  normalizeCategoryName, canonicalCategoryName, categorySlug, dedupeChannels,
  normalizeChannel, HANDLE_PATTERN, MAX_CHANNELS, MAX_CATEGORIES, MAX_MIXES,
  UNCATEGORIZED_ID, REGISTRY_VERSION, isMixId,
};
