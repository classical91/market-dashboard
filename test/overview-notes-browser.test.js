"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");

const { OverviewNotesService } = require("../src/services/overview-notes");
const { createOverviewNotesRouter } = require("../src/routes/overview-notes");

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
const KEEP = /src="\/assets\/js\/overview-v2-notes\.js"/;

test("Overview v2 notes follow the owner across devices", {
  skip: !fs.existsSync(executablePath) && "Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const publicDir = path.join(__dirname, "..", "public");
  const service = new OverviewNotesService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-notes-browser-")), logger: { error() {} } });
  let signedIn = true;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/overview-notes", createOverviewNotesRouter({
    overviewNotesService: service,
    requireAdmin: (req, res, next) => (signedIn ? next() : res.status(401).json({ error: "Login required." })),
  }));
  // Real markup and styles with only the notes script.
  app.get("/", (req, res) => {
    const html = fs.readFileSync(path.join(publicDir, "overview-v2.html"), "utf8");
    res.type("html").send(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => (KEEP.test(tag) ? tag : "")));
  });
  app.use(express.static(publicDir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // Two browser contexts are two devices: separate localStorage.
  async function device(seed) {
    const context = await browser.newContext();
    if (seed) await context.addInitScript((value) => { if (!localStorage.getItem("overviewV2.notes.v1")) localStorage.setItem("overviewV2.notes.v1", value); }, seed);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(base);
    return page;
  }
  const status = (page) => page.textContent("#ov2-notes-status");
  const waitStatus = (page, re) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById("ov2-notes-status").textContent), re.source);

  // Phone: the first device's existing (pre-sync) notes become the server copy.
  const phone = await device("levels: 97.2k / 101k");
  await waitStatus(phone, /synced across devices/);
  assert.equal(service.get().folders[0].text, "levels: 97.2k / 101k");

  // Laptop with no notes of its own sees them on first load.
  const laptop = await device();
  await waitStatus(laptop, /synced across devices/);
  assert.equal(await laptop.inputValue("#ov2-notes-input"), "levels: 97.2k / 101k");

  // Typing on the laptop reaches the phone when it comes back to the tab.
  await laptop.fill("#ov2-notes-input", "levels: 97.2k / 101k\nplan: buy the retest");
  await waitStatus(laptop, /synced across devices/);
  await phone.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await phone.waitForFunction(() => document.getElementById("ov2-notes-input").value.includes("buy the retest"));

  // A new folder syncs too.
  await laptop.click(".ov2-notes-folder-add");
  await laptop.fill(".ov2-notes-folder-input", "ETH");
  await laptop.press(".ov2-notes-folder-input", "Enter");
  await laptop.fill("#ov2-notes-input", "ETH: wait for 3.4k");
  await waitStatus(laptop, /synced across devices/);
  await phone.reload();
  await waitStatus(phone, /synced across devices/);
  assert.deepEqual(await phone.locator(".ov2-notes-folder-name").allTextContents(), ["Home", "ETH"]);

  // Both edit Home before either syncs: neither edit is lost.
  await phone.evaluate(() => { localStorage.setItem("overviewV2.notesSync.v1", JSON.stringify({ revision: 0, dirty: true })); });
  await phone.reload(); // pretend the phone edited offline against an old revision
  await waitStatus(phone, /Merged|synced/);
  assert.equal(service.get().folders.length, 2, "same text on both sides merges to nothing new");

  await laptop.click('.ov2-notes-folder:has-text("Home")');
  await laptop.fill("#ov2-notes-input", "laptop rewrite");
  await waitStatus(laptop, /synced across devices/);
  // The phone went offline (sign-out) and edited Home there.
  signedIn = false;
  await phone.click('.ov2-notes-folder:has-text("Home")');
  await phone.fill("#ov2-notes-input", "phone rewrite");
  await waitStatus(phone, /sign in to sync/);
  assert.equal(await phone.inputValue("#ov2-notes-input"), "phone rewrite", "still saved on the device");
  signedIn = true;
  await phone.reload();
  await waitStatus(phone, /Merged with notes from another device/);
  assert.equal(await phone.inputValue("#ov2-notes-input"), "laptop rewrite");
  assert.deepEqual(await phone.locator(".ov2-notes-folder-name").allTextContents(), ["Home", "ETH", "Home (this device)"]);
  await phone.waitForFunction(() => !/syncing/.test(document.getElementById("ov2-notes-status").textContent));
  const stored = service.get().folders;
  assert.deepEqual(stored.map((f) => f.text), ["laptop rewrite", "ETH: wait for 3.4k", "phone rewrite"]);
  assert.match(await status(phone), /Merged/);

  // The laptop picks up the merged copy when it comes back to the tab.
  await laptop.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await laptop.waitForFunction(() => document.querySelectorAll(".ov2-notes-folder").length === 3);
});
