"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  XTemplateRegistry,
  DEFAULT_TEMPLATE_ID,
  BUILT_IN_THEMES,
  normalizeTemplate,
} = require("../src/services/x-template-registry");
const {
  X_ACCOUNTS,
  CONSPIRACY_FOLLOWER_X_ACCOUNTS,
  CONSPIRACY_FOLLOWBACK_HANDLES,
} = require("../src/config/x-accounts");

const quietLogger = { warn() {}, error() {}, log() {} };

// What ensureSeeded leaves behind: the markets seed followed by every built-in
// theme, in order. Derived rather than written out so adding a theme to
// src/config/x-themes.js does not mean editing assertions all over this file.
const SEEDED_IDS = [DEFAULT_TEMPLATE_ID].concat(BUILT_IN_THEMES.map((theme) => theme.id));

function tempRegistry(accounts = X_ACCOUNTS) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-templates-"));
  const registry = new XTemplateRegistry({ dataDir, seedAccounts: accounts, logger: quietLogger });
  return { dataDir, registry, file: path.join(dataDir, "x-templates.json") };
}

test("the current account layout seeds Crypto & Stocks without changing its order", () => {
  const { registry, file } = tempRegistry();

  assert.equal(registry.ensureSeeded(), true);
  const template = registry.get();
  assert.equal(template.id, DEFAULT_TEMPLATE_ID);
  assert.equal(template.name, "Crypto & Stocks");
  assert.deepEqual(template.handles, X_ACCOUNTS.map((account) => account.handle));
  assert.equal("sections" in template, false, "a template is a flat list of handles");
  assert.ok(fs.existsSync(file));
});

test("templates persist and allow one handle in several templates", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "macro", name: "Macro", handles: ["Barchart"] });

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  // One account feeding two templates is the point: metadata and cached feed
  // data stay owned by the account registry, so neither is duplicated.
  assert.ok(reopened.get("markets").handles.includes("Barchart"));
  assert.deepEqual(reopened.get("macro").handles, ["Barchart"]);
});

test("an empty template persists as empty rather than being dropped", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "wars", name: "Wars", handles: [] });

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  // A newly created template is empty, and that is the normal state it opens
  // in — not a malformed row for the reader to skip.
  assert.deepEqual(reopened.get("wars").handles, []);
});

test("template updates carry the account order the admin arranged", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "wars", name: "Wars", handles: [] });

  const updated = registry.update("wars", {
    name: "Wars & Geopolitics",
    description: "Conflict intelligence",
    accent: "world",
    handles: ["Barchart", "TechDev_52"],
  });
  assert.equal(updated.name, "Wars & Geopolitics");
  assert.deepEqual(updated.handles, ["Barchart", "TechDev_52"]);

  // Order is the only arrangement a template has, and the sidebar renders it,
  // so a reorder is a real edit that must persist.
  const reordered = registry.update("wars", {
    name: "Wars & Geopolitics",
    handles: ["TechDev_52", "Barchart"],
  });
  assert.deepEqual(reordered.handles, ["TechDev_52", "Barchart"]);
});

test("duplicating and deleting templates never delete or mutate accounts", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const before = JSON.stringify(X_ACCOUNTS);

  const duplicate = registry.duplicate("markets", { name: "Tech & AI", id: "tech" });
  assert.equal(duplicate.id, "tech");
  assert.equal(duplicate.handles.length, X_ACCOUNTS.length);
  registry.remove("tech");

  assert.deepEqual(registry.list().map((entry) => entry.id), SEEDED_IDS);
  assert.equal(JSON.stringify(X_ACCOUNTS), before);
  assert.throws(() => registry.remove("markets"), /cannot be deleted/);
});

test("global account deletion cascades across every template", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "macro", name: "Macro", handles: ["Barchart"] });

  assert.equal(registry.removeHandle("barchart"), true);
  for (const template of registry.list()) {
    assert.ok(!template.handles.some((handle) => handle.toLowerCase() === "barchart"));
  }
});

test("resolved accounts use template sections and ignore dead references", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({
    id: "tech",
    name: "Tech & AI",
    handles: ["TechDev_52", "missing"],
  });

  const resolved = registry.resolveAccounts("tech", X_ACCOUNTS);
  // "missing" is not a tracked account, so it resolves to nothing rather than
  // a row whose feed can never fill.
  assert.deepEqual(resolved.map((account) => account.handle), ["TechDev_52"]);
  // The account keeps its own category: with the sidebar flat, the category is
  // descriptive metadata rather than a grouping key the template overrides.
  assert.equal(resolved[0].category, "Crypto Traders");
});

test("normalization rejects nameless templates and removes duplicate handles", () => {
  assert.throws(() => normalizeTemplate({ id: "empty" }), /name is required/);
  const template = normalizeTemplate({
    id: "clean",
    name: "Clean",
    handles: ["Barchart", "barchart", "@TechDev_52"],
  });
  assert.deepEqual(template.handles, ["Barchart", "TechDev_52"]);
});

test("a template that names one account twice is refused rather than quietly trimmed", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  const payload = { id: "wars", name: "Wars", handles: ["Barchart", "@BARCHART"] };

  assert.throws(() => registry.create(payload), /@BARCHART is already in this template/);
  assert.deepEqual(registry.list().map((entry) => entry.id), SEEDED_IDS, "nothing was saved");

  registry.create({ id: "wars", name: "Wars", handles: [] });
  assert.throws(() => registry.update("wars", payload), /already in this template/);
  assert.equal(registry.get("wars").handles.length, 0, "the rejected update changed nothing");
});

test("a sectioned file from an older build upgrades to a flat handle list", () => {
  // Strict on the way in, lenient on the way out: a file written before
  // sections were removed must not take the switcher down. Its handles are
  // kept in order and its sections discarded.
  const { dataDir, registry, file } = tempRegistry();
  registry.ensureSeeded();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      seededThemes: ["markets"],
      templates: [
        {
          id: "markets",
          name: "Crypto & Stocks",
          sections: ["Market Data", "Crypto Traders"],
          memberships: [
            { handle: "TechDev_52", section: "Crypto Traders" },
            { handle: "Barchart", section: "Market Data" },
            // A repeat an older build could store; merged rather than fatal.
            { handle: "barchart", section: "Crypto Traders" },
          ],
        },
      ],
    }),
    "utf8",
  );

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  const markets = reopened.get("markets");
  assert.deepEqual(markets.handles, ["TechDev_52", "Barchart"]);
  assert.equal("sections" in markets, false);
  assert.equal("memberships" in markets, false);
});

test("the upgraded shape is what gets written back", () => {
  const { dataDir, registry, file } = tempRegistry();
  registry.ensureSeeded();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      seededThemes: ["markets"],
      templates: [{
        id: "markets",
        name: "Crypto & Stocks",
        sections: ["Market Data"],
        memberships: [{ handle: "Barchart", section: "Market Data" }],
      }],
    }),
    "utf8",
  );

  // Any write persists the flat shape, so the migration is a one-way door
  // rather than something re-done on every read forever.
  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  reopened.create({ id: "wars", name: "Wars", handles: [] });
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.version, 4);
  const markets = stored.templates.find((entry) => entry.id === "markets");
  assert.deepEqual(markets.handles, ["Barchart"]);
  assert.equal("sections" in markets, false);
});

test("adding an already tracked handle to the default template is a no-op", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.equal(registry.addHandleToDefault("@barchart"), false);
  const markets = registry.get("markets");
  assert.equal(
    markets.handles.filter((handle) => handle.toLowerCase() === "barchart").length,
    1,
  );
});

test("an account joins the named theme rather than always the default one", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  // The bug this guards: every add landed in markets, so a handle added while
  // the Conspiracy filter was selected was tracked but never shown by it.
  assert.equal(registry.addHandleToTemplate("conspiracy", "NewWatcher"), true);

  const conspiracy = registry.get("conspiracy");
  assert.ok(conspiracy.handles.includes("NewWatcher"));
  assert.equal(
    conspiracy.handles[conspiracy.handles.length - 1],
    "NewWatcher",
    "appended, so an add does not reshuffle the order the sidebar renders",
  );
  assert.equal(
    registry.get("markets").handles.includes("NewWatcher"),
    false,
    "the theme that was not named must be left alone",
  );
});

test("one handle can be added to several themes, and is de-duplicated within each", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.equal(registry.addHandleToTemplate("conspiracy", "Barchart"), true);
  // Already tracked by markets from the seed, and now by conspiracy too: one
  // account feeding two themes is the point of the membership model.
  assert.equal(registry.get("markets").handles.includes("Barchart"), true);
  assert.equal(registry.addHandleToTemplate("conspiracy", "@barchart"), false);
  assert.equal(
    registry.get("conspiracy").handles.filter((h) => h.toLowerCase() === "barchart").length,
    1,
    "a second entry would list the account twice and double its posts",
  );
});

test("naming a theme that does not exist fails rather than writing somewhere else", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.throws(() => registry.addHandleToTemplate("no-such-theme", "NewWatcher"), /not found/);
  assert.throws(() => registry.removeHandleFromTemplate("no-such-theme", "Barchart"), /not found/);
});

test("removing an account from one theme leaves it tracked by the others", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.addHandleToTemplate("conspiracy", "Barchart");

  assert.equal(registry.removeHandleFromTemplate("conspiracy", "@BarChart"), true);
  assert.equal(registry.get("conspiracy").handles.includes("Barchart"), false);
  assert.equal(
    registry.get("markets").handles.includes("Barchart"),
    true,
    "dropping one membership is not untracking the account",
  );
  assert.equal(registry.removeHandleFromTemplate("conspiracy", "Barchart"), false, "idempotent");
});

test("removing an account leaves the rest of the template's order intact", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({
    id: "macro",
    name: "Macro",
    handles: ["Barchart", "TechDev_52", "jasonpizzino"],
  });

  registry.removeHandleFromTemplate("macro", "TechDev_52");
  assert.deepEqual(registry.get("macro").handles, ["Barchart", "jasonpizzino"]);
});

test("removing the last account leaves an empty template, not a deleted one", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "macro", name: "Macro", handles: ["Barchart"] });

  registry.removeHandleFromTemplate("macro", "Barchart");
  const macro = registry.get("macro");
  assert.deepEqual(macro.handles, []);
  assert.equal(macro.name, "Macro", "the template itself survives being emptied");
});

test("removeHandle still clears the account from every theme, unlike the per-theme removal", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.addHandleToTemplate("conspiracy", "Barchart");

  assert.equal(registry.removeHandle("Barchart"), true);
  for (const id of ["markets", "conspiracy"]) {
    assert.equal(registry.get(id).handles.includes("Barchart"), false, id);
  }
});

test("template order is persistent and must name every template exactly once", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "wars", name: "Wars", sections: [], memberships: [] });
  registry.create({ id: "tech", name: "Tech", sections: [], memberships: [] });

  const reversed = SEEDED_IDS.concat(["wars", "tech"]).reverse();
  registry.reorder(reversed);
  assert.deepEqual(registry.list().map((entry) => entry.id), reversed);
  assert.throws(() => registry.reorder(["markets", "wars"]), /every template/);
});

test("a fresh install seeds every built-in theme alongside Crypto & Stocks", () => {
  const { registry, file } = tempRegistry();

  assert.equal(registry.ensureSeeded(), true);
  const ids = registry.list().map((entry) => entry.id);
  assert.equal(ids[0], DEFAULT_TEMPLATE_ID, "markets stays first");
  for (const theme of BUILT_IN_THEMES) {
    const template = registry.get(theme.id);
    assert.deepEqual(template.sections, theme.sections, `${theme.id} keeps its section layout`);
    assert.deepEqual(template.memberships, theme.memberships, `${theme.id} keeps its built-in memberships`);
    assert.equal(template.accent, theme.accent);
  }

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    stored.seededThemes,
    [DEFAULT_TEMPLATE_ID].concat(BUILT_IN_THEMES.map((theme) => theme.id)),
  );
});

test("the conspiracy theme ships its tracked accounts as one flat list", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const theme = registry.get("conspiracy");

  assert.equal(theme.handles.length, 6 + CONSPIRACY_FOLLOWER_X_ACCOUNTS.length);
  assert.deepEqual(theme.handles.slice(0, 6), [
    "RealAlexJones",
    "MattWallace888",
    "VigilantFox",
    "dom_lucre",
    "ShadowofEzra",
    "WarClandestine",
  ]);
  assert.equal("sections" in theme, false);
});

test("an existing conspiracy theme receives the screenshot follower pack exactly once", () => {
  const { dataDir, registry, file } = tempRegistry();
  registry.ensureSeeded();
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.seededMembershipPacks = [];
  const conspiracy = stored.templates.find((template) => template.id === "conspiracy");
  conspiracy.handles = conspiracy.handles.slice(0, 6);
  fs.writeFileSync(file, JSON.stringify(stored), "utf8");

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: X_ACCOUNTS, logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), true);
  const updated = reopened.get("conspiracy");
  assert.equal(updated.handles.length, 6 + CONSPIRACY_FOLLOWER_X_ACCOUNTS.length);
  for (const account of CONSPIRACY_FOLLOWER_X_ACCOUNTS) {
    assert.ok(updated.handles.includes(account.handle), account.handle);
  }
  assert.equal(reopened.ensureSeeded(), false);
});

test("an existing conspiracy theme prunes screenshot accounts marked Follow back", () => {
  const { dataDir, registry, file } = tempRegistry();
  registry.ensureSeeded();
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.seededMembershipPacks = ["conspiracy-followers-2026-09-10"];
  const conspiracy = stored.templates.find((template) => template.id === "conspiracy");
  conspiracy.handles.push(...CONSPIRACY_FOLLOWBACK_HANDLES);
  fs.writeFileSync(file, JSON.stringify(stored), "utf8");

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: X_ACCOUNTS, logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), true);
  assert.ok(!reopened.get("conspiracy").handles.some(
    (handle) => CONSPIRACY_FOLLOWBACK_HANDLES.includes(handle),
  ));
  assert.equal(reopened.ensureSeeded(), false);
});

test("a registry written before the themes existed has them backfilled once", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-templates-v1-"));
  const file = path.join(dataDir, "x-templates.json");
  // Exactly what a version 1 deploy left on the volume: markets and nothing else.
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      templates: [{ id: "markets", name: "Crypto & Stocks", accent: "market", sections: ["Market Data"], memberships: [] }],
    }),
  );

  const registry = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  assert.equal(registry.ensureSeeded(), true, "the missing themes are installed");
  const ids = registry.list().map((entry) => entry.id);
  for (const theme of BUILT_IN_THEMES) assert.ok(ids.includes(theme.id), `${theme.id} was installed`);

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), false, "a second boot installs nothing");
  assert.deepEqual(reopened.list().map((entry) => entry.id), ids, "and changes nothing");
});

test("a deleted built-in theme is not resurrected by the next boot", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  const [theme] = BUILT_IN_THEMES;
  registry.remove(theme.id);

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), false);
  assert.ok(
    !reopened.list().some((entry) => entry.id === theme.id),
    "the theme stays deleted",
  );
});

test("an admin's edits to a built-in theme survive the next boot", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  const [theme] = BUILT_IN_THEMES;
  registry.update(theme.id, {
    name: "My Dig",
    accent: "neutral",
    handles: ["Barchart"],
  });

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  reopened.ensureSeeded();
  const stored = reopened.get(theme.id);
  assert.equal(stored.name, "My Dig");
  assert.deepEqual(stored.handles, ["Barchart"]);
});

test("a template an admin already named after a theme is never overwritten", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-templates-clash-"));
  const file = path.join(dataDir, "x-templates.json");
  const [theme] = BUILT_IN_THEMES;
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      templates: [
        { id: "markets", name: "Crypto & Stocks", accent: "market", handles: [] },
        { id: theme.id, name: "Mine", accent: "world", handles: ["Barchart"] },
      ],
    }),
  );

  const registry = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  registry.ensureSeeded();
  const kept = registry.get(theme.id);
  assert.equal(kept.name, "Mine", "the admin's template is left alone");
  assert.deepEqual(kept.handles, ["Barchart"]);
  assert.equal(
    registry.list().filter((entry) => entry.id === theme.id).length,
    1,
    "and is not joined by a second copy",
  );
});

test("built-in themes are deletable; only Crypto & Stocks is not", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  for (const theme of BUILT_IN_THEMES) {
    assert.equal(registry.remove(theme.id).id, theme.id);
  }
  assert.throws(() => registry.remove(DEFAULT_TEMPLATE_ID), /cannot be deleted/);
});

test("a registry at the template cap defers a theme rather than losing it", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-templates-full-"));
  const file = path.join(dataDir, "x-templates.json");
  const filler = [];
  for (let i = 0; i < 50; i += 1) {
    filler.push({ id: `t${i}`, name: `T${i}`, accent: "market", sections: [], memberships: [] });
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, templates: filler }));

  const registry = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  assert.equal(registry.ensureSeeded(), false, "there is no room for any theme");
  assert.equal(registry.list().length, 50, "and no existing template was pushed out");

  registry.remove("t0");
  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), true, "the freed slot is used on the next boot");
  assert.ok(reopened.list().some((entry) => entry.id === BUILT_IN_THEMES[0].id));
});
