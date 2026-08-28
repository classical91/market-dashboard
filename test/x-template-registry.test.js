"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  XTemplateRegistry,
  DEFAULT_TEMPLATE_ID,
  normalizeTemplate,
} = require("../src/services/x-template-registry");
const { X_ACCOUNTS, WAR_ACCOUNTS } = require("../src/config/x-accounts");

const quietLogger = { warn() {}, error() {}, log() {} };

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
    X_ACCOUNTS.filter((account) => !WAR_ACCOUNTS.includes(account)).map((account) => account.handle),
  );
  assert.ok(fs.existsSync(file));
  assert.deepEqual(registry.list().map((entry) => entry.id), ["markets", "war"]);
});

test("the war template contains every requested source once and separates monitoring-only sources", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const war = registry.get("war");
  const handles = war.memberships.map((entry) => entry.handle.toLowerCase());

  assert.equal(handles.length, 17);
  assert.equal(new Set(handles).size, 17);
  for (const handle of ["reutersworld", "afp", "geoconfirmed", "osinttechnical", "acledinfo", "thestudyofwar", "liveuamap", "bellingcat", "kofmanmichael", "ralee85", "rusi_org", "iiss_org", "csis", "warontherocks", "crisisgroup", "sentdefender", "wartranslated"]) {
    assert.ok(handles.includes(handle), `missing @${handle}`);
  }
  for (const handle of ["sentdefender", "wartranslated"]) {
    assert.equal(war.memberships.find((entry) => entry.handle.toLowerCase() === handle).section, "Fast / Source Monitoring");
  }
});

test("version-one registries gain war sources without losing existing entries or case-insensitive dedupe", () => {
  const { registry, file } = tempRegistry();
  fs.writeFileSync(file, JSON.stringify({ version: 1, templates: [{
    id: "war", name: "Existing War Desk", sections: ["Local"],
    memberships: [{ handle: "REUTERSWORLD", section: "Local" }, { handle: "Barchart", section: "Local" }],
  }] }));

  assert.equal(registry.ensureSeeded(), true);
  const war = registry.get("war");
  assert.equal(war.name, "Existing War Desk");
  assert.ok(war.memberships.some((entry) => entry.handle === "Barchart"));
  assert.equal(war.memberships.filter((entry) => entry.handle.toLowerCase() === "reutersworld").length, 1);
  assert.equal(war.memberships.length, 18);
  assert.equal(registry.ensureSeeded(), false);
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
  assert.equal(duplicate.memberships.length, X_ACCOUNTS.length - WAR_ACCOUNTS.length);
  registry.remove("tech");

  assert.deepEqual(registry.list().map((entry) => entry.id), ["markets", "war"]);
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

test("template order is persistent and must name every template exactly once", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  registry.create({ id: "wars", name: "Wars", sections: [], memberships: [] });
  registry.create({ id: "tech", name: "Tech", sections: [], memberships: [] });

  registry.reorder(["tech", "markets", "war", "wars"]);
  assert.deepEqual(registry.list().map((entry) => entry.id), ["tech", "markets", "war", "wars"]);
  assert.throws(() => registry.reorder(["markets", "war", "wars"]), /every template/);
});
