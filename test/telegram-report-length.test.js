"use strict";

// A long desk brief used to be cut *after* it was turned into HTML, which
// could split a "<b>…</b>" pair. Telegram then refused the whole message:
// "can't parse entities: Can't find end tag corresponding to start tag \"b\"".
// The cut now happens on the raw text, between whole stories.

const test = require("node:test");
const assert = require("node:assert");

const { TelegramService } = require("../src/services/telegram");

const LEAD = "**The big picture:** Higher-for-longer U.S. rates keep the dollar bid.";

function story(n) {
  const filler = "Importers, commodity prices and every borrower tied to the dollar feel this first. ".repeat(2);
  return [
    `**#${n} 🏦 US — Dollar pins 19-month high as Fed hike bets harden (story ${n})**`,
    `- The fact: **Reuters** said the dollar held near a 19-month high. ${filler}`,
    `- Why it matters: ${filler}`,
    `- Next: Fed minutes next week · Tone: 🔴 restrictive`,
  ].join("\n");
}

function longBrief() {
  return [LEAD, "", ...Array.from({ length: 10 }, (_, i) => `${story(i + 1)}\n`)].join("\n");
}

function balanced(html) {
  const opens = (html.match(/<b>/g) || []).length;
  const closes = (html.match(/<\/b>/g) || []).length;
  return opens === closes;
}

async function send(text, options = {}) {
  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }), text: async () => "" };
  };
  try {
    const telegram = new TelegramService({ botToken: "123456:test-token", chatIds: ["-100123"], ...options });
    const result = await telegram.postReportSection({ newsType: "Economics", text, date: "Wednesday, November 18, 2026" });
    return { sent, result };
  } finally {
    global.fetch = originalFetch;
  }
}

test("an over-long brief is cut between whole stories with balanced tags", async () => {
  assert.ok(longBrief().length > 4096, "the fixture has to be longer than one message");
  const { sent, result } = await send(longBrief(), { dashboardUrl: "https://dash.example" });
  assert.equal(sent.length, 1);
  assert.equal(result.posted, 1);
  const text = sent[0].text;
  assert.ok(text.length <= 4096, `message is ${text.length} characters`);
  assert.ok(balanced(text), "every <b> is closed");
  assert.match(text, /<b>#1 🏦 US/);
  assert.doesNotMatch(text, /…$/, "nothing was cut mid-word");
  assert.match(text, /➕ The full brief is on the dashboard: https:\/\/dash\.example\/briefings\/economics$/);
  // The last story kept is complete: it ends with its own final bullet.
  assert.match(text, /- Next: Fed minutes next week · Tone: 🔴 restrictive\n\n➕/);
});

test("a brief that fits is sent whole, with no dashboard note", async () => {
  const short = [LEAD, "", story(1), "", story(2)].join("\n");
  const { sent } = await send(short);
  assert.doesNotMatch(sent[0].text, /full brief is on the dashboard/);
  assert.match(sent[0].text, /story 2/);
  assert.ok(balanced(sent[0].text));
});

test("without a dashboard URL the note still says where the rest is", async () => {
  const { sent } = await send(longBrief());
  assert.match(sent[0].text, /➕ The full brief is on the dashboard\.$/);
  assert.ok(balanced(sent[0].text));
});
