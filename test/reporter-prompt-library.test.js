"use strict";

// The prompt library behind Settings → Reporter → Report Prompts.
//
// These exercise the rules directly rather than asserting that settings.html
// contains a "Delete" button: what matters is that a desk can never be left
// without a prompt to generate from, that deleting the prompt a desk is using
// falls back rather than breaking it, and that an untouched desk default still
// sends nothing so the server's own (longer) prompt keeps running.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const AppSettings = require("../public/assets/js/settings.js");
const P = AppSettings.ReporterPrompts;

function fresh() {
  return P.create(null);
}

/* ── Shape ──────────────────────────────────────────────────────────────── */

test("a fresh library has one built-in prompt per desk, each of them active", () => {
  const library = fresh();
  assert.deepEqual(
    library.prompts.map((prompt) => prompt.section),
    P.SECTIONS,
  );
  P.SECTIONS.forEach((section) => {
    const prompt = P.activePrompt(library, section);
    assert.equal(prompt.id, P.builtinId(section));
    assert.equal(prompt.builtin, true);
    assert.equal(prompt.text, P.DEFAULT_TEXT[section]);
    assert.equal(prompt.title, P.DEFAULT_TITLES[section]);
  });
});

test("geopolitics is a manageable desk, not just a reporter tab", () => {
  // The old settings dropdown offered three desks and silently omitted the
  // fourth, so the geopolitics prompt could not be edited at all.
  assert.ok(P.SECTIONS.includes("geopolitics"));
  assert.ok(P.activePrompt(fresh(), "geopolitics"));
});

/* ── Add / rename / delete ──────────────────────────────────────────────── */

test("a prompt can be added, retitled and moved between desks", () => {
  const added = P.add(fresh(), { title: "  Meme   coins  ", section: "crypto", text: "find memes" });
  let library = added.library;
  const prompt = P.find(library, added.id);
  assert.equal(prompt.title, "Meme coins", "whitespace is collapsed");
  assert.equal(prompt.builtin, false);
  assert.equal(prompt.section, "crypto");

  library = P.update(library, added.id, { title: "Meme desk", section: "markets" });
  assert.equal(P.find(library, added.id).title, "Meme desk");
  assert.equal(P.find(library, added.id).section, "markets");
});

test("a titleless prompt gets a name rather than an empty row in the picker", () => {
  const added = P.add(fresh(), { title: "   ", section: "markets", text: "body" });
  assert.equal(P.find(added.library, added.id).title, "New prompt");
});

test("a custom prompt can be deleted; a desk default resets instead", () => {
  const added = P.add(fresh(), { title: "Scratch", section: "economics", text: "body" });
  const afterDelete = P.remove(added.library, added.id);
  assert.equal(P.find(afterDelete, added.id), null);

  const builtin = P.builtinId("economics");
  const afterBuiltinDelete = P.remove(fresh(), builtin);
  assert.ok(P.find(afterBuiltinDelete, builtin), "a desk always keeps something to generate from");
});

test("duplicating copies the text and leaves the original alone", () => {
  const source = P.builtinId("markets");
  const copied = P.duplicate(fresh(), source);
  const copy = P.find(copied.library, copied.id);
  assert.notEqual(copy.id, source);
  assert.equal(copy.builtin, false);
  assert.equal(copy.text, P.DEFAULT_TEXT.markets);
  assert.match(copy.title, /copy$/);
  assert.equal(P.find(copied.library, source).title, P.DEFAULT_TITLES.markets);
});

/* ── Which prompt a desk uses ───────────────────────────────────────────── */

test("deleting the prompt a desk is using falls back to that desk's default", () => {
  const added = P.add(fresh(), { title: "Weekend crypto", section: "crypto", text: "weekend only" });
  let library = P.setActive(added.library, added.id);
  assert.equal(library.active.crypto, added.id);

  library = P.remove(library, added.id);
  assert.equal(library.active.crypto, P.builtinId("crypto"));
  assert.equal(P.textFor(library, "crypto"), P.DEFAULT_TEXT.crypto);
});

test("moving the active prompt to another desk hands the old desk back its default", () => {
  const added = P.add(fresh(), { title: "Roaming", section: "crypto", text: "roaming body" });
  let library = P.setActive(added.library, added.id);
  library = P.update(library, added.id, { section: "markets" });

  assert.equal(library.active.crypto, P.builtinId("crypto"), "crypto is not left pointing at a prompt that moved away");
  assert.equal(library.active.markets, P.builtinId("markets"), "and markets is not silently taken over");
});

test("a desk default cannot be moved off its own desk", () => {
  const library = P.update(fresh(), P.builtinId("crypto"), { section: "markets" });
  assert.equal(P.find(library, P.builtinId("crypto")).section, "crypto");
});

/* ── What gets sent to the server ───────────────────────────────────────── */

test("an untouched desk default sends no override, so the server's own prompt runs", () => {
  const library = fresh();
  P.SECTIONS.forEach((section) => {
    assert.equal(P.overrideFor(library, section), "");
  });
});

test("an edited default, and any custom prompt, are sent as the override", () => {
  const edited = P.update(fresh(), P.builtinId("economics"), { text: "just the CPI print {date}" });
  assert.equal(P.overrideFor(edited, "economics"), "just the CPI print {date}");

  const added = P.add(fresh(), { title: "Tokens only", section: "crypto", text: "tokens {date}" });
  const active = P.setActive(added.library, added.id);
  assert.equal(P.overrideFor(active, "crypto"), "tokens {date}");
});

test("retitling a default does not start overriding the server prompt", () => {
  // A title is a label in the picker; only the text is sent to the API.
  const renamed = P.update(fresh(), P.builtinId("crypto"), { title: "Trending Tokens" });
  assert.equal(P.overrideFor(renamed, "crypto"), "");
});

test("emptying a prompt restores its desk default rather than generating from nothing", () => {
  const library = P.update(fresh(), P.builtinId("markets"), { text: "   " });
  assert.equal(P.find(library, P.builtinId("markets")).text, P.DEFAULT_TEXT.markets);
});

test("resetting a default restores both its title and its text", () => {
  let library = P.update(fresh(), P.builtinId("crypto"), { title: "Renamed", text: "rewritten" });
  library = P.reset(library, P.builtinId("crypto"));
  const prompt = P.find(library, P.builtinId("crypto"));
  assert.equal(prompt.title, P.DEFAULT_TITLES.crypto);
  assert.equal(prompt.text, P.DEFAULT_TEXT.crypto);
});

test("prompt text is capped at the same length the server accepts", () => {
  const added = P.add(fresh(), { title: "Long", section: "crypto", text: "x".repeat(P.MAX_PROMPT_LEN + 500) });
  assert.equal(P.find(added.library, added.id).text.length, P.MAX_PROMPT_LEN);
});

/* ── Reading storage back ───────────────────────────────────────────────── */

test("a corrupt or half-written library still yields four usable desks", () => {
  const repaired = P.normalize({
    prompts: [
      null,
      { id: "desk:crypto" },
      { id: "junk", title: "no text" },
      { id: "ok", title: "Fine", section: "not-a-desk", text: "body" },
    ],
    active: { crypto: "gone", markets: "ok" },
  });

  P.SECTIONS.forEach((section) => {
    assert.ok(P.activePrompt(repaired, section), `${section} resolves to a prompt`);
    assert.ok(P.textFor(repaired, section));
  });
  assert.equal(P.find(repaired, "junk"), null, "a prompt with no text is dropped");
  assert.equal(P.find(repaired, "ok").section, "crypto", "an unknown desk falls back to crypto");
  assert.equal(repaired.active.crypto, P.builtinId("crypto"), "an active id that no longer exists falls back");
  assert.equal(repaired.active.markets, P.builtinId("markets"), "so does one pointing at another desk's prompt");
});

test("prompts saved under the old per-section keys are carried into the library", () => {
  const library = P.create({ crypto: "my old crypto prompt", markets: "  " });
  assert.equal(P.textFor(library, "crypto"), "my old crypto prompt");
  assert.equal(P.overrideFor(library, "crypto"), "my old crypto prompt");
  assert.equal(P.textFor(library, "markets"), P.DEFAULT_TEXT.markets, "a blank legacy value is not an edit");
});

/* ── Round trip through AppSettings ─────────────────────────────────────── */

test("AppSettings persists the library and the per-desk accessors read through it", () => {
  const added = AppSettings.addReporterPrompt({ title: "Session test", section: "economics", text: "session body" });
  AppSettings.useReporterPrompt(added.id);

  assert.equal(AppSettings.getReporterPrompt("economics"), "session body");
  assert.equal(AppSettings.getReporterPromptOverride("economics"), "session body");
  assert.equal(AppSettings.getReporterPromptLibrary().active.economics, added.id);

  AppSettings.removeReporterPrompt(added.id);
  assert.equal(AppSettings.getReporterPromptOverride("economics"), "", "and the desk default is back in charge");
});

test("the settings page renders the library rather than a hardcoded desk list", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  for (const id of [
    "promptPicker",
    "promptTitle",
    "promptDesk",
    "reportPromptText",
    "usePromptBtn",
    "newPromptBtn",
    "duplicatePromptBtn",
    "deletePromptBtn",
    "resetReportPrompt",
    "saveReportPrompt",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  // The old fixed <option> list is what the library replaces.
  assert.doesNotMatch(html, /<option value="crypto">/);
  assert.doesNotMatch(html, /reportPromptSection/);
});
