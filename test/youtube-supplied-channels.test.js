"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { YOUTUBE_CHANNELS } = require("../src/config/youtube-channels");

const EXPECTED = {
  Tech: ["RoboNuggets", "theAIsearch", "JeffSu", "aiadvantage", "beardfm", "nateherk"],
  Crypto: [
    "morecryptoonline", "MindMathMoney", "OscarRamos", "AnthonyPompliano",
    "DaytradeWarrior", "stockmoe", "stevenvanmetre5087", "cryptosrus",
    "fxmentorus", "mreflow", "tradersreality", "J_Bravo", "jordancamirand",
    "MyFinancialFriend", "FrankieCandles",
  ],
  Sales: ["AdrianMorrison"],
  Underworld: ["TheDiaryOfACEOClips", "mikewanders", "JasonAChannel"],
  War: [
    "CashJordan", "amtv", "MFN", "PrestonStewart", "MaxAfterburnerusa",
    "DannyHaiphongYT", "NYPrepper",
  ],
};

test("all 32 supplied YouTube channels are unique and keep their intended categories", () => {
  const byHandle = new Map(YOUTUBE_CHANNELS.map((channel) => [channel.handle.toLowerCase(), channel]));
  const supplied = Object.values(EXPECTED).flat();

  assert.equal(supplied.length, 32);
  assert.equal(new Set(supplied.map((handle) => handle.toLowerCase())).size, 32);

  for (const [category, handles] of Object.entries(EXPECTED)) {
    assert.equal(handles.length, { Tech: 6, Crypto: 15, Sales: 1, Underworld: 3, War: 7 }[category]);
    for (const handle of handles) {
      const channel = byHandle.get(handle.toLowerCase());
      assert.ok(channel, `@${handle} is seeded`);
      assert.equal(channel.category, category, `@${handle} is categorized as ${category}`);
    }
  }

  assert.equal(new Set(YOUTUBE_CHANNELS.map((channel) => channel.handle.toLowerCase())).size, YOUTUBE_CHANNELS.length);
});
