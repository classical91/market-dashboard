const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { CATEGORIES, ANSWERS } = require("../public/assets/js/qa-data.js");
const glossary = require("../public/assets/js/indicators.js");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const allQuestions = CATEGORIES.flatMap((c) => c.questions);

test("catalogue holds 20 categories and 286 unique questions", () => {
  assert.strictEqual(CATEGORIES.length, 20);
  assert.strictEqual(allQuestions.length, 286);
  assert.strictEqual(new Set(allQuestions).size, allQuestions.length, "duplicate question text");
  assert.strictEqual(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length, "duplicate category id");
  const slug = (t) => t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  assert.strictEqual(new Set(allQuestions.map(slug)).size, allQuestions.length, "two questions share a deep-link id");
});

test("every listed question has an answer in the expected format", () => {
  const known = new Set(allQuestions);
  const glossaryIds = new Set(glossary.ALL_GLOSSARY.map((e) => e.id));
  for (const question of known) {
    assert.ok(Object.hasOwn(ANSWERS, question), `missing answer: ${question}`);
  }
  for (const [question, a] of Object.entries(ANSWERS)) {
    assert.ok(known.has(question), `answer for unlisted question: ${question}`);
    assert.ok(["Beginner", "Intermediate", "Advanced"].includes(a.level), `${question}: bad level`);
    for (const field of ["definition", "application", "limitation"]) {
      assert.ok(typeof a[field] === "string" && a[field].length > 30, `${question}: needs ${field}`);
    }
    for (const r of a.related || []) assert.ok(known.has(r), `${question}: related "${r}" is not in the catalogue`);
    for (const id of a.glossary || []) assert.ok(glossaryIds.has(id), `${question}: unknown glossary id ${id}`);
    for (const w of a.widgets || []) assert.ok(w.href.startsWith("/") && w.label, `${question}: widget needs a local href and label`);
    for (const source of a.sources || []) {
      assert.ok(new URL(source.href).protocol === "https:" && source.label, `${question}: source needs an HTTPS URL and label`);
    }
    if (a.table) {
      for (const row of a.table.rows) assert.strictEqual(row.length, a.table.head.length, `${question}: table row width`);
    }
  }
});

test("Q&A page is linked from the sidebar and served at its short URLs", () => {
  assert.match(read("public/assets/js/sidebar.js"), /href: "\/qa\.html"/);
  assert.match(read("src/app.js"), /\["\/qa", "\/knowledge-base"\]/);
  const html = read("public/qa.html");
  for (const id of ["qaSearch", "qaLevel", "qaCategories", "qaList", "qaDetail"]) {
    assert.ok(html.includes(`id="${id}"`), `qa.html missing #${id}`);
  }
});
