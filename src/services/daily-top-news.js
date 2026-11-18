"use strict";

/**
 * Daily Top 10 — one page that gathers the top stories for Economics, Stocks
 * and Crypto from what was already made that day. Nothing here generates,
 * spends or broadcasts: it only reads two existing stores.
 *
 *   - Phone briefings (what the iOS Shortcut pushed) come first: the phone is
 *     the newsroom.
 *   - Reporter Room generations (Run Now / Regenerate, or a newsroom cycle)
 *     are the backup when the phone sent nothing for that desk that day.
 *
 * Every run made that day is returned, newest first within each source, so
 * the page can switch between them; `runs[0]` is the one shown by default.
 * Each run's text is split into its numbered stories (at most ten).
 */

const { select } = require("../../public/assets/js/top-news-selection");

const DEFAULT_TIME_ZONE = "America/Vancouver";
const MAX_STORIES = 10;

const DESKS = [
  { key: "economics", label: "Economics", icon: "🏦", reporterSection: "economics" },
  // The Reporter Room's `markets` section is the Stocks desk.
  { key: "stocks", label: "Stocks", icon: "📈", reporterSection: "markets" },
  { key: "crypto", label: "Crypto", icon: "₿", reporterSection: "crypto" },
];

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" of an instant, in a time zone. */
function localDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const KEYCAPS = { "🔟": 10 };
for (let n = 0; n <= 9; n += 1) KEYCAPS[`${n}️⃣`] = n;

/**
 * Where a story starts: "**#3 US — Headline**", "#3 Headline", "### 3. Headline",
 * "**3. Headline**", "3) Headline" or "3️⃣ Headline". `marked` is true when the
 * number is bold, hashed or a heading, which is how the reporter prompts open a
 * story; a plain "3." line can also be a sub-point inside one.
 */
function storyStart(line) {
  let rest = line.trim();
  let marked = false;
  const heading = /^#{1,4}\s+/.exec(rest);
  if (heading) {
    marked = true;
    rest = rest.slice(heading[0].length);
  }
  const bold = /^(\*\*|__)\s*/.exec(rest);
  if (bold) {
    marked = true;
    rest = rest.slice(bold[0].length);
  }
  for (const [cap, number] of Object.entries(KEYCAPS)) {
    if (rest.startsWith(cap)) {
      const title = rest.slice(cap.length).replace(/^[\s.:)\-–—]+/, "");
      return title ? { number, title: cleanTitle(title), marked: true } : null;
    }
  }
  const match = /^(#)?(\d{1,2})(?:[.):]|\s*[-–—])?\s+(.+)$/.exec(rest);
  if (!match) return null;
  if (match[1]) marked = true;
  return { number: Number(match[2]), title: cleanTitle(match[3]), marked };
}

function cleanTitle(title) {
  return title.replace(/\s*(\*\*|__)\s*$/, "").replace(/^(\*\*|__)/, "").trim();
}

/**
 * Split a briefing into its numbered stories. Numbers must run 1, 2, 3… so a
 * numbered sub-point inside a story is not mistaken for the next story; when
 * any story number is bold, hashed or a heading, only those lines count.
 * Fewer than two stories means the text has no usable numbering, and the
 * caller shows it whole.
 */
function splitStories(text, max = MAX_STORIES) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const starts = lines.map(storyStart);
  const onlyMarked = starts.some((start) => start && start.marked && start.number === 1);

  const stories = [];
  const intro = [];
  let current = null;
  lines.forEach((line, index) => {
    const start = starts[index];
    const expected = stories.length + 1;
    if (start && start.number === expected && (!onlyMarked || start.marked) && stories.length < max) {
      current = { number: start.number, title: start.title, lines: [] };
      stories.push(current);
      return;
    }
    if (current) {
      // Past the last story we keep, extra numbered stories are dropped.
      if (start && start.number === expected && stories.length >= max) {
        current = null;
        return;
      }
      current.lines.push(line);
    } else if (!stories.length) {
      intro.push(line);
    }
  });

  if (stories.length < 2) return { intro: "", stories: [] };
  return {
    intro: intro.join("\n").trim(),
    stories: stories.map((story) => ({
      number: story.number,
      title: story.title,
      body: story.lines.join("\n").replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "").trim(),
    })),
  };
}

function toRun({ id, source, at, title, text, model = null }) {
  const { intro, stories } = splitStories(text);
  return { id, source, at, title: title || null, model, intro, stories, text };
}

/**
 * @param {object} options
 * @param {object} options.briefingStore   PhoneBriefingStore
 * @param {object} [options.reporterService] ReporterService (optional)
 * @param {string} [options.date]          "YYYY-MM-DD"; defaults to today
 * @param {string} [options.timeZone]      IANA zone the day is counted in
 * @param {Date}   [options.now]
 * @param {object} [options.runStore]      Top10RunStore. With it, the Top 10
 *   is built only from the day's recorded Run (see top10-runs.js) and is
 *   empty until Run was hit; without it, from the newest runs as before.
 */
function buildDailyTopNews({ briefingStore, reporterService, date, timeZone, runStore = null, now = new Date() } = {}) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const today = localDateKey(now, zone);
  const day = isDateKey(date) ? date : today;

  let generations = [];
  if (reporterService && typeof reporterService.listGenerations === "function") {
    try {
      generations = reporterService.listGenerations({ limit: 200 });
    } catch {
      generations = [];
    }
  }

  const desks = DESKS.map((desk) => {
    const phoneRuns = (briefingStore.history(desk.key, { withText: true }) || [])
      .filter((entry) => localDateKey(entry.receivedAt, zone) === day)
      .map((entry) => toRun({
        id: entry.id,
        source: "phone",
        at: entry.receivedAt,
        title: entry.title,
        text: entry.text,
      }));

    const reporterRuns = generations
      .filter((entry) => entry && entry.section === desk.reporterSection && entry.content)
      .filter((entry) => localDateKey(entry.generatedAt, zone) === day)
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
      .map((entry) => toRun({
        id: `reporter-${desk.reporterSection}-${new Date(entry.generatedAt).getTime()}`,
        source: "reporter",
        at: entry.generatedAt,
        text: entry.content,
        model: entry.model || null,
      }));

    const { reporterSection, ...publicDesk } = desk;
    return { ...publicDesk, runs: [...phoneRuns, ...reporterRuns] };
  });

  if (!runStore) return { date: day, today, timeZone: zone, desks, top10: select(desks) };
  const run = runStore.latest(day);
  const top10Run = run ? { id: run.id, createdAt: run.createdAt, runIds: run.runIds, runs: run.runs } : null;
  return { date: day, today, timeZone: zone, desks, top10Run, top10: top10Run ? select(desks, top10Run.runIds) : [] };
}

module.exports = {
  buildDailyTopNews,
  splitStories,
  localDateKey,
  isDateKey,
  isValidTimeZone,
  DAILY_TOP_NEWS_DESKS: DESKS.map(({ key, label, icon }) => ({ key, label, icon })),
  DEFAULT_TIME_ZONE,
};
