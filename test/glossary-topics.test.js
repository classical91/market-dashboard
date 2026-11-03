const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const glossary = require("../public/assets/js/indicators.js");
const TOPICS = require("../public/assets/js/glossary-topics.js");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("every glossary category has a written topic explainer", () => {
  for (const category of glossary.topicCategories()) {
    const topic = TOPICS[category];
    assert.ok(topic, `${category} has no topic explainer`);
    for (const field of ["summary", "intro", "why"]) {
      assert.ok(typeof topic[field] === "string" && topic[field].length > 20, `${category} needs a ${field}`);
    }
    assert.ok(Array.isArray(topic.sections) && topic.sections.length, `${category} needs sections`);
    assert.ok(Array.isArray(topic.takeaways) && topic.takeaways.length, `${category} needs takeaways`);
  }
  for (const category of Object.keys(TOPICS)) {
    assert.ok(glossary.CATEGORY_ORDER.includes(category), `topic ${category} is not a glossary category`);
  }
});

test("topic sections only name real concepts from their own category, once each", () => {
  const byId = new Map(glossary.ALL_GLOSSARY.map((e) => [e.id, e]));
  for (const [category, topic] of Object.entries(TOPICS)) {
    const seen = new Set();
    for (const section of topic.sections) {
      for (const id of section.ids) {
        assert.ok(byId.has(id), `${category} names unknown concept ${id}`);
        assert.strictEqual(byId.get(id).category, category, `${id} is not in ${category}`);
        assert.ok(!seen.has(id), `${id} appears twice in ${category}`);
        seen.add(id);
      }
    }
  }
});

test("topic pages show every concept in the category exactly once", () => {
  for (const category of glossary.topicCategories()) {
    const shown = glossary.topicSections(category).flatMap((s) => s.entries.map((e) => e.id));
    const expected = glossary.ALL_GLOSSARY.filter((e) => e.category === category).map((e) => e.id);
    assert.deepStrictEqual([...shown].sort(), [...expected].sort(), `${category} topic page is missing or repeating concepts`);
  }
  assert.strictEqual(glossary.orderedEntries().length, glossary.ALL_GLOSSARY.length);
});

test("concepts left out of a topic's sections still show under 'Also in this topic'", () => {
  const category = "Core Trading Vocabulary";
  const original = TOPICS[category].sections;
  try {
    TOPICS[category].sections = [{ title: "Only one", note: "", ids: ["bulls-bears"] }];
    const sections = glossary.topicSections(category);
    assert.deepStrictEqual(sections.map((s) => s.title), ["Only one", "Also in this topic"]);
    assert.strictEqual(sections[1].entries.length, glossary.ALL_GLOSSARY.filter((e) => e.category === category).length - 1);
  } finally {
    TOPICS[category].sections = original;
  }
});

test("topic ids round-trip and links point at the topic page", () => {
  for (const category of glossary.topicCategories()) {
    const id = glossary.topicId(category);
    assert.match(id, /^[a-z0-9-]+$/);
    assert.strictEqual(glossary.categoryForTopicId(id), category);
  }
  assert.strictEqual(glossary.topicHref("ICT / Smart Money Concepts"), "/topic.html?id=ict-smart-money-concepts");
  assert.strictEqual(glossary.categoryForTopicId("not-a-topic"), null);
});

test("glossary, concept and topic pages load the topic text before the glossary script", () => {
  for (const page of ["public/indicators.html", "public/concept.html", "public/topic.html"]) {
    const html = read(page);
    const topics = html.indexOf("/assets/js/glossary-topics.js");
    assert.ok(topics !== -1 && topics < html.indexOf("/assets/js/indicators.js"), `${page} must load glossary-topics.js first`);
  }
  const topicPage = read("public/topic.html");
  assert.ok(topicPage.indexOf("/assets/js/indicators.js") < topicPage.indexOf("/assets/js/topic.js"));
  assert.match(read("public/indicators.html"), /href="\/topic\.html"/);
  assert.match(read("public/assets/js/indicators.js"), /class="glossary-topic-link" href="/);
  assert.match(read("public/assets/js/concept.js"), /topicHref\(entry\.category\)/);
  assert.match(read("public/assets/js/sidebar.js"), /path === "\/topic\.html"/);
});
