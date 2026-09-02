"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { BroadcastLedgerNotificationService } = require("../src/services/broadcast-ledger-notifications");

test("ledger notifications are delivered as plain text to the configured Telegram service", async () => {
  const calls = [];
  const service = new BroadcastLedgerNotificationService({
    telegramService: {
      configured: true,
      async postText(text, options) {
        calls.push({ text, options });
        return { posted: 1, failed: 0, destinations: [] };
      },
    },
  });

  const result = await service.notify("failed", {
    id: "rcpt_1",
    title: "Delivery test",
    newsType: "Markets",
    source: "shortcut",
  }, "Telegram rejected the broadcast");

  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.parseMode, "none");
  assert.match(calls[0].text, /Failed broadcast/);
  assert.match(calls[0].text, /rcpt_1/);
  assert.match(calls[0].text, /Telegram rejected/);
});

test("an unconfigured notification service safely skips delivery", async () => {
  const service = new BroadcastLedgerNotificationService({ telegramService: { configured: false } });
  assert.deepEqual(await service.notify("blocked", { id: "rcpt_2" }), {
    sent: false,
    reason: "not-configured",
  });
});
