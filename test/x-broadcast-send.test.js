"use strict";

// How a captured X post is turned into a Telegram message, and how the send
// reports itself. The formatting rules exist because the body is somebody
// else's prose: it must not be reinterpreted as markup, and it must not be cut
// in a way that makes Telegram reject the whole message.

const test = require("node:test");
const assert = require("node:assert");

const { TelegramService, formatXPost } = require("../src/services/telegram");

function service() {
  return new TelegramService({ botToken: "123:abc", chatIds: [] });
}

// Records what would have gone to Telegram and answers as the API does.
function captureSends(outcomes = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const endpoint = String(url).split("/").pop();
    calls.push({ endpoint, body });
    const key = `${body.chat_id}:${body.message_thread_id || ""}`;
    if (outcomes[key] === "fail") {
      return { ok: false, status: 400, text: async () => '{"description":"chat not found"}' };
    }
    return { ok: true, status: 200, json: async () => ({ result: { message_id: 500 + calls.length } }) };
  };
  return calls;
}

const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

test("a post is escaped, not reinterpreted — its asterisks are the author's", () => {
  const message = formatXPost({
    handle: "@Barchart",
    text: "**AAPL** > 200 & <breaking>",
    url: "https://x.com/Barchart/status/1",
  });

  assert.match(message, /<b>@Barchart<\/b>/, "the heading is ours, so it stays markup");
  assert.ok(message.includes("**AAPL**"), "the author's asterisks are text, not a bold instruction");
  assert.ok(message.includes("&gt; 200 &amp; &lt;breaking&gt;"), "the body is escaped");
  assert.ok(message.endsWith("https://x.com/Barchart/status/1"), "the permalink closes the message");
});

test("a post with no text still carries its link, and an empty post formats to nothing", () => {
  assert.equal(formatXPost({ handle: "a", text: "", url: "https://x.com/a/1" }).includes("https://x.com/a/1"), true);
  assert.equal(formatXPost({}), "", "nothing to send is expressible, so the caller can refuse it");
});

test("a long post is cut to fit a photo caption, before escaping rather than after", () => {
  const message = formatXPost(
    { handle: "a", text: `${"&".repeat(400)} tail`, url: "https://x.com/a/1" },
    { maxLength: 1024 },
  );

  assert.ok(message.length <= 1024, `caption must fit Telegram's cap, got ${message.length}`);
  assert.ok(!/&(?!amp;|gt;|lt;)/.test(message), "no half-written entity survived the cut");
  assert.ok(message.includes("https://x.com/a/1"), "the link is never the part that gets cut");
});

test("broadcasting sends only to the chosen targets, with the topic set", async () => {
  const calls = captureSends();

  const result = await service().postXPost(
    { handle: "Barchart", text: "hello", url: "https://x.com/Barchart/status/1" },
    { targets: [{ chatId: "-100111", threadId: "5" }, { chatId: "-100222" }] },
  );

  assert.equal(calls.length, 2, "one send per chosen channel, and no others");
  assert.equal(calls[0].endpoint, "sendMessage");
  assert.equal(calls[0].body.chat_id, "-100111");
  assert.equal(calls[0].body.message_thread_id, 5);
  assert.equal(calls[1].body.message_thread_id, undefined, "a chat with no topic gets no thread id");
  assert.equal(result.posted, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.destinations.map((d) => d.status), ["posted", "posted"]);
});

test("a post with a picture goes as a photo, captioned with the message", async () => {
  const calls = captureSends();

  await service().postXPost(
    { handle: "a", text: "chart", url: "https://x.com/a/1", image: "https://pbs.twimg.com/x.jpg" },
    { targets: [{ chatId: "-100111" }] },
  );

  assert.equal(calls[0].endpoint, "sendPhoto");
  assert.equal(calls[0].body.photo, "https://pbs.twimg.com/x.jpg");
  assert.match(calls[0].body.caption, /chart/);
});

test("a partial delivery is a result to report, not an error to throw", async () => {
  captureSends({ "-100222:": "fail" });

  const result = await service().postXPost(
    { handle: "a", text: "hello", url: "https://x.com/a/1" },
    { targets: [{ chatId: "-100111" }, { chatId: "-100222" }] },
  );

  assert.equal(result.posted, 1);
  assert.equal(result.failed, 1);
  const failed = result.destinations.find((d) => d.status === "failed");
  assert.equal(failed.chatId, "-100222");
  assert.match(failed.error, /chat not found/, "the reason travels with the destination that failed");
});

test("reaching nowhere is an error, and it names the destinations it tried", async () => {
  captureSends({ "-100111:": "fail", "-100222:": "fail" });

  await assert.rejects(
    () => service().postXPost(
      { handle: "a", text: "hello", url: "https://x.com/a/1" },
      { targets: [{ chatId: "-100111" }, { chatId: "-100222" }] },
    ),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.destinations.length, 2);
      return true;
    },
  );
});

test("an empty target list is refused rather than widened to every configured chat", async () => {
  const calls = captureSends();
  const configured = new TelegramService({ botToken: "123:abc", chatIds: ["-100999"] });

  await assert.rejects(
    () => configured.postXPost({ handle: "a", text: "hello" }, { targets: [] }),
    /at least one channel/i,
  );
  await assert.rejects(
    () => configured.postXPost({ handle: "a", text: "hello" }, {}),
    /at least one channel/i,
  );
  assert.equal(calls.length, 0, "nothing may reach the configured chat list by default");
});

test("broadcasting needs a bot token, but not TELEGRAM_CHAT_IDS", async () => {
  const calls = captureSends();
  const withoutChatIds = new TelegramService({ botToken: "123:abc", chatIds: [] });

  assert.equal(withoutChatIds.configured, false, "the legacy gate is off — X_BROADCAST_CHANNELS may be the only config");
  await withoutChatIds.postXPost({ handle: "a", text: "hi" }, { targets: [{ chatId: "-100111" }] });
  assert.equal(calls.length, 1, "a labelled channel list is enough to send");

  const tokenless = new TelegramService({ botToken: "", chatIds: [] });
  await assert.rejects(
    () => tokenless.postXPost({ handle: "a", text: "hi" }, { targets: [{ chatId: "-100111" }] }),
    /bot token/i,
  );
});
