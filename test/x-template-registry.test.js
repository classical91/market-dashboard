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
const { X_ACCOUNTS } = require("../src/config/x-accounts");

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
  assert.deepEqual(template.sections, ["Market Data", "Crypto Traders", "TA & Signals"]);
  assert.deepEqual(
    template.memberships.map((entry) => entry.handle),
    X_ACCOUNTS.map((account) => account.handle),
  );
  assert.ok(fs.existsSync(file));
});

test("templates persist, preserve empty sections, and allow one handle in several templates", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({
    id: "macro",
    name: "Macro",
    sections: ["Data", "Official Sources"],
    memberships: [{ handle: "Barchart", section: "Data" }],
  });

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  const markets = reopened.get("markets");
  const macro = reopened.get("macro");
  assert.ok(markets.memberships.some((entry) => entry.handle === "Barchart"));
  assert.ok(macro.memberships.some((entry) => entry.handle === "Barchart"));
  assert.deepEqual(macro.sections, ["Data", "Official Sources"]);
});

test("template updates support section and membership reordering", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "wars", name: "Wars", sections: [], memberships: [] });

  const updated = registry.update("wars", {
    name: "Wars & Geopolitics",
    description: "Conflict intelligence",
    accent: "world",
    sections: ["Official Sources", "Conflict Monitors"],
    memberships: [
      { handle: "Barchart", section: "Conflict Monitors" },
      { handle: "TechDev_52", section: "Official Sources" },
    ],
  });

  assert.equal(updated.name, "Wars & Geopolitics");
  assert.deepEqual(updated.sections, ["Official Sources", "Conflict Monitors"]);
  assert.deepEqual(updated.memberships.map((entry) => entry.handle), ["Barchart", "TechDev_52"]);
});

test("duplicating and deleting templates never delete or mutate accounts", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const before = JSON.stringify(X_ACCOUNTS);

  const duplicate = registry.duplicate("markets", { name: "Tech & AI", id: "tech" });
  assert.equal(duplicate.id, "tech");
  assert.equal(duplicate.memberships.length, X_ACCOUNTS.length);
  registry.remove("tech");

  assert.deepEqual(registry.list().map((entry) => entry.id), SEEDED_IDS);
  assert.equal(JSON.stringify(X_ACCOUNTS), before);
  assert.throws(() => registry.remove("markets"), /cannot be deleted/);
});

test("global account deletion cascades across every template", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({
    id: "macro",
    name: "Macro",
    sections: ["Data"],
    memberships: [{ handle: "Barchart", section: "Data" }],
  });

  assert.equal(registry.removeHandle("barchart"), true);
  for (const template of registry.list()) {
    assert.ok(!template.memberships.some((entry) => entry.handle.toLowerCase() === "barchart"));
  }
});

test("resolved accounts use template sections and ignore dead references", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({
    id: "tech",
    name: "Tech & AI",
    sections: ["Researchers"],
    memberships: [
      { handle: "TechDev_52", section: "Researchers" },
      { handle: "missing", section: "Researchers" },
    ],
  });

  const resolved = registry.resolveAccounts("tech", X_ACCOUNTS);
  assert.deepEqual(resolved.map((account) => account.handle), ["TechDev_52"]);
  assert.equal(resolved[0].category, "Researchers");
});

test("normalization rejects nameless templates and removes duplicate membership handles", () => {
  assert.throws(() => normalizeTemplate({ id: "empty" }), /name is required/);
  const template = normalizeTemplate({
    id: "clean",
    name: "Clean",
    sections: ["One", "one", "Two"],
    memberships: [
      { handle: "Barchart", section: "One" },
      { handle: "barchart", section: "Two" },
    ],
  });
  assert.deepEqual(template.sections, ["One", "Two"]);
  assert.equal(template.memberships.length, 1);
});

test("a template that names one account twice is refused rather than quietly trimmed", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  const payload = {
    id: "wars",
    name: "Wars",
    sections: ["Official Sources", "Conflict Monitors"],
    memberships: [
      { handle: "Barchart", section: "Official Sources" },
      { handle: "@BARCHART", section: "Conflict Monitors" },
    ],
  };

  assert.throws(() => registry.create(payload), /@Barchart is already in this template/);
  assert.deepEqual(registry.list().map((entry) => entry.id), SEEDED_IDS, "nothing was saved");

  registry.create({ id: "wars", name: "Wars", sections: [], memberships: [] });
  assert.throws(() => registry.update("wars", payload), /already in this template/);
  assert.equal(registry.get("wars").memberships.length, 0, "the rejected update changed nothing");
});

test("a stored template naming one account twice still loads, with the repeat merged", () => {
  // Strict on the way in, lenient on the way out: a file written by an older
  // build must not take the switcher down.
  const { dataDir, registry, file } = tempRegistry();
  registry.ensureSeeded();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      templates: [
        {
          id: "markets",
          name: "Crypto & Stocks",
          sections: ["Market Data", "Crypto Traders"],
          memberships: [
            { handle: "Barchart", section: "Market Data" },
            { handle: "barchart", section: "Crypto Traders" },
          ],
        },
      ],
    }),
    "utf8",
  );

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  const markets = reopened.get("markets");
  assert.deepEqual(markets.memberships, [{ handle: "Barchart", section: "Market Data" }]);
});

test("adding an already tracked handle to the default template is a no-op", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.equal(registry.addHandleToDefault("@barchart", "Somewhere Else"), false);
  const markets = registry.get("markets");
  assert.equal(
    markets.memberships.filter((entry) => entry.handle.toLowerCase() === "barchart").length,
    1,
  );
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
    assert.deepEqual(template.memberships, [], `${theme.id} ships unpopulated`);
    assert.equal(template.accent, theme.accent);
  }

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    stored.seededThemes,
    [DEFAULT_TEMPLATE_ID].concat(BUILT_IN_THEMES.map((theme) => theme.id)),
  );
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
    sections: ["Only This One"],
    memberships: [],
  });

  const reopened = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  reopened.ensureSeeded();
  const stored = reopened.get(theme.id);
  assert.equal(stored.name, "My Dig");
  assert.deepEqual(stored.sections, ["Only This One"]);
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
        { id: "markets", name: "Crypto & Stocks", accent: "market", sections: ["Market Data"], memberships: [] },
        { id: theme.id, name: "Mine", accent: "world", sections: ["Mine"], memberships: [] },
      ],
    }),
  );

  const registry = new XTemplateRegistry({ dataDir, seedAccounts: [], logger: quietLogger });
  registry.ensureSeeded();
  const kept = registry.get(theme.id);
  assert.equal(kept.name, "Mine", "the admin's template is left alone");
  assert.deepEqual(kept.sections, ["Mine"]);
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
