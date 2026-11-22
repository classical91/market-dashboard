"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueue, sanitize } = require("../public/assets/js/youtube-queue.js");

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

const video = (id, extra = {}) => ({ id, title: "Video " + id, channelLabel: "Desk", ...extra });

test("add appends, ignores duplicates and persists", () => {
  const storage = memoryStorage();
  const queue = createQueue({ storage });
  assert.equal(queue.add(video("aaa")), true);
  assert.equal(queue.add(video("bbb")), true);
  assert.equal(queue.add(video("aaa")), false);
  assert.deepEqual(queue.list().map((v) => v.id), ["aaa", "bbb"]);
  assert.deepEqual(JSON.parse(storage.data["yt:queue:v1"]).map((v) => v.id), ["aaa", "bbb"]);
  assert.deepEqual(createQueue({ storage }).list().map((v) => v.id), ["aaa", "bbb"]);
});

test("move, shift, remove and clear keep order and storage in step", () => {
  const storage = memoryStorage();
  const queue = createQueue({ storage });
  ["a1", "b2", "c3", "d4"].forEach((id) => queue.add(video(id)));
  assert.equal(queue.move("d4", 0), true);
  assert.equal(queue.move("a1", 99), true);
  assert.equal(queue.move("b2", 1), false, "no-op move reports false");
  assert.deepEqual(queue.list().map((v) => v.id), ["d4", "b2", "c3", "a1"]);
  assert.equal(queue.shift().id, "d4");
  assert.equal(queue.peek().id, "b2");
  assert.equal(queue.remove("c3"), true);
  assert.equal(queue.remove("c3"), false);
  assert.deepEqual(queue.list().map((v) => v.id), ["b2", "a1"]);
  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.shift(), null);
  assert.equal("yt:queue:v1" in storage.data, false, "an empty queue leaves no storage behind");
});

test("subscribers hear every change", () => {
  const queue = createQueue({ storage: memoryStorage() });
  const sizes = [];
  const stop = queue.subscribe((list) => sizes.push(list.length));
  queue.add(video("a1"));
  queue.add(video("b2"));
  queue.shift();
  stop();
  queue.clear();
  assert.deepEqual(sizes, [1, 2, 1]);
});

test("respects the limit", () => {
  const queue = createQueue({ storage: memoryStorage(), limit: 2 });
  assert.equal(queue.add(video("a1")), true);
  assert.equal(queue.add(video("b2")), true);
  assert.equal(queue.add(video("c3")), false);
});

test("stored entries are sanitized and corrupt storage starts empty", () => {
  const stored = [
    video("ok1", { url: "javascript:alert(1)", thumbnail: "javascript:x", state: "weird", extra: "dropped" }),
    { id: "bad id with spaces" },
    video("ok1"),
    null,
    video("ok2", { url: "https://youtu.be/ok2", state: "live" }),
  ];
  const queue = createQueue({ storage: memoryStorage({ "yt:queue:v1": JSON.stringify(stored) }) });
  const list = queue.list();
  assert.deepEqual(list.map((v) => v.id), ["ok1", "ok2"]);
  assert.equal(list[0].url, "");
  assert.equal(list[0].thumbnail, "");
  assert.equal(list[0].state, "video");
  assert.equal("extra" in list[0], false);
  assert.equal(list[1].state, "live");

  assert.equal(createQueue({ storage: memoryStorage({ "yt:queue:v1": "{not json" }) }).size(), 0);
  assert.equal(sanitize({ id: "" }), null);
});

test("works without storage and when storage throws", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  for (const storage of [null, throwing]) {
    const queue = createQueue({ storage });
    assert.equal(queue.add(video("a1")), true);
    assert.equal(queue.size(), 1);
  }
});
