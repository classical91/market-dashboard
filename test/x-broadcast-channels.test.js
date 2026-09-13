"use strict";

// Channel resolution and target selection for the X Intelligence broadcast
// button. The property that matters most here is that a channel id names a
// destination rather than a position or a label: the browser remembers the
// last ticked channels, so an id that moved would send the next post into a
// room nobody chose.

const test = require("node:test");
const assert = require("node:assert");

const {
  resolveBroadcastChannels,
  parseChannelsJson,
  selectTargets,
} = require("../src/services/x-broadcast-channels");

test("channels fall back to TELEGRAM_CHAT_IDS so an existing deploy needs no new config", () => {
  const channels = resolveBroadcastChannels({
    chatIds: ["-1001841650798:6297", "-1001941064823"],
  });

  assert.equal(channels.length, 2);
  assert.deepEqual(channels[0], {
    id: "tg--1001841650798-t6297",
    label: "Chat -1001841650798 · topic 6297",
    chatId: "-1001841650798",
    threadId: "6297",
  });
  assert.equal(channels[1].threadId, null, "a chat id with no topic targets the whole chat");
  assert.equal(channels[1].label, "Chat -1001941064823");
});

test("labelled channels replace the raw list, and a label is what changes — not the id", () => {
  const raw = '[{"label":"Market Desk","chatId":"-1001841650798","threadId":"6297"}]';
  const renamed = '[{"label":"Finance Room","chatId":"-1001841650798","threadId":"6297"}]';

  const first = resolveBroadcastChannels({ channelsJson: raw });
  const second = resolveBroadcastChannels({ channelsJson: renamed });

  assert.equal(first[0].label, "Market Desk");
  assert.equal(second[0].label, "Finance Room");
  assert.equal(
    first[0].id,
    second[0].id,
    "a remembered selection must survive a relabel rather than following the name onto another room",
  );
});

test("a reorder does not move a remembered tick onto a different room", () => {
  const a = resolveBroadcastChannels({ chatIds: ["-100111:5", "-100222:9"] });
  const b = resolveBroadcastChannels({ chatIds: ["-100222:9", "-100111:5"] });

  assert.deepEqual(a.map((channel) => channel.id).sort(), b.map((channel) => channel.id).sort());
  assert.notEqual(a[0].id, b[0].id, "the ids track the destination, not the slot");
});

test("the same destination listed twice is offered once", () => {
  const channels = resolveBroadcastChannels({
    channelsJson: '[{"label":"A","chatId":"-100111","threadId":"5"},{"label":"B","chatId":"-100111","threadId":"5"}]',
  });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].label, "A", "the first spelling of a destination wins");
});

test("a non-numeric topic is dropped rather than sent as message_thread_id", () => {
  const [channel] = resolveBroadcastChannels({
    channelsJson: '[{"label":"Bad topic","chatId":"-100111","threadId":"general"}]',
  });

  assert.equal(channel.threadId, null, "Telegram would reject it; the chat itself is still reachable");
  assert.equal(channel.id, "tg--100111");
});

test("unparseable JSON falls back rather than leaving the picker empty", () => {
  assert.equal(parseChannelsJson("not json"), null);
  assert.equal(parseChannelsJson('{"chatId":"-1"}'), null, "an object is not a channel list");

  const channels = resolveBroadcastChannels({ channelsJson: "not json", chatIds: ["-100111"] });
  assert.equal(channels.length, 1, "the configured chat list still yields a usable picker");
});

test("no configuration at all yields no channels rather than a guess", () => {
  assert.deepEqual(resolveBroadcastChannels({}), []);
});

test("selecting channels refuses an empty pick instead of treating it as all", () => {
  const channels = resolveBroadcastChannels({ chatIds: ["-100111:5", "-100222"] });

  const empty = selectTargets(channels, []);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /at least one channel/i);

  assert.equal(selectTargets(channels, undefined).ok, false, "a missing list is not a licence to send everywhere");
});

test("an unknown channel id fails the whole request rather than being skipped", () => {
  const channels = resolveBroadcastChannels({ chatIds: ["-100111:5"] });

  const result = selectTargets(channels, ["tg--100111-t5", "tg--999"]);

  assert.equal(result.ok, false, "asking for two rooms and reaching one silently is the failure to avoid");
  assert.match(result.reason, /tg--999/);
});

test("selected ids become Telegram targets, deduped, with topics preserved", () => {
  const channels = resolveBroadcastChannels({ chatIds: ["-100111:5", "-100222"] });

  const result = selectTargets(channels, ["tg--100111-t5", "tg--100222", "tg--100111-t5"]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, [
    { chatId: "-100111", threadId: "5" },
    { chatId: "-100222" },
  ]);
  assert.deepEqual(result.channels.map((channel) => channel.id), ["tg--100111-t5", "tg--100222"]);
});
